"""Tests for feed URL normalization and resolution."""

from core.aggregators.utils.feed_url_resolver import normalize


def test_bare_domain_gains_https():
    assert normalize("golem.de") == "https://golem.de"


def test_existing_http_scheme_is_preserved():
    assert normalize("http://golem.de/rss.php") == "http://golem.de/rss.php"


def test_existing_https_scheme_is_preserved():
    assert normalize("https://golem.de/rss.php") == "https://golem.de/rss.php"


def test_feed_scheme_is_rewritten_to_https():
    assert normalize("feed://golem.de/rss.php") == "https://golem.de/rss.php"


def test_uppercase_feed_scheme_is_rewritten():
    assert normalize("FEED://golem.de/rss.php") == "https://golem.de/rss.php"


def test_whitespace_is_trimmed():
    assert normalize("  golem.de  ") == "https://golem.de"


def test_empty_passes_through():
    assert normalize("") == ""
    assert normalize("   ") == ""
