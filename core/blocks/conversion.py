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

from core.aggregators.utils.block_parser import blocks_from_html, plain_text
from core.models import Article

from .storage import write_blocks

logger = logging.getLogger(__name__)


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

    with transaction.atomic():
        written = write_blocks(article, blocks)
        article.plain_text = plain_text(blocks)
        article.save(update_fields=["plain_text", "updated_at"])
    return written
