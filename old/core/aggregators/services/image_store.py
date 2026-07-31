"""
Content-addressed image storage.

Aggregators hand raw image bytes here; this module compresses them with the
existing pipeline, hashes the *compressed* output, and keeps exactly one
``ArticleImage`` row per distinct byte sequence. Article content then carries
``yana-img://<sha256>`` instead of an inlined base64 data URI.

Hashing the compressed output rather than the original is what makes
deduplication work: the same source image encountered twice compresses to the
same bytes (Pillow is deterministic for fixed settings), finds the existing row,
and stores nothing new.
"""

import hashlib
import logging
import re

from django.core.files.base import ContentFile
from django.db import IntegrityError, transaction
from django.db.models import QuerySet

from core.models import Article, ArticleBlock, ArticleImage

from .image_extraction.compression import compress_image
from .image_extraction.fetcher import NonImageResponse, fetch_image_outcome, fetch_single_image

logger = logging.getLogger(__name__)

# iOS's existing scheme -- the client's resolution path already understands it.
IMAGE_REF_SCHEME = "yana-img://"

#: Images whose decoded width *and* height are both at or below this many
#: pixels are treated as non-content -- tracking/counting beacons (VG Wort's
#: 1x1 GIF is the canonical example), not something a reader ever looks at.
#: 1 is deliberately conservative: it only catches the classic 1x1 case and
#: cannot false-positive on any legitimate small image this codebase actually
#: handles -- there is no minimum-size floor anywhere on the ingestion path
#: (favicons/feed logos go through `feed_logo.py`'s own `Feed.logo` storage,
#: never through this module, and `block_parser.py` has no width/height
#: filtering of its own), so nothing here relies on 2x2-or-larger images
#: being treated as decorative.
TRACKING_PIXEL_MAX_DIMENSION = 1

_IMAGE_REF_PATTERN = re.compile(rf"{IMAGE_REF_SCHEME}([0-9a-f]{{64}})")

_EXTENSIONS = {
    "image/webp": "webp",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/avif": "avif",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
}


class ImageHashCollisionError(RuntimeError):
    """Two different byte sequences hashed to the same SHA-256 digest."""


def build_image_ref(content_hash: str) -> str:
    """Return the ``yana-img://`` reference for a stored image."""
    return f"{IMAGE_REF_SCHEME}{content_hash}"


def find_image_refs(text: str) -> set[str]:
    """Return every content hash referenced by a blob of HTML."""
    if not text:
        return set()
    return set(_IMAGE_REF_PATTERN.findall(text))


def referenced_image_hashes(articles: QuerySet[Article] | None = None) -> set[str]:
    """
    Every image hash referenced by ``articles`` (default: every article).

    Blocks are the authority for an article that has any: their ``image_ref``
    and ``embed_thumbnail_ref`` columns are the reference, and ``image_ref`` is
    indexed, so this is an index read rather than a full-text scan of every
    article body. ``Article.content`` is scanned only as a fallback, for the
    articles that have no blocks at all (a failed conversion, or a body
    written before the backfill) -- their references live nowhere else. Once
    an article has a tree, its ``content`` is deliberately ignored: a hash
    left behind there by an earlier conversion is stale, not a reference.

    Shared by ``prune_orphaned_images`` (the reaper, scoped to every article)
    and ``ArticleAdmin.referenced_images`` (scoped to one), so the two cannot
    quietly drift apart on what "referenced" means -- which is exactly what
    happened before this function existed: admin scanned ``content``
    unconditionally and could show an image as referenced that the reaper was
    about to delete.
    """
    if articles is None:
        articles = Article.objects.all()

    referenced: set[str] = set()

    blocks = ArticleBlock.objects.filter(article__in=articles)
    for column in ("image_ref", "embed_thumbnail_ref"):
        values = (
            blocks.exclude(**{column: ""})
            .values_list(column, flat=True)
            .distinct()
            .iterator(chunk_size=200)
        )
        for value in values:
            referenced |= find_image_refs(value)

    contents = (
        articles.filter(blocks__isnull=True)
        .exclude(content="")
        .values_list("content", flat=True)
        .iterator(chunk_size=200)
    )
    for content in contents:
        referenced |= find_image_refs(content)

    return referenced


def store_image_bytes(
    image_bytes: bytes,
    content_type: str,
    *,
    is_header: bool = False,
    compress: bool = True,
) -> str | None:
    """
    Store image bytes and return their content hash.

    Args:
        image_bytes: Raw image data
        content_type: MIME type of ``image_bytes``
        is_header: Use the larger header dimensions during compression
        compress: Set False for payloads that are already compression output
            (the ``migrate_inline_images`` backfill). Re-compressing those would
            yield a different hash than a fresh aggregation of the same source
            image, which would defeat deduplication.

    Returns:
        The SHA-256 hex digest of the stored bytes, or None when there was
        nothing to store. Callers must treat None as "no image" and publish the
        article without it.

    Raises:
        ImageHashCollisionError: A row exists for this hash with a different
            byte size.
    """
    if not image_bytes:
        return None

    if compress:
        data, output_type, width, height = _compress_or_passthrough(
            image_bytes, content_type, is_header
        )
    else:
        data, output_type, width, height = image_bytes, content_type, None, None

    if _is_tracking_pixel(width, height):
        logger.debug(
            "[image_store] Skipping a %sx%s image as a tracking pixel, not content (%d B)",
            width,
            height,
            len(image_bytes),
        )
        return None

    content_hash = hashlib.sha256(data).hexdigest()

    existing = _existing_row(content_hash)
    if existing is not None:
        if existing.byte_size != len(data):
            raise ImageHashCollisionError(
                f"{content_hash} already stores {existing.byte_size} B, refusing to "
                f"overwrite it with {len(data)} B"
            )
        # A blank file name (however that happened) must never reach
        # storage.save(""), which raises SuspiciousFileOperation -- the old
        # code simply returned the hash in that case, so preserve that by
        # only attempting repair when there is a name to check and rewrite.
        file_name = existing.file.name if existing.file else ""
        if file_name and not existing.file.storage.exists(file_name):
            # A restored DB backup without media/, or a manually cleared
            # directory, leaves rows whose file is gone. Returning early here
            # (the old behavior) is self-perpetuating: every later encounter
            # finds the row and writes nothing, so the reference 404s forever
            # and the reaper's "missing file" report never leads to repair.
            # Rewrite the file in place instead, keeping the same hash.
            logger.warning(
                "[image_store] %s row exists but its file is missing on disk -- rewriting it",
                content_hash[:12],
            )
            saved_name = existing.file.storage.save(file_name, ContentFile(data))
            if saved_name != file_name:
                # Another writer recreated the file between our exists()
                # check and this save, so storage disambiguated with a
                # suffixed name instead of overwriting. That stray file is
                # referenced by no row and the reaper would never reclaim
                # it -- drop it and trust whatever now sits at the hash's
                # real, DB-recorded path.
                existing.file.storage.delete(saved_name)
        else:
            logger.debug("[image_store] %s already stored -- reusing it", content_hash[:12])
        return content_hash

    image = ArticleImage(
        content_hash=content_hash,
        content_type=output_type,
        width=width,
        height=height,
        byte_size=len(data),
    )
    filename = f"{content_hash}.{_EXTENSIONS.get(output_type, 'bin')}"
    image.file.save(filename, ContentFile(data), save=False)

    try:
        with transaction.atomic():
            image.save()
    except IntegrityError:
        # A concurrent run stored the same bytes first. Its row is just as good;
        # drop the duplicate file so it does not become an orphan on disk.
        logger.debug(
            "[image_store] %s was stored concurrently -- keeping the existing row",
            content_hash[:12],
        )
        image.file.delete(save=False)

    return content_hash


def store_image_from_url(url: str, *, is_header: bool = False) -> str | None:
    """Fetch an image and store it. Returns its content hash, or None."""
    fetched = fetch_single_image(url)
    if not fetched:
        logger.info("[image_store] Could not fetch %s -- no image stored", url)
        return None

    return store_image_bytes(fetched["imageData"], fetched["contentType"], is_header=is_header)


def store_image_ref_from_url(url: str, *, is_header: bool = False) -> str | None:
    """Fetch and store an image, returning its ``yana-img://`` reference."""
    content_hash = store_image_from_url(url, is_header=is_header)
    return build_image_ref(content_hash) if content_hash else None


class NonContentImage:
    """Sentinel: a body image is definitively not something that should be
    stored or referenced, for one of two reasons:

    - it was fetched and decoded successfully, then rejected because it is a
      tracking pixel (see ``TRACKING_PIXEL_MAX_DIMENSION``); or
    - the fetch itself came back with a conclusive "this is not an image"
      answer -- a non-image ``Content-Type``, an empty/too-small body, or
      bytes Pillow cannot decode at all (``NonImageResponse``, from
      ``image_extraction.fetcher.fetch_image_outcome`` -- the VG Wort
      tracking-pixel URL that resolves, after a redirect, to a zero-length
      ``text/html`` response is exactly this shape: never an image, and
      retrying will not change that).

    Distinct from plain ``None``, which every other rejection in this module
    still returns (a transient network/DNS error, a timeout, an HTTP error
    status, or an explicit empty-bytes call) -- a caller cannot tell
    "nothing usable *yet*" from "confirmed, permanently, not content" through
    ``None`` alone, and the two need different treatment: a transient
    failure should keep pointing at the original remote URL (it might
    resolve on a later attempt), while either non-content case should not be
    referenced anywhere at all.

    Falsy, so every *existing* caller of ``store_image_bytes`` /
    ``store_image_from_url`` / ``store_image_ref_from_url`` -- all of which
    only ever check truthiness -- keeps seeing the same "no image" outcome
    it always has and needs no changes. Only ``store_body_image_ref_from_url``
    hands the un-collapsed sentinel to a caller that asked for it.
    """

    def __bool__(self) -> bool:
        return False

    def __repr__(self) -> str:
        return "NON_CONTENT_IMAGE"


NON_CONTENT_IMAGE = NonContentImage()


def store_body_image_ref_from_url(url: str) -> str | NonContentImage | None:
    """Fetch and store a body image, keeping "rejected as non-content"
    distinguishable from a merely transient fetch failure.

    Two independent checks feed the same ``NonContentImage`` signal:

    - ``fetch_image_outcome`` returning ``NonImageResponse``: the fetch
      completed and gave a definitive answer that the resource is not a
      usable image (wrong content-type, empty/too-small body, or undecodable
      bytes) -- as opposed to plain ``None``, which it reserves for a
      transient failure (network/DNS error, timeout, HTTP error status) that
      might succeed on a later attempt.
    - ``store_image_bytes`` returning ``None``: given real, decodable,
      correctly-typed bytes (i.e. we got past the check above), its only
      rejection reason is the tracking-pixel dimension check -- a fetch
      failure never reaches it at all, since it is only called once a fetch
      has already succeeded.

    Neither check touches ``fetch_single_image``'s or ``store_image_bytes``'s
    own public contract, which every other caller (header images, all of
    which only check truthiness) still relies on unchanged.

    Used solely by ``core.blocks.conversion``'s body-image localization
    pass, which drops the block entirely for a ``NonContentImage`` and keeps
    the original remote ref for a plain ``None``.
    """
    fetched = fetch_image_outcome(url)
    if isinstance(fetched, NonImageResponse):
        logger.info("[image_store] %s is not a usable image -- no block stored", url)
        return NON_CONTENT_IMAGE
    if not fetched:
        logger.info("[image_store] Could not fetch %s -- no image stored", url)
        return None

    content_hash = store_image_bytes(fetched["imageData"], fetched["contentType"])
    if content_hash is None:
        return NON_CONTENT_IMAGE

    return build_image_ref(content_hash)


def _is_tracking_pixel(width: int | None, height: int | None) -> bool:
    """True when decoded dimensions mark an image as a non-content beacon.

    ``None`` dimensions (compression failed to decode the image at all, e.g.
    SVG bytes Pillow can't rasterize) are never treated as a tracking pixel --
    "unknown size" must fail open to "store it", not open the door to
    silently dropping images we simply couldn't measure.
    """
    return (
        width is not None
        and height is not None
        and width <= TRACKING_PIXEL_MAX_DIMENSION
        and height <= TRACKING_PIXEL_MAX_DIMENSION
    )


def _existing_row(content_hash: str) -> ArticleImage | None:
    """Return the stored row for a hash, if any (patched in tests)."""
    return ArticleImage.objects.filter(content_hash=content_hash).first()


def _compress_or_passthrough(
    image_bytes: bytes, content_type: str, is_header: bool
) -> tuple[bytes, str, int | None, int | None]:
    """Compress, or fall back to the original bytes when compression fails."""
    result = compress_image(image_bytes, content_type, is_header=is_header)
    if not result:
        logger.warning(
            "[image_store] Compression failed for a %s image (%d B) -- storing the original bytes",
            content_type,
            len(image_bytes),
        )
        return image_bytes, content_type, None, None

    return result["data"], result["contentType"], result["width"], result["height"]
