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

ALLOWED_SCHEMES = ("http", "https")

# resolve_site_icon runs on the feed-save path (FeedAdmin.save_model ->
# store_feed_logo) and in the Refresh feed logo action, both interactive.
# fetch_html's defaults (30 s, three attempts with backoff) would let one dead
# site hold an admin save for ~93 s.
ICON_TIMEOUT = 5
ICON_RETRIES = 1


def _sizes_area(sizes: str) -> int:
    """Largest declared area in a ``sizes`` attribute; 0 when undeclared or malformed."""
    best = 0
    for width, height in SIZES_PATTERN.findall(sizes or ""):
        best = max(best, int(width) * int(height))
    return best


def is_same_site(candidate: str, base_url: str) -> bool:
    """Whether ``candidate`` is an http(s) URL on the site's own domain.

    ``urljoin`` keeps an absolute href as-is, so without this check a page
    declaring ``<link rel="icon" href="http://169.254.169.254/...">`` would turn
    the icon lookup into an SSRF probe against our own network (cloud metadata,
    loopback ports, RFC1918).

    Also applied to every redirect hop when the icon is downloaded (see
    ``fetch_bytes``'s ``is_allowed_url``) -- checking only the declared URL would
    leave a 302 to that same metadata endpoint wide open.

    The match is "the base host with a leading ``www.`` stripped, plus any of its
    subdomains": a site is allowed to serve its icon from its own CDN subdomain
    (``static.heise.de`` for ``www.heise.de``), which several of the brand sites
    in ``brand_site_url`` do, while a different registrable domain is never
    allowed. Deliberately *not* a "last two labels match" rule -- that would
    treat every ``*.co.uk`` host as the same site. Erring narrow is safe: a
    rejected candidate just falls back to ``/favicon.ico`` on the site's origin.
    """
    base_host = (urlparse(base_url).hostname or "").lower()
    if not base_host:
        return False

    parsed = urlparse(candidate)
    if parsed.scheme.lower() not in ALLOWED_SCHEMES:
        return False

    host = (parsed.hostname or "").lower()
    base_domain = base_host.removeprefix("www.")
    return host == base_domain or host.endswith(f".{base_domain}")


def best_icon_url(html: str, base_url: str) -> str | None:
    """Best icon advertised by ``html``, resolved absolute. Pure -- no network.

    ``apple-touch-icon`` wins outright (first one encountered); otherwise the
    plain icon with the largest declared ``sizes`` area, earliest winning ties.
    Candidates that do not resolve onto the site's own domain are dropped -- see
    ``is_same_site``.
    """
    soup = BeautifulSoup(html or "", "html.parser")
    best_url: str | None = None
    best_area = -1

    for link in soup.find_all("link"):
        rels = [rel.lower() for rel in get_attr_list(link, "rel")]
        if not rels:
            continue

        href = get_attr_str(link, "href").strip()
        if not href:
            continue

        is_apple = any("apple-touch-icon" in rel for rel in rels)
        if not is_apple and "icon" not in rels:
            continue

        candidate = urljoin(base_url, href)
        if not is_same_site(candidate, base_url):
            logger.info(f"Ignoring off-site icon {candidate} declared by {base_url}")
            continue

        if is_apple:
            return candidate

        area = _sizes_area(get_attr_str(link, "sizes"))
        if area > best_area:
            best_area = area
            best_url = candidate

    return best_url


def resolve_site_icon(site_url: str) -> str | None:
    """Icon URL for ``site_url``, falling back to ``/favicon.ico`` on the same origin.

    The fallback URL is not verified: the caller downloads it anyway and treats a
    failed download as "no logo", so probing it first would only cost a request.
    """
    try:
        html = fetch_html(site_url, timeout=ICON_TIMEOUT, retries=ICON_RETRIES)
    except Exception as exc:
        logger.warning(f"Could not fetch {site_url} for its icon: {exc}")
        html = ""

    if html:
        declared = best_icon_url(html, site_url)
        if declared:
            return declared

    parsed = urlparse(site_url)
    if not parsed.scheme or not parsed.netloc:
        return None

    return f"{parsed.scheme}://{parsed.netloc}/favicon.ico"
