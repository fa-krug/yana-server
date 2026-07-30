"""Tests for feed URL normalization and resolution."""

from unittest.mock import patch

import pytest
import requests

from core.aggregators.registry import AggregatorRegistry
from core.aggregators.utils.feed_url_resolver import normalize, resolve_feed_url


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


def test_already_a_feed_returns_normalized_input_without_discovery():
    with (
        patch(
            "core.aggregators.utils.feed_url_resolver.parse_rss_feed",
            return_value={"entries": [{"title": "a"}], "feed": {}, "version": "rss20"},
        ),
        patch("core.aggregators.utils.feed_url_resolver.discover_feed_url") as discover,
    ):
        assert resolve_feed_url("golem.de/rss.php") == "https://golem.de/rss.php"
    discover.assert_not_called()


def test_homepage_resolves_to_discovered_feed():
    with (
        patch(
            "core.aggregators.utils.feed_url_resolver.parse_rss_feed",
            side_effect=ValueError("No entries found in feed"),
        ),
        patch(
            "core.aggregators.utils.feed_url_resolver.discover_feed_url",
            return_value="https://golem.de/rss.php",
        ),
    ):
        assert resolve_feed_url("golem.de") == "https://golem.de/rss.php"


def test_no_discoverable_feed_returns_normalized_input():
    with (
        patch(
            "core.aggregators.utils.feed_url_resolver.parse_rss_feed",
            side_effect=ValueError("No entries found in feed"),
        ),
        patch("core.aggregators.utils.feed_url_resolver.discover_feed_url", return_value=None),
    ):
        assert resolve_feed_url("golem.de") == "https://golem.de"


def test_network_failure_returns_normalized_input_without_raising():
    with (
        patch(
            "core.aggregators.utils.feed_url_resolver.parse_rss_feed",
            side_effect=requests.RequestException("boom"),
        ),
        patch(
            "core.aggregators.utils.feed_url_resolver.discover_feed_url",
            side_effect=requests.RequestException("boom"),
        ),
    ):
        assert resolve_feed_url("golem.de") == "https://golem.de"


def test_empty_input_never_hits_the_network():
    with patch("core.aggregators.utils.feed_url_resolver.parse_rss_feed") as parse:
        assert resolve_feed_url("  ") == ""
    parse.assert_not_called()


@pytest.mark.parametrize("aggregator_type", ["full_website", "feed_content", "podcast"])
def test_free_form_url_aggregators_resolve(aggregator_type):
    assert AggregatorRegistry.get(aggregator_type).resolves_feed_url() is True


@pytest.mark.parametrize(
    "aggregator_type",
    [
        "heise",
        "merkur",
        "tagesschau",
        "explosm",
        "dark_legacy",
        "caschys_blog",
        "mein_mmo",
        "mactechnews",
        "oglaf",
        "reddit",
        "youtube",
    ],
)
def test_managed_and_non_url_aggregators_do_not_resolve(aggregator_type):
    assert AggregatorRegistry.get(aggregator_type).resolves_feed_url() is False
