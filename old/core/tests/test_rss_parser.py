"""Tests for RSS parsing, including the bounded interactive fetch."""

from unittest.mock import patch

import pytest
import requests

from core.aggregators.utils.rss_parser import parse_rss_feed

RSS = (
    b'<?xml version="1.0"?><rss version="2.0"><channel><title>Golem</title>'
    b"<item><title>a</title><link>https://golem.de/a</link></item></channel></rss>"
)


def test_invalid_url_raises_before_any_fetch():
    with (
        patch("core.aggregators.utils.rss_parser.fetch_bytes") as fetch,
        pytest.raises(ValueError, match="Invalid feed URL"),
    ):
        parse_rss_feed("not a url")
    fetch.assert_not_called()


def test_without_a_timeout_feedparser_does_its_own_fetch():
    """The background aggregation path must keep its existing semantics."""
    with (
        patch("core.aggregators.utils.rss_parser.feedparser.parse") as parse,
        patch("core.aggregators.utils.rss_parser.fetch_bytes") as fetch,
    ):
        parse.return_value = type(
            "Parsed", (), {"bozo": 0, "feed": {}, "entries": [{"title": "a"}], "version": "rss20"}
        )()
        parse_rss_feed("https://golem.de/rss.php")

    parse.assert_called_once_with("https://golem.de/rss.php")
    fetch.assert_not_called()


def test_with_a_timeout_the_bytes_are_fetched_here_and_parsed_locally():
    with (
        patch("core.aggregators.utils.rss_parser.fetch_bytes", return_value=RSS) as fetch,
        patch(
            "core.aggregators.utils.rss_parser.feedparser.parse",
            wraps=__import__("feedparser").parse,
        ) as parse,
    ):
        result = parse_rss_feed("https://golem.de/rss.php", timeout=5)

    assert len(result["entries"]) == 1
    assert fetch.call_args.args[0] == "https://golem.de/rss.php"
    assert fetch.call_args.kwargs["timeout"] == 5
    # feedparser got bytes, so it never opened a socket of its own.
    assert isinstance(parse.call_args.args[0], bytes)


def test_with_a_timeout_a_fetch_failure_becomes_a_valueerror():
    with (
        patch(
            "core.aggregators.utils.rss_parser.fetch_bytes",
            side_effect=requests.RequestException("timed out"),
        ),
        pytest.raises(ValueError, match="Could not fetch feed"),
    ):
        parse_rss_feed("https://golem.de/rss.php", timeout=5)


def test_with_a_timeout_a_feed_without_entries_still_raises():
    with (
        patch(
            "core.aggregators.utils.rss_parser.fetch_bytes",
            return_value=b'<?xml version="1.0"?><rss version="2.0"><channel/></rss>',
        ),
        pytest.raises(ValueError, match="No entries found in feed"),
    ):
        parse_rss_feed("https://golem.de/rss.php", timeout=5)
