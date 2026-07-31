"""Per-feed logo resolution.

Mirrors the iOS client's ``FeedLogoResolver``: an API-provided image first, then
the brand site's favicon for fixed-brand scrapers, then the identifier's own
origin. Every tier is best-effort -- a failure means "no logo", never an error
raised into feed saving.
"""

import io
import logging
import os
from collections.abc import Callable
from typing import NamedTuple
from urllib.parse import urlparse

from django.core.files.base import ContentFile

from PIL import Image

from .utils.favicon import is_same_site, resolve_site_icon
from .utils.html_fetcher import fetch_bytes
from .utils.logo_background import remove_white_background

logger = logging.getLogger(__name__)

# store_feed_logo runs on the feed-save path, so the download is bounded well
# below fetch_bytes' 30 s default. An icon that cannot be had in 10 s is not
# worth holding an admin save for.
LOGO_FETCH_TIMEOUT = 10


class LogoSource(NamedTuple):
    """A logo URL plus the site the download has to stay on.

    ``same_site_base`` is the site whose page advertised the icon: the download
    must not redirect off it, or the check ``is_same_site`` already applied to
    the declared URL would only cover the first hop. It is ``None`` for an
    API-provided image, which legitimately lives on the provider's own CDN and
    was never subject to that check.
    """

    url: str
    same_site_base: str | None


def _identifier_origin(identifier: str) -> str | None:
    """``scheme://host/`` for a URL identifier, or ``None`` for anything else."""
    parsed = urlparse(identifier or "")
    if not parsed.scheme or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}/"


def _same_site_guard(base_url: str) -> Callable[[str], bool]:
    """Predicate for ``fetch_bytes`` that keeps a download on ``base_url``'s site."""

    def is_allowed(candidate: str) -> bool:
        return is_same_site(candidate, base_url)

    return is_allowed


def _icon_source(site_url: str) -> LogoSource | None:
    """Site icon for ``site_url``, pinned to that site for the download."""
    icon = resolve_site_icon(site_url)
    return LogoSource(icon, site_url) if icon else None


def resolve_feed_logo_url(feed) -> LogoSource | None:
    """Best logo source for ``feed``, or ``None`` when no tier yields one."""
    from . import get_aggregator

    try:
        aggregator = get_aggregator(feed)
    except Exception as exc:
        logger.warning(f"No aggregator for feed {feed.pk}: {exc}")
        return None

    try:
        api_image = aggregator.logo_image_url()
    except Exception as exc:
        logger.warning(f"API logo lookup failed for feed {feed.pk}: {exc}")
        api_image = None

    if api_image:
        return LogoSource(api_image, None)

    brand_site = type(aggregator).brand_site_url
    if brand_site:
        return _icon_source(brand_site)

    origin = _identifier_origin(feed.identifier)
    if not origin:
        return None

    return _icon_source(origin)


def _logo_filename(feed, source_url: str, is_png: bool) -> str:
    if is_png:
        return f"feed-{feed.pk}.png"
    extension = os.path.splitext(urlparse(source_url).path)[1].lower()
    if extension not in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"):
        extension = ".png"
    return f"feed-{feed.pk}{extension}"


def _decodes_as_image(data: bytes) -> bool:
    """Whether ``data`` is something Pillow recognizes as an image.

    ``resolve_site_icon`` deliberately returns ``/favicon.ico`` unverified, so a
    site answering it with an HTML soft-404 would otherwise get that HTML stored
    as ``feed-<pk>.ico`` and every consumer would render a broken image. Also
    rejects an SVG icon, which ``Feed.logo`` (an ``ImageField``) could not
    describe anyway, and a decompression bomb, which Pillow refuses to open.
    """
    try:
        with Image.open(io.BytesIO(data)) as opened:
            opened.verify()
    except Exception as exc:
        logger.warning(f"Downloaded logo is not a decodable image: {exc}")
        return False

    return True


def _delete_stored_file(storage, name: str) -> None:
    """Best-effort delete of ``name`` from ``storage``. Never raises."""
    if not name:
        return
    try:
        storage.delete(name)
    except Exception as exc:
        logger.warning(f"Could not delete logo file {name}: {exc}")


def store_feed_logo(feed) -> bool:
    """Resolve, download, and store ``feed.logo``. Returns True when one was stored.

    Never raises: a dead favicon URL must not prevent saving a feed. Failures are
    logged and leave ``logo`` as it was.
    """
    try:
        source = resolve_feed_logo_url(feed)
    except Exception as exc:
        logger.warning(f"Logo resolution failed for feed {feed.pk}: {exc}")
        return False

    if not source:
        logger.info(f"No logo resolved for feed {feed.pk}")
        return False

    source_url = source.url
    base = source.same_site_base

    try:
        data = fetch_bytes(
            source_url,
            timeout=LOGO_FETCH_TIMEOUT,
            is_allowed_url=_same_site_guard(base) if base else None,
        )
    except Exception as exc:
        logger.warning(f"Logo download failed for feed {feed.pk} ({source_url}): {exc}")
        return False

    if not _decodes_as_image(data):
        logger.warning(
            f"Not storing a logo for feed {feed.pk}: {source_url} did not return an image"
        )
        return False

    stripped = remove_white_background(data)
    payload = stripped or data

    storage = feed.logo.storage
    old_name = feed.logo.name
    old_source_url = feed.logo_source_url

    try:
        feed.logo.save(
            _logo_filename(feed, source_url, is_png=stripped is not None),
            ContentFile(payload),
            save=False,
        )
    except Exception as exc:
        logger.warning(f"Storing the logo failed for feed {feed.pk}: {exc}")
        return False

    new_name = feed.logo.name
    feed.logo_source_url = source_url

    try:
        feed.save(update_fields=["logo", "logo_source_url", "updated_at"])
    except Exception as exc:
        logger.warning(f"Saving the feed after storing the logo failed for feed {feed.pk}: {exc}")
        _delete_stored_file(storage, new_name)
        feed.logo.name = old_name
        feed.logo_source_url = old_source_url
        return False

    if old_name and old_name != new_name:
        _delete_stored_file(storage, old_name)

    return True
