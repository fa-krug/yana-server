"""RSS feed parsing utilities."""

from typing import Any, Dict, Optional
from urllib.parse import urlparse

import feedparser
import requests

from .html_fetcher import fetch_bytes

# A feed is text; 8 MB is far more than any real one and still bounds the read.
MAX_FEED_BYTES = 8 * 1024 * 1024


def parse_rss_feed(url: str, timeout: Optional[int] = None) -> Dict[str, Any]:
    """
    Parse RSS/Atom feed from URL.

    Args:
        url: RSS feed URL
        timeout: When given, fetch the feed here with this per-request timeout
            (a single attempt) and hand the bytes to feedparser. Use it on
            interactive paths: ``feedparser.parse(url)`` does its own HTTP with
            **no** timeout, so a black-holed host would hang the request
            indefinitely. When omitted, feedparser fetches the URL itself --
            unchanged behaviour for the background aggregation path.

    Returns:
        Parsed feed dictionary with 'entries' list

    Raises:
        ValueError: If feed cannot be parsed, the URL is invalid, or (with
            ``timeout``) the feed could not be fetched.
    """
    # Validate URL
    parsed_url = urlparse(url)
    if not all([parsed_url.scheme, parsed_url.netloc]):
        raise ValueError(f"Invalid feed URL: {url}")

    # Parse feed
    if timeout is None:
        feed = feedparser.parse(url)
    else:
        try:
            raw = fetch_bytes(url, timeout=timeout, max_bytes=MAX_FEED_BYTES)
        except requests.RequestException as exc:
            raise ValueError(f"Could not fetch feed {url}: {exc}") from exc
        feed = feedparser.parse(raw)

    # Check for errors
    if hasattr(feed, "bozo") and feed.bozo and hasattr(feed, "bozo_exception"):
        raise ValueError(f"Feed parsing error: {feed.bozo_exception}")

    if not feed.entries:
        raise ValueError(f"No entries found in feed: {url}")

    return {"feed": feed.feed, "entries": feed.entries, "version": feed.version}
