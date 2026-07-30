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

from django.core.management.base import BaseCommand
from django.utils import timezone

from core.aggregators.services.image_store import find_image_refs
from core.models import Article, ArticleImage

DEFAULT_MIN_AGE_DAYS = 7
MISSING_FILE_REPORT_LIMIT = 20


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

        # Snapshot every row before acting on any of them. Deleting rows while
        # iterating the same queryset (even via .iterator()) walks the
        # -created_at index as rows leave it, which can skip not-yet-visited
        # rows in this pass (they would only be caught on a later run).
        images = list(ArticleImage.objects.all())

        to_delete = []
        missing_files = []
        skipped_as_referenced = 0

        for image in images:
            file_missing = not image.file or not image.file.storage.exists(image.file.name)
            is_candidate = image.content_hash not in referenced and image.created_at < cutoff

            if is_candidate:
                # The initial snapshot can go stale: store_image_bytes() dedups
                # onto an existing row without touching created_at, so a
                # django-q2 aggregation task can commit a new article
                # referencing this exact row between the snapshot above and
                # the delete below. Re-check live, immediately before acting,
                # so that race cannot leave a freshly written article with a
                # dangling reference.
                if Article.objects.filter(content__contains=image.content_hash).exists():
                    skipped_as_referenced += 1
                else:
                    to_delete.append(image)
                    continue

            # Reached only by rows this run keeps -- report missing files for
            # rows that are still there and still broken, not ones we are
            # about to (or would) delete anyway.
            if file_missing:
                missing_files.append(image.content_hash)

        deleted = 0
        freed_bytes = 0
        for image in to_delete:
            deleted += 1
            freed_bytes += image.byte_size
            if not dry_run:
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
