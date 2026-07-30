"""Tests for RSS/Atom feed discovery from page HTML."""

from unittest.mock import patch

import requests

from core.aggregators.utils.feed_discovery import discover_feed_url, feed_url_in_html

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
