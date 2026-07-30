"""Admin is the verification surface for hosted images this phase."""

from django.core.files.base import ContentFile
from django.urls import reverse

import pytest

from core.models import Article, ArticleImage


@pytest.fixture(autouse=True)
def isolated_media_root(settings, tmp_path):
    settings.MEDIA_ROOT = str(tmp_path / "media")
    return tmp_path / "media"


@pytest.fixture
def stored_image():
    image = ArticleImage(
        content_hash="ab" * 32,
        content_type="image/webp",
        width=800,
        height=600,
        byte_size=2048,
    )
    image.file.save(f"{'ab' * 32}.webp", ContentFile(b"payload"), save=False)
    image.save()
    return image


@pytest.fixture
def two_images_with_distinct_byte_sizes():
    """Two rows whose byte sizes sum to a value that appears nowhere else on the
    page, so the changelist total can only be right if it is genuinely summed
    rather than borrowed from a single row's own byte-size column."""
    first = ArticleImage(
        content_hash="aa" * 32,
        content_type="image/webp",
        width=101,
        height=102,
        byte_size=1300,
    )
    first.file.save(f"{'aa' * 32}.webp", ContentFile(b"first"), save=False)
    first.save()

    second = ArticleImage(
        content_hash="bb" * 32,
        content_type="image/png",
        width=103,
        height=104,
        byte_size=2500,
    )
    second.file.save(f"{'bb' * 32}.png", ContentFile(b"second"), save=False)
    second.save()

    return first, second


@pytest.fixture
def images_by_content_type():
    """Two ``image/webp`` rows and one ``image/png`` row. Byte sizes are chosen
    so the webp-only total (3300) differs from every individual byte size,
    every dimension, and the unfiltered total (13299)."""
    webp_one = ArticleImage(
        content_hash="cc" * 32,
        content_type="image/webp",
        width=201,
        height=202,
        byte_size=1100,
    )
    webp_one.file.save(f"{'cc' * 32}.webp", ContentFile(b"webp-one"), save=False)
    webp_one.save()

    webp_two = ArticleImage(
        content_hash="dd" * 32,
        content_type="image/webp",
        width=203,
        height=204,
        byte_size=2200,
    )
    webp_two.file.save(f"{'dd' * 32}.webp", ContentFile(b"webp-two"), save=False)
    webp_two.save()

    png_one = ArticleImage(
        content_hash="ee" * 32,
        content_type="image/png",
        width=205,
        height=206,
        byte_size=9999,
    )
    png_one.file.save(f"{'ee' * 32}.png", ContentFile(b"png-one"), save=False)
    png_one.save()

    return webp_one, webp_two, png_one


@pytest.mark.django_db
class TestArticleImageChangelist:
    def test_the_changelist_shows_the_image(self, admin_client, stored_image):
        response = admin_client.get(reverse("admin:core_articleimage_changelist"))

        assert response.status_code == 200
        content = response.content.decode()
        assert stored_image.content_hash[:12] in content
        assert "image/webp" in content
        assert "800" in content

    def test_the_changelist_totals_the_stored_bytes(
        self, admin_client, two_images_with_distinct_byte_sizes
    ):
        response = admin_client.get(reverse("admin:core_articleimage_changelist"))

        assert "3800" in response.content.decode()

    def test_the_changelist_total_reflects_the_active_filter(
        self, admin_client, images_by_content_type
    ):
        response = admin_client.get(
            reverse("admin:core_articleimage_changelist"),
            {"content_type": "image/webp"},
        )

        assert response.status_code == 200
        content = response.content.decode()
        assert "3300" in content
        assert "13299" not in content

    def test_hash_prefix_search_finds_the_row(self, admin_client, stored_image):
        response = admin_client.get(
            reverse("admin:core_articleimage_changelist"),
            {"q": stored_image.content_hash[:8]},
        )

        assert response.status_code == 200
        assert stored_image.content_hash[:12] in response.content.decode()

    def test_rows_cannot_be_added_by_hand(self, admin_client):
        """A hand-written content-addressed row makes the hash a lie."""
        response = admin_client.get(reverse("admin:core_articleimage_add"))

        assert response.status_code == 403

    def test_deletion_stays_available(self, admin_client, stored_image):
        response = admin_client.get(
            reverse("admin:core_articleimage_delete", args=[stored_image.pk])
        )

        assert response.status_code == 200


@pytest.mark.django_db
class TestArticleReferencedImages:
    def test_the_article_page_shows_its_referenced_images(
        self, admin_client, rss_feed, stored_image
    ):
        article = Article.objects.create(
            name="Referencing",
            identifier="https://example.com/ref",
            raw_content="",
            content=f'<img src="yana-img://{stored_image.content_hash}">',
            feed=rss_feed,
        )

        response = admin_client.get(reverse("admin:core_article_change", args=[article.pk]))

        assert response.status_code == 200
        assert stored_image.file.url in response.content.decode()

    def test_a_reference_with_no_stored_row_is_flagged(self, admin_client, rss_feed):
        article = Article.objects.create(
            name="Dangling",
            identifier="https://example.com/dangling",
            raw_content="",
            content=f'<img src="yana-img://{"cd" * 32}">',
            feed=rss_feed,
        )

        response = admin_client.get(reverse("admin:core_article_change", args=[article.pk]))

        assert "missing" in response.content.decode()

    def test_an_article_without_references_says_so(self, admin_client, article):
        response = admin_client.get(reverse("admin:core_article_change", args=[article.pk]))

        assert "No hosted images" in response.content.decode()
