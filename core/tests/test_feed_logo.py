"""Tests for per-feed logo resolution and storage."""

from unittest.mock import patch

import pytest

from core.aggregators.feed_logo import resolve_feed_logo_url
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
