"""Tests for site favicon selection."""

from unittest.mock import patch

import requests

from core.aggregators.utils.favicon import best_icon_url, resolve_site_icon


def _page(*links: str) -> str:
    return f"<html><head>{''.join(links)}</head></html>"


def test_apple_touch_icon_beats_a_larger_plain_icon():
    html = _page(
        '<link rel="icon" sizes="512x512" href="/big.png">',
        '<link rel="apple-touch-icon" sizes="180x180" href="/apple.png">',
    )
    assert best_icon_url(html, "https://heise.de/") == "https://heise.de/apple.png"


def test_largest_sizes_wins_among_plain_icons():
    html = _page(
        '<link rel="icon" sizes="32x32" href="/small.png">',
        '<link rel="icon" sizes="192x192" href="/large.png">',
    )
    assert best_icon_url(html, "https://heise.de/") == "https://heise.de/large.png"


def test_shortcut_icon_rel_is_accepted():
    html = _page('<link rel="shortcut icon" href="/favicon.png">')
    assert best_icon_url(html, "https://heise.de/") == "https://heise.de/favicon.png"


def test_malformed_sizes_does_not_crash_selection():
    html = _page(
        '<link rel="icon" sizes="any" href="/vector.svg">',
        '<link rel="icon" sizes="48x48" href="/raster.png">',
    )
    assert best_icon_url(html, "https://heise.de/") == "https://heise.de/raster.png"


def test_icon_without_sizes_is_still_a_candidate():
    html = _page('<link rel="icon" href="/plain.png">')
    assert best_icon_url(html, "https://heise.de/") == "https://heise.de/plain.png"


def test_empty_href_is_skipped():
    html = _page('<link rel="icon" href="  ">', '<link rel="icon" href="/real.png">')
    assert best_icon_url(html, "https://heise.de/") == "https://heise.de/real.png"


def test_no_icon_links_returns_none():
    assert (
        best_icon_url(_page('<link rel="stylesheet" href="/a.css">'), "https://heise.de/") is None
    )


def test_resolve_site_icon_uses_the_declared_icon():
    html = _page('<link rel="icon" href="/favicon.png">')
    with patch("core.aggregators.utils.favicon.fetch_html", return_value=html):
        assert resolve_site_icon("https://heise.de/") == "https://heise.de/favicon.png"


def test_resolve_site_icon_falls_back_to_favicon_ico():
    with patch("core.aggregators.utils.favicon.fetch_html", return_value=_page()):
        assert resolve_site_icon("https://heise.de/news") == "https://heise.de/favicon.ico"


def test_resolve_site_icon_falls_back_when_the_fetch_fails():
    with patch(
        "core.aggregators.utils.favicon.fetch_html",
        side_effect=requests.RequestException("boom"),
    ):
        assert resolve_site_icon("https://heise.de/") == "https://heise.de/favicon.ico"


def test_resolve_site_icon_returns_none_for_an_unparseable_url():
    with patch(
        "core.aggregators.utils.favicon.fetch_html",
        side_effect=requests.RequestException(),
    ):
        assert resolve_site_icon("not a url") is None


def test_absolute_cross_host_icon_is_rejected():
    """A site must not be able to point us at another host (SSRF probe)."""
    html = _page('<link rel="icon" href="http://169.254.169.254/latest/meta-data">')
    assert best_icon_url(html, "https://heise.de/") is None


def test_absolute_same_host_icon_is_kept():
    html = _page('<link rel="icon" href="https://heise.de/static/favicon.png">')
    assert best_icon_url(html, "https://heise.de/") == "https://heise.de/static/favicon.png"


def test_icon_on_the_sites_own_subdomain_is_kept():
    html = _page('<link rel="icon" href="https://static.heise.de/favicon.png">')
    assert best_icon_url(html, "https://www.heise.de/") == "https://static.heise.de/favicon.png"


def test_icon_on_the_apex_of_a_www_site_is_kept():
    html = _page('<link rel="icon" href="https://heise.de/favicon.png">')
    assert best_icon_url(html, "https://www.heise.de/") == "https://heise.de/favicon.png"


def test_icon_on_another_registrable_domain_is_rejected():
    html = _page('<link rel="icon" href="https://evil.co.uk/favicon.png">')
    assert best_icon_url(html, "https://bbc.co.uk/") is None


def test_javascript_scheme_icon_is_rejected():
    html = _page('<link rel="icon" href="javascript:alert(1)">')
    assert best_icon_url(html, "https://heise.de/") is None


def test_data_uri_icon_is_rejected():
    html = _page('<link rel="icon" href="data:image/png;base64,AAAA">')
    assert best_icon_url(html, "https://heise.de/") is None


def test_cross_host_apple_touch_icon_does_not_shadow_a_same_host_icon():
    html = _page(
        '<link rel="apple-touch-icon" href="http://127.0.0.1:6379/apple.png">',
        '<link rel="icon" href="/favicon.png">',
    )
    assert best_icon_url(html, "https://heise.de/") == "https://heise.de/favicon.png"


def test_resolve_site_icon_falls_back_when_the_declared_icon_is_cross_host():
    html = _page('<link rel="icon" href="http://169.254.169.254/latest/meta-data">')
    with patch("core.aggregators.utils.favicon.fetch_html", return_value=html):
        assert resolve_site_icon("https://heise.de/") == "https://heise.de/favicon.ico"
