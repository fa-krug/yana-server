"""Tests for the orphaned-image reaper."""

import os
from datetime import timedelta
from io import StringIO

from django.core.files.base import ContentFile
from django.core.management import call_command
from django.utils import timezone

import pytest

from core.models import Article, ArticleImage


@pytest.fixture(autouse=True)
def isolated_media_root(settings, tmp_path):
    settings.MEDIA_ROOT = str(tmp_path / "media")
    return tmp_path / "media"


def make_image(content_hash: str, *, age_days: int = 30) -> ArticleImage:
    image = ArticleImage(
        content_hash=content_hash,
        content_type="image/webp",
        byte_size=4,
    )
    image.file.save(f"{content_hash}.webp", ContentFile(b"data"), save=False)
    image.save()
    ArticleImage.objects.filter(pk=image.pk).update(
        created_at=timezone.now() - timedelta(days=age_days)
    )
    image.refresh_from_db()
    return image


def run(**kwargs) -> str:
    out = StringIO()
    call_command("prune_orphaned_images", stdout=out, **kwargs)
    return out.getvalue()


@pytest.mark.django_db
class TestPruning:
    def test_an_unreferenced_image_is_deleted_with_its_file(self):
        image = make_image("a" * 64)
        file_path = image.file.path

        run()

        assert ArticleImage.objects.count() == 0
        assert not os.path.exists(file_path)

    def test_a_referenced_image_is_kept(self, rss_feed):
        image = make_image("b" * 64)
        Article.objects.create(
            name="Referencing",
            identifier="https://example.com/ref",
            raw_content="",
            content=f'<img src="yana-img://{image.content_hash}">',
            feed=rss_feed,
        )

        run()

        assert ArticleImage.objects.filter(pk=image.pk).exists()

    def test_an_image_younger_than_min_age_is_kept(self):
        """An image stored moments before its article must not be collected."""
        image = make_image("c" * 64, age_days=0)

        run()

        assert ArticleImage.objects.filter(pk=image.pk).exists()

    def test_min_age_is_configurable(self):
        image = make_image("d" * 64, age_days=3)

        run(min_age=1)

        assert not ArticleImage.objects.filter(pk=image.pk).exists()

    def test_dry_run_deletes_nothing(self):
        image = make_image("e" * 64)

        output = run(dry_run=True)

        assert ArticleImage.objects.filter(pk=image.pk).exists()
        assert "would delete 1" in output

    def test_a_row_whose_file_is_missing_is_reported(self, rss_feed):
        image = make_image("f" * 64)
        Article.objects.create(
            name="Referencing",
            identifier="https://example.com/ref",
            raw_content="",
            content=f'<img src="yana-img://{image.content_hash}">',
            feed=rss_feed,
        )
        image.file.storage.delete(image.file.name)

        output = run()

        assert "missing file" in output
        assert image.content_hash[:12] in output
        assert ArticleImage.objects.filter(pk=image.pk).exists()

    def test_a_fresh_database_reports_zero_orphans(self):
        output = run(dry_run=True)

        assert "would delete 0" in output
