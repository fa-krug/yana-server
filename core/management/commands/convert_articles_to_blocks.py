"""
Backfill: convert existing ``Article.content`` HTML into stored block trees.

ORDERING: run this **after** ``migrate_inline_images``. That command rewrites
inline base64-encoded ``data:image`` payloads into ``yana-img://<hash>``
references; converting first would embed a whole data URI into
``ArticleBlock.image_ref``. Articles whose content still holds a data URI are
reported and skipped rather than silently mangled.

Batched, idempotent and resumable: articles that already have blocks are skipped
(use ``--force`` to rebuild them anyway), each article converts on its own, and a
parse failure logs the article id and moves on instead of aborting the run.

Usage:
    python manage.py convert_articles_to_blocks --dry-run
    python manage.py convert_articles_to_blocks --limit 100
    python manage.py convert_articles_to_blocks
    python manage.py convert_articles_to_blocks --force
"""

import logging
from collections import Counter

from django.core.management.base import BaseCommand

from core.aggregators.utils.block_parser import blocks_from_html
from core.blocks.conversion import convert_article
from core.models import Article

logger = logging.getLogger(__name__)

DEFAULT_BATCH_SIZE = 200
DATA_URI_MARKER = "data:image"
REPORT_LIMIT = 20


class Command(BaseCommand):
    help = (
        "Convert Article.content HTML into ArticleBlock trees. Run AFTER "
        "migrate_inline_images, so bodies carry yana-img:// references rather "
        "than inline base64 data URIs."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be converted without writing anything",
        )
        parser.add_argument(
            "--limit", type=int, default=0, help="Convert at most this many articles"
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=DEFAULT_BATCH_SIZE,
            help=f"Articles fetched per batch (default: {DEFAULT_BATCH_SIZE})",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="Re-convert articles that already have blocks (use after a parser change)",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        limit = options["limit"]
        force = options["force"]
        batch_size = options["batch_size"]

        queryset = Article.objects.exclude(content="").order_by("pk")
        if not force:
            # LEFT JOIN filter on the reverse `blocks` FK -- fine as the only
            # join here, but a future edit adding another join would need
            # .distinct() to avoid duplicate rows.
            queryset = queryset.filter(blocks__isnull=True)

        converted = 0
        failed: list[int] = []
        skipped_data_uri: list[int] = []
        distribution: Counter[int] = Counter()

        for article in queryset.iterator(chunk_size=batch_size):
            if limit and converted >= limit:
                break

            if DATA_URI_MARKER in article.content:
                skipped_data_uri.append(article.pk)
                continue

            if dry_run:
                try:
                    count = len(
                        blocks_from_html(article.content, base_url=article.identifier or "")
                    )
                except Exception:
                    logger.warning("Parse failed for article %s", article.pk, exc_info=True)
                    failed.append(article.pk)
                    continue
            else:
                try:
                    count = convert_article(article)
                except Exception:
                    logger.warning("Conversion failed for article %s", article.pk, exc_info=True)
                    failed.append(article.pk)
                    continue

            distribution[count] += 1
            converted += 1

        verb = "would convert" if dry_run else "converted"
        self.stdout.write(self.style.SUCCESS(f"{verb} {converted} article(s)"))

        if distribution:
            summary = ", ".join(
                f"{blocks} block(s): {count} article(s)"
                for blocks, count in sorted(distribution.items())
            )
            self.stdout.write(f"Block-count distribution -- {summary}")

        if skipped_data_uri:
            shown = ", ".join(str(pk) for pk in skipped_data_uri[:REPORT_LIMIT])
            suffix = "" if len(skipped_data_uri) <= REPORT_LIMIT else ", ..."
            self.stdout.write(
                self.style.WARNING(
                    f"{len(skipped_data_uri)} article(s) skipped: content still holds an inline "
                    f"data URI -- run migrate_inline_images first. IDs: {shown}{suffix}"
                )
            )

        if failed:
            shown = ", ".join(str(pk) for pk in failed[:REPORT_LIMIT])
            suffix = "" if len(failed) <= REPORT_LIMIT else ", ..."
            self.stdout.write(
                self.style.WARNING(
                    f"{len(failed)} article(s) left blockless after a failure. IDs: {shown}{suffix}"
                )
            )
