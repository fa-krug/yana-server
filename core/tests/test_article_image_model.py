"""Tests for the content-addressed ArticleImage model."""

from django.db.utils import IntegrityError

import pytest

from core.models import ArticleImage


@pytest.mark.django_db
class TestArticleImage:
    def test_content_hash_is_unique(self):
        """The unique constraint is what makes concurrent stores safe."""
        ArticleImage.objects.create(
            content_hash="a" * 64,
            file="article_images/2026/07/a.webp",
            content_type="image/webp",
            byte_size=10,
        )

        with pytest.raises(IntegrityError):
            ArticleImage.objects.create(
                content_hash="a" * 64,
                file="article_images/2026/07/b.webp",
                content_type="image/webp",
                byte_size=20,
            )

    def test_dimensions_are_optional(self):
        """Compression is skipped for small files, which yields no dimensions."""
        image = ArticleImage.objects.create(
            content_hash="b" * 64,
            file="article_images/2026/07/b.webp",
            content_type="image/gif",
            byte_size=42,
        )

        assert image.width is None
        assert image.height is None

    def test_newest_first_ordering(self):
        older = ArticleImage.objects.create(
            content_hash="c" * 64,
            file="article_images/2026/07/c.webp",
            content_type="image/webp",
            byte_size=1,
        )
        newer = ArticleImage.objects.create(
            content_hash="d" * 64,
            file="article_images/2026/07/d.webp",
            content_type="image/webp",
            byte_size=1,
        )

        assert list(ArticleImage.objects.all()) == [newer, older]

    def test_str_shows_the_short_hash_type_and_size(self):
        image = ArticleImage(content_hash="e" * 64, content_type="image/webp", byte_size=1234)

        assert str(image) == f"{'e' * 12} (image/webp, 1234 B)"
