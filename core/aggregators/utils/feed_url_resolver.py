"""Feed URL normalization and resolution.

Mirrors the iOS client's ``FeedURLResolver``: a user may paste ``golem.de``,
``feed://golem.de/rss.php``, or a full feed URL, and all three have to end up as
something the RSS pipeline can fetch.
"""

import logging

from .feed_discovery import discover_feed_url
from .rss_parser import parse_rss_feed

logger = logging.getLogger(__name__)

FEED_SCHEME = "feed://"
HTTPS_SCHEME = "https://"


def normalize(raw: str) -> str:
    """Trim, prepend ``https://`` when no scheme is present, rewrite ``feed://``.

    Empty (or whitespace-only) input passes through as an empty string so a
    blank identifier stays blank.
    """
    trimmed = (raw or "").strip()
    if not trimmed:
        return ""

    if trimmed.lower().startswith(FEED_SCHEME):
        return HTTPS_SCHEME + trimmed[len(FEED_SCHEME) :]

    if "://" in trimmed:
        return trimmed

    return HTTPS_SCHEME + trimmed


def resolve_feed_url(raw: str) -> str:
    """``normalize()``, then resolve a homepage to its advertised feed.

    Never raises. Returns the normalized input when it already parses as a feed,
    when discovery finds nothing, or on any network or parse failure -- a resolve
    failure must not block saving a feed, which is what makes this safe to call
    from a form's ``clean()``.
    """
    normalized = normalize(raw)
    if not normalized:
        return normalized

    try:
        parse_rss_feed(normalized)
        return normalized
    except Exception:
        # Not a feed (or unreachable) -- fall through to discovery.
        pass

    try:
        discovered = discover_feed_url(normalized)
    except Exception as exc:
        logger.debug(f"Feed resolution failed for {normalized}: {exc}")
        return normalized

    return discovered or normalized
