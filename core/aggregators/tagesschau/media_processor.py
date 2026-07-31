"""Tagesschau media player extraction logic."""

import html
import json
import logging
from typing import Any, Dict, List, Optional

from bs4 import BeautifulSoup, Tag

from ..services.image_store import IMAGE_REF_SCHEME, store_image_ref_from_url
from ..utils import get_attr_list, get_attr_str
from ..utils.block_parser import is_safe_url

logger = logging.getLogger(__name__)


def extract_media_header(html: str) -> Optional[str]:
    """
    Extract video or audio header from Tagesschau article page.
    """
    soup = BeautifulSoup(html, "html.parser")
    players = _get_media_players(soup)

    for player_div in players:
        data_v = get_attr_str(player_div, "data-v")
        if not data_v:
            continue

        try:
            player_data = _parse_player_data(data_v)
            mc = player_data.get("mc", {})
            streams = mc.get("streams", [])

            is_audio_only = len(streams) > 0 and all(s.get("isAudioOnly") is True for s in streams)
            image_url = _localize_image_url(_get_player_image(player_div, mc))

            # Try to extract embed code
            plugin_data = player_data.get("pluginData", {})
            sharing_web = plugin_data.get("sharing@web", {})
            embed_code = sharing_web.get("embedCode")

            if embed_code:
                result = _build_header_from_embed_code(embed_code, is_audio_only, image_url)
                if result:
                    return result

            # Fallback: construct player from streams
            result = _build_header_from_streams(streams, is_audio_only, image_url)
            if result:
                return result

        except Exception as e:
            logger.debug(f"Failed to parse Tagesschau media player data: {e}")

    return None


def _get_media_players(soup: BeautifulSoup) -> List[Tag]:
    """Find media player divs in the soup."""
    media_players = []
    for div in soup.find_all("div", attrs={"data-v-type": "MediaPlayer"}):
        classes = get_attr_list(div, "class")
        if any("mediaplayer" in c.lower() for c in classes):
            media_players.append(div)

    # Prioritize teaser-top players
    teaser_players = [
        p
        for p in media_players
        if any("teaser-top" in c.lower() for c in get_attr_list(p, "class"))
    ]
    return teaser_players if teaser_players else media_players


def _parse_player_data(data_v: str) -> Dict[str, Any]:
    """Decode and parse JSON from data-v attribute."""
    # Tagesschau uses some HTML entities in the JSON string
    decoded = (
        data_v.replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
    )
    return json.loads(decoded)


def _get_player_image(player_div: Tag, mc: Dict[str, Any]) -> Optional[str]:
    """Get preview image URL for the player."""
    image_url = _get_player_image_from_metadata(mc)

    if not image_url:
        image_url = _get_player_image_from_dom(player_div)

    if image_url:
        if image_url.startswith("//"):
            return "https:" + image_url
        if image_url.startswith("/"):
            return "https://www.tagesschau.de" + image_url

    return image_url


def _localize_image_url(image_url: Optional[str]) -> Optional[str]:
    """
    Store a resolved header image once and return its ``yana-img://`` reference.

    This is the single localization point for the player's preview image --
    ``_get_player_image`` has already resolved protocol-relative and
    root-relative URLs to absolute ``https://www.tagesschau.de/...`` form, and
    every downstream consumer (``_build_header_from_embed_code``'s audio-only
    ``<img>``, ``_build_header_from_streams``'s audio-only ``<img>`` and its
    ``<video poster>``) reads the same ``image_url``, so localizing here
    covers all three without having them each call storage independently.

    Follows the ``reddit.aggregator._store_header_image`` idiom: only
    ``http(s)`` URLs are attempted, and a failure (exception or a ``None``
    return, e.g. the fetch failed) degrades to the original remote URL rather
    than losing the image.
    """
    if not image_url or not image_url.startswith("http"):
        return image_url

    try:
        ref = store_image_ref_from_url(image_url, is_header=True)
        if ref:
            return ref
    except Exception as e:
        logger.warning(f"Failed to store Tagesschau header image {image_url}: {e}")

    return image_url


def _safe_image_src(image_url: Optional[str]) -> Optional[str]:
    """
    Return ``image_url`` ready to interpolate into an ``img src``/``video
    poster`` attribute, or ``None`` to skip the image entirely.

    ``image_url`` here is whatever ``_localize_image_url`` produced: either a
    trusted ``yana-img://<hash>`` reference from our own storage (returned
    verbatim -- ``is_safe_url`` doesn't recognize that scheme and would wrongly
    reject it, see ``block_parser._resolve_url``), or the original remote URL
    passed through unchanged on a storage failure (or a non-http(s) URL that
    ``_localize_image_url`` never attempted to store at all). That remote
    value is attacker-reachable -- scraped from the page's DOM or its embedded
    JSON -- so it still needs the same escape + scheme check every other
    aggregator's images get (see ``is_safe_url``).
    """
    if not image_url:
        return None
    if image_url.startswith(IMAGE_REF_SCHEME):
        return image_url
    if not is_safe_url(image_url):
        return None
    return html.escape(image_url, quote=True)


def _get_player_image_from_metadata(mc: Dict[str, Any]) -> Optional[str]:
    """Extract image URL from metadata fields."""
    fields = ["poster", "image", "thumbnail", "preview", "cover"]

    # Check main mc object
    for field in fields:
        if mc.get(field):
            return mc[field]

    # Check streams
    for stream in mc.get("streams", []):
        for field in fields:
            if stream.get(field):
                return stream[field]

    return None


def _get_player_image_from_dom(player_div: Tag) -> Optional[str]:
    """Extract image URL from surrounding DOM."""
    # Check parent
    parent = player_div.parent
    if isinstance(parent, Tag):
        img = parent.find("img")
        if isinstance(img, Tag):
            return get_attr_str(img, "src") or None

    # Check previous sibling
    prev = player_div.find_previous_sibling()
    if isinstance(prev, Tag):
        img = prev.find("img")
        if isinstance(img, Tag):
            return get_attr_str(img, "src") or None

    return None


def _build_header_from_embed_code(
    embed_code: str, is_audio_only: bool, image_url: Optional[str]
) -> Optional[str]:
    """Build header HTML from iframe embed code."""
    decoded = (
        embed_code.replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
    )

    soup = BeautifulSoup(decoded, "html.parser")
    iframe = soup.find("iframe")
    if not isinstance(iframe, Tag):
        return None

    src = get_attr_str(iframe, "src")
    if not src:
        return None

    src = src.replace("$params$", "")
    if src.startswith("//"):
        src = "https:" + src
    elif src.startswith("/"):
        src = "https://www.tagesschau.de" + src

    # `src` is scraped from the embed markup carried in the page's `data-v`
    # JSON -- attacker-reachable if that page is compromised -- and lands in
    # an iframe's `src` attribute, so it needs both the escape (a literal
    # quote would break out of the attribute) and the scheme check (a
    # well-formed `javascript:`/`data:` URL is an XSS vector escaping alone
    # does not fix -- see `is_safe_url`). An unsafe scheme drops the embed
    # entirely; the caller falls back to `_build_header_from_streams`.
    if not is_safe_url(src):
        return None
    safe_src = html.escape(src, quote=True)

    height = "200" if is_audio_only else "315"
    player_html = (
        f'<div class="media-player" style="width: 100%;">'
        f'<iframe src="{safe_src}" width="100%" height="{height}" '
        f'frameborder="0" allowfullscreen scrolling="no"></iframe>'
        f"</div>"
    )

    safe_image = _safe_image_src(image_url)
    if is_audio_only and safe_image:
        img_part = (
            f'<div class="media-image"><img src="{safe_image}" alt="Article image" '
            f'style="max-width: 100%; height: auto; border-radius: 8px;"></div>'
        )
        return f'<header class="media-header">{img_part}{player_html}</header>'

    return f'<header class="media-header">{player_html}</header>'


def _build_header_from_streams(
    streams: List[Dict[str, Any]], is_audio_only: bool, image_url: Optional[str]
) -> Optional[str]:
    """Build header HTML using HTML5 audio/video tags from streams."""
    safe_image = _safe_image_src(image_url)
    if is_audio_only:
        audio_media = _find_media_by_mime_type(streams, "audio")
        if audio_media:
            img_part = (
                f'<div class="media-image"><img src="{safe_image}" alt="Article image" '
                f'style="max-width: 100%; height: auto; border-radius: 8px;"></div>'
                if safe_image
                else ""
            )
            return (
                f'<header class="media-header">{img_part}'
                f'<div class="media-player" style="width: 100%;">'
                f'<audio controls preload="auto" style="width: 100%;">'
                f'<source src="{audio_media["url"]}" type="{audio_media["mime_type"]}">'
                f"Your browser does not support the audio element."
                f"</audio></div></header>"
            )
    else:
        video_media = _find_media_by_mime_type(streams, "video")
        if video_media:
            poster = f'poster="{safe_image}"' if safe_image else ""
            return (
                f'<header class="media-header">'
                f'<div class="media-player" style="width: 100%;">'
                f'<video controls preload="auto" {poster} style="width: 100%;">'
                f'<source src="{video_media["url"]}" type="{video_media["mime_type"]}">'
                f"Your browser does not support the video element."
                f"</video></div></header>"
            )
    return None


def _find_media_by_mime_type(
    streams: List[Dict[str, Any]], media_type: str
) -> Optional[Dict[str, str]]:
    """
    Find media URL and mime type from streams.

    Both fields land straight in a ``<source src type>`` below and come from
    the page's embedded ``data-v`` JSON -- attacker-reachable if that page is
    compromised -- so both are escaped here (once, at the one place both
    call sites in ``_build_header_from_streams`` read them), and the URL is
    additionally scheme-checked: escaping alone does not neutralize a
    well-formed ``javascript:``/``data:`` URL (see ``is_safe_url``). A stream
    whose URL fails the check is treated as not found, matching how an unsafe
    image URL is skipped rather than rendered (see ``_safe_image_src``).
    """
    for stream in streams:
        for media in stream.get("media", []):
            url = media.get("url")
            mime_type = media.get("mimeType", "")
            if url and media_type in mime_type.lower() and is_safe_url(url):
                return {
                    "url": html.escape(url, quote=True),
                    "mime_type": html.escape(mime_type, quote=True),
                }
    return None
