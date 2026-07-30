"""Site favicon resolution.

Mirrors the iOS client's ``FaviconResolver``. Only ever contacts the site's own
domain -- a third-party favicon service would leak every subscribed URL.
"""

import logging
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from .bs4_utils import get_attr_list, get_attr_str
from .html_fetcher import fetch_html

logger = logging.getLogger(__name__)

SIZES_PATTERN = re.compile(r"(\d+)\s*[xX]\s*(\d+)")


def _sizes_area(sizes: str) -> int:
    """Largest declared area in a ``sizes`` attribute; 0 when undeclared or malformed."""
    best = 0
    for width, height in SIZES_PATTERN.findall(sizes or ""):
        best = max(best, int(width) * int(height))
    return best


def best_icon_url(html: str, base_url: str) -> str | None:
    """Best icon advertised by ``html``, resolved absolute. Pure -- no network.

    ``apple-touch-icon`` wins outright (first one encountered); otherwise the
    plain icon with the largest declared ``sizes`` area, earliest winning ties.
    """
    soup = BeautifulSoup(html or "", "html.parser")
    best_href: str | None = None
    best_area = -1

    for link in soup.find_all("link"):
        rels = [rel.lower() for rel in get_attr_list(link, "rel")]
        if not rels:
            continue

        href = get_attr_str(link, "href").strip()
        if not href:
            continue

        if any("apple-touch-icon" in rel for rel in rels):
            return urljoin(base_url, href)

        if "icon" not in rels:
            continue

        area = _sizes_area(get_attr_str(link, "sizes"))
        if area > best_area:
            best_area = area
            best_href = href

    return urljoin(base_url, best_href) if best_href else None


def resolve_site_icon(site_url: str) -> str | None:
    """Icon URL for ``site_url``, falling back to ``/favicon.ico`` on the same origin.

    The fallback URL is not verified: the caller downloads it anyway and treats a
    failed download as "no logo", so probing it first would only cost a request.
    """
    try:
        html = fetch_html(site_url)
    except Exception as exc:
        logger.debug(f"Could not fetch {site_url} for its icon: {exc}")
        html = ""

    if html:
        declared = best_icon_url(html, site_url)
        if declared:
            return declared

    parsed = urlparse(site_url)
    if not parsed.scheme or not parsed.netloc:
        return None

    return f"{parsed.scheme}://{parsed.netloc}/favicon.ico"
