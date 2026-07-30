"""Discover a site's advertised RSS/Atom feed.

Mirrors the iOS client's ``FeedDiscovery``. Parsing and fetching are split so
the parse half is testable without network, and so callers that already hold the
page HTML do not fetch it twice.
"""

import logging
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from .bs4_utils import get_attr_list, get_attr_str
from .html_fetcher import fetch_html

logger = logging.getLogger(__name__)

RSS_TYPE = "application/rss+xml"
ATOM_TYPE = "application/atom+xml"

# RSS before Atom: the iOS client picks RSS when a page advertises both, and the
# two implementations have to agree on which feed a given site resolves to.
FEED_TYPE_PRIORITY = (RSS_TYPE, ATOM_TYPE)


def feed_url_in_html(html: str, base_url: str | None) -> str | None:
    """First alternate RSS/Atom feed href in ``html``, resolved absolute.

    Pure -- no network. Returns ``None`` when the page advertises no feed.
    """
    soup = BeautifulSoup(html or "", "html.parser")
    first_by_type: dict[str, str] = {}

    for link in soup.find_all("link"):
        rels = [rel.lower() for rel in get_attr_list(link, "rel")]
        if "alternate" not in rels:
            continue

        link_type = get_attr_str(link, "type").strip().lower()
        if link_type not in FEED_TYPE_PRIORITY:
            continue

        href = get_attr_str(link, "href").strip()
        if not href:
            continue

        first_by_type.setdefault(link_type, href)

    for wanted in FEED_TYPE_PRIORITY:
        feed_href = first_by_type.get(wanted)
        if feed_href:
            if base_url:
                return urljoin(base_url, feed_href)
            return feed_href

    return None


def discover_feed_url(page_url: str) -> str | None:
    """Fetch ``page_url`` and return its advertised feed URL, or ``None``.

    Best-effort: any fetch failure is logged and reported as ``None``.
    """
    try:
        html = fetch_html(page_url)
    except Exception as exc:
        logger.debug(f"Feed discovery could not fetch {page_url}: {exc}")
        return None

    return feed_url_in_html(html, page_url)
