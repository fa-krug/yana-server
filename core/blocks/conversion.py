"""
The single article -> blocks conversion entry point.

Runs at save time, once, in every article-persisting path -- aggregation, the
`test_aggregator` command, article reload, the admin re-convert action and the
backfill command all come through here, so there is exactly one place that
decides what a stored body looks like.

It never raises for a bad body. An unparseable article is stored with zero
blocks and a warning naming its id: an article with no body beats a failed
aggregation run.
"""

import logging

from django.db import transaction

from core.aggregators.services.image_store import (
    IMAGE_REF_SCHEME,
    NonContentImage,
    store_body_image_ref_from_url,
)
from core.aggregators.utils.block_parser import blocks_from_html, plain_text
from core.blocks.types import Block, Blockquote, ImageBlock, ListBlock
from core.models import Article

from .storage import write_blocks

logger = logging.getLogger(__name__)

#: Ref prefixes `_localize_body_images` will actually try to fetch. Anything
#: else -- `yana-img://` (already localized), `data:`, an empty ref, or
#: whatever else a body might carry -- is left exactly as it is, no network
#: call attempted.
_FETCHABLE_SCHEMES = ("http://", "https://")


def convert_article(article: Article) -> int:
    """
    Convert ``article.content`` to blocks, store them and refresh
    ``article.plain_text``. Returns the number of block rows written.
    """
    try:
        blocks = blocks_from_html(article.content or "", base_url=article.identifier or "")
    except Exception:
        logger.warning(
            "Block conversion failed for article %s; storing no blocks", article.pk, exc_info=True
        )
        blocks = []

    _localize_body_images(blocks)

    with transaction.atomic():
        written = write_blocks(article, blocks)
        article.plain_text = plain_text(blocks)
        article.save(update_fields=["plain_text", "updated_at"])
    return written


def _localize_body_images(blocks: list[Block]) -> None:
    """
    Download every remote ``ImageBlock`` ref in ``blocks`` and either replace
    it with its ``yana-img://<hash>`` ref or drop the block, in place -- the
    body-image counterpart of the header path's own call to the same store
    (see ``BaseAggregator.extract_header_element`` /
    ``core.aggregators.services.image_store``). Recurses into ``ListBlock``
    items and ``Blockquote`` contents, the only two kinds that nest further
    blocks (mirrors ``block_parser._drop_image_blocks``'s traversal).

    Idempotent: a ref already carrying ``IMAGE_REF_SCHEME`` is skipped before
    any other check, so a re-conversion of an already-localized article makes
    no network calls at all. Deduplicated: the same source URL appearing more
    than once in one article is fetched only once here; the store's own
    content-addressed storage additionally collapses identical *bytes* (even
    from different source URLs) to one ``ArticleImage`` row.

    Three outcomes, three different treatments:

    - Localized (a ``str`` ref): ``block.ref`` is rewritten to
      ``yana-img://<hash>``.
    - Rejected as non-content (``NonContentImage`` -- a tracking/counting
      pixel, see ``image_store.TRACKING_PIXEL_MAX_DIMENSION``): the block is
      removed from its containing list entirely. It was fetched and decoded
      successfully, so this is not a maybe-transient failure -- it is a
      confirmed answer that the "image" is not content, and leaving it in
      place would mean every future render fetches the same beacon straight
      from the tracker.
    - Any other failure (``None`` -- a bad response, a timeout, an
      unsupported format, or any exception the store surfaces): logged as a
      warning, the original remote ref is kept in place. We cannot tell a
      dead link from a transient one, so keeping the ref (and trying again on
      the next conversion) is the safer default -- one broken image must not
      fail the whole article's conversion or lose the rest of its body.

    Dropping a block never leaves a gap: each recursion level rebuilds its
    own list via ``items[:] = kept``, and ``write_blocks`` derives every
    position fresh from ``enumerate()`` over these lists at write time (after
    this pass has already run) -- there is no separately-tracked position to
    fall out of sync, at the root level or nested inside a list item /
    blockquote.

    Never raises: a failed download/store surfaces as ``None`` (see above) or
    as a caught exception, logged as a warning -- nothing here propagates up
    to fail the whole conversion.
    """
    cache: dict[str, str | NonContentImage | None] = {}

    def localized(remote_ref: str) -> str | NonContentImage | None:
        if remote_ref not in cache:
            try:
                cache[remote_ref] = store_body_image_ref_from_url(remote_ref)
            except Exception:
                logger.warning(
                    "Body image localization failed for %s; keeping the remote ref",
                    remote_ref,
                    exc_info=True,
                )
                cache[remote_ref] = None
        return cache[remote_ref]

    def walk(items: list[Block]) -> None:
        kept: list[Block] = []
        for block in items:
            if isinstance(block, ImageBlock):
                ref = block.ref
                if (
                    not ref
                    or ref.startswith(IMAGE_REF_SCHEME)
                    or not ref.startswith(_FETCHABLE_SCHEMES)
                ):
                    kept.append(block)
                    continue
                result = localized(ref)
                if isinstance(result, NonContentImage):
                    continue  # not content -- drop the block, not just the ref
                if result:
                    block.ref = result
                kept.append(block)
            elif isinstance(block, ListBlock):
                for item in block.items:
                    walk(item)
                kept.append(block)
            elif isinstance(block, Blockquote):
                walk(block.blocks)
                kept.append(block)
            else:
                kept.append(block)
        items[:] = kept

    walk(blocks)
