"""Tagesschau media player extraction logic."""

import json
import logging
from typing import Any, Dict, List, Optional

from bs4 import BeautifulSoup, Tag

from ..services.image_store import store_image_ref_from_url
from ..utils import get_attr_list, get_attr_str

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

    height = "200" if is_audio_only else "315"
    player_html = (
        f'<div class="media-player" style="width: 100%;">'
        f'<iframe src="{src}" width="100%" height="{height}" '
        f'frameborder="0" allowfullscreen scrolling="no"></iframe>'
        f"</div>"
    )

    if is_audio_only and image_url:
        img_part = f'<div class="media-image"><img src="{image_url}" alt="Article image" style="max-width: 100%; height: auto; border-radius: 8px;"></div>'
        return f'<header class="media-header">{img_part}{player_html}</header>'

    return f'<header class="media-header">{player_html}</header>'


def _build_header_from_streams(
    streams: List[Dict[str, Any]], is_audio_only: bool, image_url: Optional[str]
) -> Optional[str]:
    """Build header HTML using HTML5 audio/video tags from streams."""
    if is_audio_only:
        audio_media = _find_media_by_mime_type(streams, "audio")
        if audio_media:
            img_part = (
                f'<div class="media-image"><img src="{image_url}" alt="Article image" style="max-width: 100%; height: auto; border-radius: 8px;"></div>'
                if image_url
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
            poster = f'poster="{image_url}"' if image_url else ""
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
    """Find media URL and mime type from streams."""
    for stream in streams:
        for media in stream.get("media", []):
            url = media.get("url")
            mime_type = media.get("mimeType", "")
            if url and media_type in mime_type.lower():
                return {"url": url, "mime_type": mime_type}
    return None
