"""Tests for RSS/Atom feed discovery from page HTML."""

from unittest.mock import patch

import pytest
import requests

from core.aggregators.implementations import FeedContentAggregator
from core.aggregators.utils.feed_discovery import discover_feed_url, feed_url_in_html
from core.models import Feed

RSS_LINK = '<link rel="alternate" type="application/rss+xml" href="/rss.php">'
ATOM_LINK = '<link rel="alternate" type="application/atom+xml" href="/atom.xml">'


def _page(*links: str) -> str:
    return f"<html><head>{''.join(links)}</head><body>x</body></html>"


def test_rss_link_is_found_and_resolved_absolute():
    html = _page(RSS_LINK)
    assert feed_url_in_html(html, "https://golem.de/") == "https://golem.de/rss.php"


def test_atom_only_page_is_found():
    html = _page(ATOM_LINK)
    assert feed_url_in_html(html, "https://golem.de/") == "https://golem.de/atom.xml"


def test_rss_is_preferred_when_both_are_advertised():
    html = _page(ATOM_LINK, RSS_LINK)
    assert feed_url_in_html(html, "https://golem.de/") == "https://golem.de/rss.php"


def test_absolute_href_is_left_alone():
    html = _page(
        '<link rel="alternate" type="application/rss+xml" href="https://cdn.example/f.xml">'
    )
    assert feed_url_in_html(html, "https://golem.de/") == "https://cdn.example/f.xml"


def test_no_alternate_link_returns_none():
    assert (
        feed_url_in_html(_page('<link rel="stylesheet" href="/a.css">'), "https://golem.de/")
        is None
    )


def test_empty_href_is_skipped():
    html = _page('<link rel="alternate" type="application/rss+xml" href="   ">', ATOM_LINK)
    assert feed_url_in_html(html, "https://golem.de/") == "https://golem.de/atom.xml"


def test_non_feed_alternate_type_is_ignored():
    html = _page('<link rel="alternate" type="text/html" href="/en/">')
    assert feed_url_in_html(html, "https://golem.de/") is None


def test_missing_base_url_returns_href_unchanged():
    assert feed_url_in_html(_page(RSS_LINK), None) == "/rss.php"


def test_empty_html_returns_none():
    assert feed_url_in_html("", "https://golem.de/") is None


def test_discover_feed_url_fetches_and_parses():
    with patch(
        "core.aggregators.utils.feed_discovery.fetch_html", return_value=_page(RSS_LINK)
    ) as fetch:
        assert discover_feed_url("https://golem.de/") == "https://golem.de/rss.php"
    fetch.assert_called_once_with("https://golem.de/")


def test_discover_feed_url_returns_none_on_network_error():
    with patch(
        "core.aggregators.utils.feed_discovery.fetch_html",
        side_effect=requests.RequestException("boom"),
    ):
        assert discover_feed_url("https://golem.de/") is None


FEED_DATA = {
    "entries": [{"title": "a", "link": "https://golem.de/a"}],
    "feed": {},
    "version": "rss20",
}


@pytest.fixture
def homepage_feed(user):
    return Feed.objects.create(
        name="Golem", aggregator="feed_content", identifier="https://golem.de/", user=user
    )


@pytest.mark.django_db
def test_fetch_source_data_follows_discovery_when_identifier_is_a_page(homepage_feed):
    aggregator = FeedContentAggregator(homepage_feed)

    with (
        patch(
            "core.aggregators.rss.parse_rss_feed",
            side_effect=[ValueError("No entries found in feed"), FEED_DATA],
        ) as parse,
        patch("core.aggregators.rss.discover_feed_url", return_value="https://golem.de/rss.php"),
    ):
        assert aggregator.fetch_source_data() == FEED_DATA

    assert parse.call_args_list[-1].args[0] == "https://golem.de/rss.php"


@pytest.mark.django_db
def test_fetch_source_data_reraises_when_nothing_is_discoverable(homepage_feed):
    aggregator = FeedContentAggregator(homepage_feed)

    with (
        patch(
            "core.aggregators.rss.parse_rss_feed",
            side_effect=ValueError("No entries found in feed"),
        ),
        patch("core.aggregators.rss.discover_feed_url", return_value=None),
        pytest.raises(ValueError, match="No entries found in feed"),
    ):
        aggregator.fetch_source_data()


@pytest.mark.django_db
def test_fetch_source_data_skips_discovery_for_a_non_url_identifier(user):
    feed = Feed.objects.create(
        name="Broken", aggregator="feed_content", identifier="not a url", user=user
    )
    aggregator = FeedContentAggregator(feed)

    with (
        patch("core.aggregators.rss.parse_rss_feed", side_effect=ValueError("Invalid feed URL")),
        patch("core.aggregators.rss.discover_feed_url") as discover,
        pytest.raises(ValueError, match="Invalid feed URL"),
    ):
        aggregator.fetch_source_data()

    discover.assert_not_called()
