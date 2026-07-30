"""Tests for per-feed logo resolution and storage."""

import io
import os
from unittest.mock import patch

from django.db import OperationalError

import pytest
from PIL import Image

from core.aggregators.feed_logo import (
    LOGO_FETCH_TIMEOUT,
    resolve_feed_logo_url,
    store_feed_logo,
)
from core.aggregators.registry import AggregatorRegistry
from core.models import Feed


@pytest.mark.django_db
def test_feed_starts_without_a_logo(user):
    feed = Feed.objects.create(
        name="Heise", aggregator="heise", identifier="https://www.heise.de/rss/heise.rdf", user=user
    )

    assert not feed.logo
    assert feed.logo_source_url == ""


BRAND_SITES = {
    "heise": "https://www.heise.de/",
    "merkur": "https://www.merkur.de/",
    "tagesschau": "https://www.tagesschau.de/",
    "explosm": "https://explosm.net/",
    "dark_legacy": "https://darklegacycomics.com/",
    "caschys_blog": "https://stadt-bremerhaven.de/",
    "mactechnews": "https://www.mactechnews.de/",
    "oglaf": "https://www.oglaf.com/",
    "mein_mmo": "https://mein-mmo.de/",
}


@pytest.mark.parametrize(("aggregator_type", "brand_site"), sorted(BRAND_SITES.items()))
def test_brand_site_urls_match_the_client(aggregator_type, brand_site):
    assert AggregatorRegistry.get(aggregator_type).brand_site_url == brand_site


@pytest.mark.parametrize(
    "aggregator_type", ["full_website", "feed_content", "podcast", "reddit", "youtube"]
)
def test_aggregators_without_a_fixed_brand_have_no_brand_site(aggregator_type):
    assert AggregatorRegistry.get(aggregator_type).brand_site_url is None


@pytest.mark.django_db
def test_api_image_wins_over_brand_favicon(user_with_settings):
    feed = Feed.objects.create(
        name="Swift", aggregator="reddit", identifier="swift", user=user_with_settings
    )

    with (
        patch(
            "core.aggregators.reddit.aggregator.fetch_subreddit_info",
            return_value={"iconUrl": "https://styles.redditmedia.com/swift.png"},
        ),
        patch("core.aggregators.feed_logo.resolve_site_icon") as resolve_icon,
    ):
        assert resolve_feed_logo_url(feed) == "https://styles.redditmedia.com/swift.png"
    resolve_icon.assert_not_called()


@pytest.mark.django_db
def test_brand_favicon_wins_over_identifier_favicon(user):
    feed = Feed.objects.create(
        name="Heise", aggregator="heise", identifier="https://www.heise.de/rss/heise.rdf", user=user
    )

    with patch(
        "core.aggregators.feed_logo.resolve_site_icon",
        return_value="https://www.heise.de/favicon.ico",
    ) as resolve_icon:
        assert resolve_feed_logo_url(feed) == "https://www.heise.de/favicon.ico"
    resolve_icon.assert_called_once_with("https://www.heise.de/")


@pytest.mark.django_db
def test_url_feed_without_a_brand_uses_the_identifier_origin(user):
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )

    with patch(
        "core.aggregators.feed_logo.resolve_site_icon",
        return_value="https://golem.de/favicon.ico",
    ) as resolve_icon:
        assert resolve_feed_logo_url(feed) == "https://golem.de/favicon.ico"
    resolve_icon.assert_called_once_with("https://golem.de/")


@pytest.mark.django_db
def test_unparseable_identifier_resolves_to_none(user):
    feed = Feed.objects.create(
        name="Broken", aggregator="full_website", identifier="not a url", user=user
    )

    with patch("core.aggregators.feed_logo.resolve_site_icon") as resolve_icon:
        assert resolve_feed_logo_url(feed) is None
    resolve_icon.assert_not_called()


@pytest.mark.django_db
def test_api_image_failure_falls_through_to_the_identifier_origin(user_with_settings):
    feed = Feed.objects.create(
        name="Swift", aggregator="reddit", identifier="swift", user=user_with_settings
    )

    with (
        patch(
            "core.aggregators.reddit.aggregator.fetch_subreddit_info",
            side_effect=ValueError("rate limited"),
        ),
        patch("core.aggregators.feed_logo.resolve_site_icon") as resolve_icon,
    ):
        assert resolve_feed_logo_url(feed) is None
    resolve_icon.assert_not_called()


def _white_backed_png() -> bytes:
    image = Image.new("RGB", (16, 16), (255, 255, 255))
    for x in range(4, 12):
        for y in range(4, 12):
            image.putpixel((x, y), (10, 10, 10))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.mark.django_db
def test_store_feed_logo_downloads_and_records_the_source(user):
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )
    png = _white_backed_png()

    with (
        patch(
            "core.aggregators.feed_logo.resolve_feed_logo_url",
            return_value="https://golem.de/favicon.png",
        ),
        patch("core.aggregators.feed_logo.fetch_bytes", return_value=png) as fetch,
    ):
        assert store_feed_logo(feed) is True

    fetch.assert_called_once_with("https://golem.de/favicon.png", timeout=LOGO_FETCH_TIMEOUT)
    feed.refresh_from_db()
    assert feed.logo
    assert feed.logo_source_url == "https://golem.de/favicon.png"
    feed.logo.delete(save=False)


@pytest.mark.django_db
def test_store_feed_logo_strips_a_white_background(user):
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )

    with (
        patch(
            "core.aggregators.feed_logo.resolve_feed_logo_url",
            return_value="https://golem.de/favicon.png",
        ),
        patch("core.aggregators.feed_logo.fetch_bytes", return_value=_white_backed_png()),
    ):
        store_feed_logo(feed)

    feed.refresh_from_db()
    with feed.logo.open("rb") as stored:
        image = Image.open(io.BytesIO(stored.read())).convert("RGBA")
    assert image.getpixel((0, 0))[3] == 0
    feed.logo.delete(save=False)


@pytest.mark.django_db
def test_store_feed_logo_keeps_the_feed_saveable_when_the_download_fails(user):
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )

    with (
        patch(
            "core.aggregators.feed_logo.resolve_feed_logo_url",
            return_value="https://golem.de/favicon.png",
        ),
        patch("core.aggregators.feed_logo.fetch_bytes", side_effect=OSError("dead")),
    ):
        assert store_feed_logo(feed) is False

    feed.refresh_from_db()
    assert not feed.logo


@pytest.mark.django_db
def test_store_feed_logo_rejects_a_payload_that_is_not_an_image(user, settings, tmp_path):
    """A soft-404 HTML body served from /favicon.ico must not become the logo."""
    settings.MEDIA_ROOT = tmp_path
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )

    with (
        patch(
            "core.aggregators.feed_logo.resolve_feed_logo_url",
            return_value="https://golem.de/favicon.ico",
        ),
        patch(
            "core.aggregators.feed_logo.fetch_bytes",
            return_value=b"<!DOCTYPE html><html><body>Not found</body></html>",
        ),
    ):
        assert store_feed_logo(feed) is False

    feed.refresh_from_db()
    assert not feed.logo
    assert feed.logo_source_url == ""
    assert not any(tmp_path.rglob("feed-*"))


@pytest.mark.django_db
def test_store_feed_logo_is_a_noop_when_nothing_resolves(user):
    feed = Feed.objects.create(
        name="Broken", aggregator="full_website", identifier="not a url", user=user
    )

    with patch("core.aggregators.feed_logo.resolve_feed_logo_url", return_value=None):
        assert store_feed_logo(feed) is False

    assert not feed.logo


@pytest.mark.django_db
def test_store_feed_logo_replaces_the_previous_file(user, settings, tmp_path):
    """Storing a new logo must not orphan the file it replaces."""
    settings.MEDIA_ROOT = tmp_path
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )

    with (
        patch(
            "core.aggregators.feed_logo.resolve_feed_logo_url",
            return_value="https://golem.de/favicon.png",
        ),
        patch("core.aggregators.feed_logo.fetch_bytes", return_value=_white_backed_png()),
    ):
        assert store_feed_logo(feed) is True

    feed.refresh_from_db()
    first_path = feed.logo.path
    assert os.path.exists(first_path)

    with (
        patch(
            "core.aggregators.feed_logo.resolve_feed_logo_url",
            return_value="https://golem.de/favicon.png",
        ),
        patch("core.aggregators.feed_logo.fetch_bytes", return_value=_white_backed_png()),
    ):
        assert store_feed_logo(feed) is True

    feed.refresh_from_db()
    assert not os.path.exists(first_path)
    assert feed.logo.path != first_path
    assert os.path.exists(feed.logo.path)


@pytest.mark.django_db
def test_store_feed_logo_removes_the_file_when_the_db_save_fails(user, settings, tmp_path):
    """A DB save failure after a successful write must not orphan the new file."""
    settings.MEDIA_ROOT = tmp_path
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )

    with (
        patch(
            "core.aggregators.feed_logo.resolve_feed_logo_url",
            return_value="https://golem.de/favicon.png",
        ),
        patch("core.aggregators.feed_logo.fetch_bytes", return_value=_white_backed_png()),
        patch.object(Feed, "save", side_effect=OperationalError("database is locked")),
    ):
        assert store_feed_logo(feed) is False

    assert not feed.logo
    assert feed.logo_source_url == ""
    feed.refresh_from_db()
    assert not feed.logo
    assert feed.logo_source_url == ""
    assert not any(tmp_path.rglob("feed-*"))


@pytest.mark.django_db
def test_store_feed_logo_survives_the_old_file_already_being_gone(user, settings, tmp_path):
    """A missing previous file during cleanup must not fail or raise."""
    settings.MEDIA_ROOT = tmp_path
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )

    with (
        patch(
            "core.aggregators.feed_logo.resolve_feed_logo_url",
            return_value="https://golem.de/favicon.png",
        ),
        patch("core.aggregators.feed_logo.fetch_bytes", return_value=_white_backed_png()),
    ):
        assert store_feed_logo(feed) is True

    feed.refresh_from_db()
    os.remove(feed.logo.path)

    with (
        patch(
            "core.aggregators.feed_logo.resolve_feed_logo_url",
            return_value="https://golem.de/favicon.png",
        ),
        patch("core.aggregators.feed_logo.fetch_bytes", return_value=_white_backed_png()),
    ):
        assert store_feed_logo(feed) is True

    feed.refresh_from_db()
    assert feed.logo
    assert os.path.exists(feed.logo.path)
