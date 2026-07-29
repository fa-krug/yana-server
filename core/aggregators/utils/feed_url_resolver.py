"""Feed URL normalization and resolution.

Mirrors the iOS client's ``FeedURLResolver``: a user may paste ``golem.de``,
``feed://golem.de/rss.php``, or a full feed URL, and all three have to end up as
something the RSS pipeline can fetch.
"""

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
