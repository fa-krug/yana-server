"""
Delete ``ArticleImage`` rows that no article references any more.

Content-addressed storage needs a reaper: an image whose referencing articles
are all gone is dead weight on disk and in the database.

EFFICIENCY CAVEAT (temporary): until Spec 5 lands, finding references means
scanning every ``Article.content`` for ``yana-img://`` hashes, because the only
place a reference exists is that text. That is acceptable for a periodic
maintenance command and unacceptable for anything hot. Once
``ArticleBlock.image_ref`` exists and is indexed, this becomes a JOIN and this
command should be rewritten accordingly.

The command also reports rows whose file is gone from disk (manual deletion,
failed storage) -- the serving layer would 404 on those.

Usage:
    python manage.py prune_orphaned_images --dry-run
    python manage.py prune_orphaned_images --min-age 30
    python manage.py prune_orphaned_images
"""

from datetime import timedelta

from django.core.files.storage import default_storage
from django.core.management.base import BaseCommand
from django.utils import timezone

from core.aggregators.services.image_store import find_image_refs
from core.models import Article, ArticleImage

DEFAULT_MIN_AGE_DAYS = 7
MISSING_FILE_REPORT_LIMIT = 20
SCAN_CHUNK_SIZE = 200
DELETE_CHUNK_SIZE = 200


class Command(BaseCommand):
    help = "Delete ArticleImage rows and files that no article content references"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be deleted without deleting anything",
        )
        parser.add_argument(
            "--min-age",
            type=int,
            default=DEFAULT_MIN_AGE_DAYS,
            help=(
                "Only prune images older than this many days, so an image stored "
                f"moments before its article is not collected (default: {DEFAULT_MIN_AGE_DAYS})"
            ),
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        cutoff = timezone.now() - timedelta(days=options["min_age"])

        referenced = self._referenced_hashes()
        self.stdout.write(f"{len(referenced)} image(s) referenced by article content")

        # Decide pass: a lightweight scalar snapshot, not full ArticleImage
        # instances -- a large table shouldn't need every row materialized as
        # a model object just to classify it. Keyed by content_hash, which is
        # unique, so it doubles as the pk for the rows we may delete.
        candidates: dict[str, tuple[int, int, bool]] = {}
        missing_files: list[str] = []

        rows = ArticleImage.objects.values_list(
            "pk", "content_hash", "created_at", "byte_size", "file"
        ).iterator(chunk_size=SCAN_CHUNK_SIZE)

        for pk, content_hash, created_at, byte_size, file_name in rows:
            file_missing = not file_name or not default_storage.exists(file_name)
            is_candidate = content_hash not in referenced and created_at < cutoff

            if is_candidate:
                candidates[content_hash] = (pk, byte_size, file_missing)
            elif file_missing:
                # Reached only by rows that were never candidates -- report
                # rows that are still there and still broken, not ones we are
                # about to (or would) delete anyway.
                missing_files.append(content_hash)

        # Re-snapshot referenced hashes immediately before the delete loop.
        # The first snapshot above can go stale: store_image_bytes() dedups
        # onto an existing row without touching created_at, so a django-q2
        # aggregation task can commit a new article referencing a candidate
        # between the snapshot above and the deletes below. Re-checking here
        # -- one more full pass over Article.content, not a per-candidate
        # query -- narrows that race window to the delete loop's duration and
        # keeps the cost at O(table size) regardless of orphan count. A
        # per-candidate `content__contains` query is unindexable and, at
        # scale, dominates the whole command: ~92ms per candidate measured on
        # a 100MB/5000-article table, i.e. minutes once a retention sweep
        # produces its usual few thousand orphans.
        fresh_referenced = self._referenced_hashes()

        to_delete: list[tuple[int, int]] = []  # (pk, byte_size)
        skipped_as_referenced = 0

        for content_hash, (pk, byte_size, file_missing) in candidates.items():
            if content_hash in fresh_referenced:
                skipped_as_referenced += 1
                # Reached only by rows this run keeps after all -- same
                # "report only what's kept" rule as above.
                if file_missing:
                    missing_files.append(content_hash)
                continue
            to_delete.append((pk, byte_size))

        deleted = len(to_delete)
        freed_bytes = sum(byte_size for _, byte_size in to_delete)

        if not dry_run:
            pks = [pk for pk, _ in to_delete]
            for start in range(0, len(pks), DELETE_CHUNK_SIZE):
                chunk = pks[start : start + DELETE_CHUNK_SIZE]
                for image in ArticleImage.objects.filter(pk__in=chunk):
                    image.file.delete(save=False)
                    image.delete()

        verb = "would delete" if dry_run else "deleted"
        self.stdout.write(
            self.style.SUCCESS(f"{verb} {deleted} orphaned image(s), {freed_bytes} bytes")
        )

        if skipped_as_referenced:
            self.stdout.write(
                self.style.WARNING(
                    f"{skipped_as_referenced} image(s) skipped: referenced by article "
                    "content written after this run's scan began"
                )
            )

        if missing_files:
            shown = ", ".join(h[:12] for h in missing_files[:MISSING_FILE_REPORT_LIMIT])
            suffix = "" if len(missing_files) <= MISSING_FILE_REPORT_LIMIT else ", ..."
            self.stdout.write(
                self.style.WARNING(
                    f"{len(missing_files)} row(s) with a missing file: {shown}{suffix}"
                )
            )

    @staticmethod
    def _referenced_hashes() -> set[str]:
        """Every hash referenced by any article's content."""
        referenced: set[str] = set()
        contents = (
            Article.objects.exclude(content="")
            .values_list("content", flat=True)
            .iterator(chunk_size=200)
        )
        for content in contents:
            referenced |= find_image_refs(content)
        return referenced
