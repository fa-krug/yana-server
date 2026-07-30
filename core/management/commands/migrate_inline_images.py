"""
Backfill: convert inline base64 data URIs in article content to stored images.

Walks ``Article.content``, decodes each ``data:image/...;base64,...`` payload,
stores it in the content-addressed image store, and replaces the URI with
``yana-img://<hash>``. Only ``content`` is rewritten -- ``raw_content`` is the
untouched source HTML, and any data URI in it came from the publisher.

The decoded bytes are stored verbatim (``compress=False``). For the five
header-image sites this is exactly right: the inlined payload is already
compression output, and re-compressing it would produce a different hash than
a fresh aggregation of the same source image, creating a duplicate row.

Oglaf is the one exception: before this work, ``oglaf/aggregator.py`` base64'd
the *raw fetched bytes* without compressing them (see
``git show 7c94619:core/aggregators/oglaf/aggregator.py``). So a historical
Oglaf payload backfills into one uncompressed ``ArticleImage`` row -- still
correctly referenced by its own article, just larger than it needs to be and
unable to dedup against a fresh Oglaf aggregation, which now compresses before
storing. Re-compressing here to fix that would break hash agreement for every
other source, so it is left as-is; it is a one-time, self-contained cost.

Batched and idempotent -- it runs over the whole article table and must be safe
to interrupt and resume. Each batch commits on its own; a partial run leaves
converted articles converted and the rest untouched.

Usage:
    python manage.py migrate_inline_images --dry-run
    python manage.py migrate_inline_images --limit 100
    python manage.py migrate_inline_images
"""

import base64
import binascii
import hashlib
import logging
import re

from django.core.management.base import BaseCommand
from django.db import transaction

from core.aggregators.services.image_store import build_image_ref, store_image_bytes
from core.models import Article

logger = logging.getLogger(__name__)

DATA_URI_PATTERN = re.compile(r"data:(image/[\w.+-]+);base64,([A-Za-z0-9+/=]+)")
DEFAULT_BATCH_SIZE = 200


class Command(BaseCommand):
    help = "Convert inline base64 images in article content to stored ArticleImage rows"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would change without writing anything",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=None,
            help="Process at most this many articles (for a trial run)",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=DEFAULT_BATCH_SIZE,
            help=f"Articles per transaction (default: {DEFAULT_BATCH_SIZE})",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        limit = options["limit"]
        batch_size = max(1, options["batch_size"])

        pending = (
            Article.objects.filter(content__contains="data:image")
            .only("id", "content")
            .order_by("pk")
        )

        converted_articles = 0
        # Distinct content hashes across the whole run, not a count of data-URI
        # references -- the same image inlined in two articles stores one row,
        # and the report should say so.
        stored_hashes: set[str] = set()
        skipped_articles = 0
        bytes_saved = 0
        processed = 0

        for batch in self._batches(pending, batch_size, limit):
            with transaction.atomic():
                for article in batch:
                    processed += 1
                    result = self._convert(article.content, dry_run=dry_run)

                    if result is None:
                        skipped_articles += 1
                        logger.warning(
                            "Article %s: undecodable base64 payload -- leaving its "
                            "content untouched",
                            article.id,
                        )
                        continue

                    new_content, hashes = result
                    if not hashes:
                        continue

                    converted_articles += 1
                    stored_hashes |= hashes
                    bytes_saved += len(article.content) - len(new_content)

                    if not dry_run:
                        article.content = new_content
                        article.save(update_fields=["content"])

        verb = "would convert" if dry_run else "converted"
        savings_verb = "would save" if dry_run else "saved"
        self.stdout.write(
            f"{verb} {converted_articles} articles ({len(stored_hashes)} images), "
            f"{savings_verb} {bytes_saved} bytes of content"
        )
        if skipped_articles:
            self.stdout.write(
                self.style.WARNING(
                    f"skipped {skipped_articles} articles with undecodable payloads "
                    "(see the log for their IDs)"
                )
            )
        self.stdout.write(self.style.SUCCESS(f"scanned {processed} articles containing data URIs"))

    def _batches(self, queryset, batch_size: int, limit: int | None):
        """Yield lists of articles, honoring --limit, re-querying per batch."""
        remaining = limit
        last_pk = 0

        while remaining is None or remaining > 0:
            size = batch_size if remaining is None else min(batch_size, remaining)
            batch = list(queryset.filter(pk__gt=last_pk)[:size])
            if not batch:
                return

            yield batch

            last_pk = batch[-1].pk
            if remaining is not None:
                remaining -= len(batch)

    @staticmethod
    def _convert(content: str, *, dry_run: bool) -> tuple[str, set[str]] | None:
        """
        Replace every data URI in content with a stored-image reference.

        Returns the new content and the set of distinct content hashes it now
        references, or None when any payload could not be decoded (in which
        case the whole article is left alone -- a half-rewritten body is worse
        than an unconverted one).
        """
        matches = list(DATA_URI_PATTERN.finditer(content))
        if not matches:
            return content, set()

        replacements = []
        for match in matches:
            content_type, payload = match.group(1), match.group(2)
            try:
                decoded = base64.b64decode(payload, validate=True)
            except (binascii.Error, ValueError):
                return None

            content_hash: str | None
            if dry_run:
                # Hash without storing so the reported savings are real.
                content_hash = hashlib.sha256(decoded).hexdigest()
            else:
                content_hash = store_image_bytes(decoded, content_type, compress=False)

            if not content_hash:
                return None

            replacements.append((match.span(), build_image_ref(content_hash), content_hash))

        new_content = content
        for (start, end), ref, _ in reversed(replacements):
            new_content = new_content[:start] + ref + new_content[end:]

        return new_content, {content_hash for _, _, content_hash in replacements}
