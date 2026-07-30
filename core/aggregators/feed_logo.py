"""Per-feed logo resolution.

Mirrors the iOS client's ``FeedLogoResolver``: an API-provided image first, then
the brand site's favicon for fixed-brand scrapers, then the identifier's own
origin. Every tier is best-effort -- a failure means "no logo", never an error
raised into feed saving.
"""

import logging
from urllib.parse import urlparse

from .utils.favicon import resolve_site_icon

logger = logging.getLogger(__name__)


def _identifier_origin(identifier: str) -> str | None:
    """``scheme://host/`` for a URL identifier, or ``None`` for anything else."""
    parsed = urlparse(identifier or "")
    if not parsed.scheme or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}/"


def resolve_feed_logo_url(feed) -> str | None:
    """Best logo URL for ``feed``, or ``None`` when no tier yields one."""
    from . import get_aggregator

    try:
        aggregator = get_aggregator(feed)
    except Exception as exc:
        logger.debug(f"No aggregator for feed {feed.pk}: {exc}")
        return None

    try:
        api_image = aggregator.logo_image_url()
    except Exception as exc:
        logger.debug(f"API logo lookup failed for feed {feed.pk}: {exc}")
        api_image = None

    if api_image:
        return api_image

    brand_site = type(aggregator).brand_site_url
    if brand_site:
        return resolve_site_icon(brand_site)

    origin = _identifier_origin(feed.identifier)
    if not origin:
        return None

    return resolve_site_icon(origin)
