"""
Bluesky utilities for inline embed rendering.

Provides functions for:
- Detecting Bluesky URLs
- Extracting post info (handle/DID + record key)
- Resolving handles to DIDs
- Fetching post data from the public Bluesky API
- Extracting images from posts
- Building rich HTML embeds
"""

import html
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

import requests

from .block_parser import is_safe_url

logger = logging.getLogger(__name__)

# Public (unauthenticated) Bluesky AppView API endpoint
BSKY_API_BASE = "https://public.api.bsky.app"


def is_bluesky_url(url: str) -> bool:
    """
    Check if a URL is a Bluesky URL.

    Handles:
    - bsky.app
    - staging.bsky.app

    Args:
        url: URL to check

    Returns:
        True if URL is from Bluesky
    """
    if not url:
        return False

    return "bsky.app" in url


def extract_bluesky_post_info(url: str) -> Optional[Tuple[str, str]]:
    """
    Extract the actor (handle or DID) and record key from a Bluesky post URL.

    Pattern: /profile/{handle_or_did}/post/{rkey}

    Args:
        url: Bluesky post URL

    Returns:
        Tuple of (actor, rkey) if found, None otherwise
    """
    if not url:
        return None

    match = re.search(r"/profile/([^/]+)/post/([^/?#]+)", url)
    if match:
        return match.group(1), match.group(2)

    return None


def resolve_bluesky_did(actor: str, timeout: int = 10) -> Optional[str]:
    """
    Resolve a Bluesky handle to a DID.

    If the actor is already a DID (starts with "did:"), it is returned as-is.

    Args:
        actor: Bluesky handle (e.g. "user.bsky.social") or DID
        timeout: Request timeout in seconds

    Returns:
        DID if resolved, None if failed
    """
    if not actor:
        return None

    if actor.startswith("did:"):
        return actor

    try:
        url = f"{BSKY_API_BASE}/xrpc/com.atproto.identity.resolveHandle"
        headers = {"User-Agent": "Yana/1.0"}

        response = requests.get(url, params={"handle": actor}, headers=headers, timeout=timeout)
        response.raise_for_status()

        did = response.json().get("did")
        if did:
            logger.debug(f"Resolved Bluesky handle {actor} to {did}")
        return did

    except requests.exceptions.RequestException as e:
        logger.warning(f"Error resolving Bluesky handle {actor}: {e}")
    except Exception as e:
        logger.error(f"Unexpected error resolving Bluesky handle {actor}: {e}")

    return None


def fetch_bluesky_post(actor: str, rkey: str, timeout: int = 10) -> Optional[Dict[str, Any]]:
    """
    Fetch post data from the public Bluesky API.

    Resolves the actor to a DID, constructs the AT-URI, and fetches the post
    via app.bsky.feed.getPosts.

    Args:
        actor: Bluesky handle or DID
        rkey: Post record key
        timeout: Request timeout in seconds

    Returns:
        Post data dict if successful, None if failed
    """
    if not actor or not rkey:
        return None

    did = resolve_bluesky_did(actor, timeout=timeout)
    if not did:
        return None

    at_uri = f"at://{did}/app.bsky.feed.post/{rkey}"

    try:
        url = f"{BSKY_API_BASE}/xrpc/app.bsky.feed.getPosts"
        headers = {"User-Agent": "Yana/1.0"}

        response = requests.get(url, params={"uris": at_uri}, headers=headers, timeout=timeout)
        response.raise_for_status()

        posts = response.json().get("posts") or []
        if not posts:
            logger.debug(f"Bluesky post {at_uri} not found")
            return None

        logger.debug(f"Fetched Bluesky post {at_uri}")
        return posts[0]

    except requests.exceptions.HTTPError as e:
        logger.warning(f"HTTP error fetching Bluesky post {at_uri}: {e.response.status_code}")
    except requests.exceptions.RequestException as e:
        logger.warning(f"Error fetching Bluesky post {at_uri}: {e}")
    except Exception as e:
        logger.error(f"Unexpected error fetching Bluesky post {at_uri}: {e}")

    return None


def extract_image_urls_from_post(post: Dict[str, Any]) -> List[str]:
    """
    Extract image URLs from Bluesky post data.

    Handles both app.bsky.embed.images#view and the media side of
    app.bsky.embed.recordWithMedia#view.

    Args:
        post: Post data dict from the Bluesky API

    Returns:
        List of fullsize image URLs found in the post
    """
    if not post:
        return []

    image_urls: List[str] = []

    try:
        embed = post.get("embed") or {}
        embed_type = embed.get("$type", "")

        # recordWithMedia wraps the actual media in a "media" key
        if "recordWithMedia" in embed_type:
            embed = embed.get("media") or {}

        for image in embed.get("images") or []:
            if isinstance(image, dict):
                img_url = image.get("fullsize") or image.get("thumb")
                if img_url:
                    image_urls.append(img_url)

    except (KeyError, TypeError) as e:
        logger.debug(f"Error extracting images from Bluesky post: {e}")

    return image_urls


def build_bluesky_embed_html(url: str) -> Optional[str]:
    """
    Build a rich HTML embed for a Bluesky post.

    Fetches post data from the public Bluesky API and renders it as a styled
    blockquote with author info, post text, images, and engagement stats.

    Args:
        url: Bluesky post URL

    Returns:
        HTML string with the post embed, or None if fetching failed
    """
    info = extract_bluesky_post_info(url)
    if not info:
        return None

    actor, rkey = info
    post = fetch_bluesky_post(actor, rkey)
    if not post:
        return None

    record = post.get("record") or {}
    text = record.get("text", "")
    author = post.get("author") or {}
    display_name = author.get("displayName", "")
    handle = author.get("handle", "")
    likes = post.get("likeCount", 0)
    reposts = post.get("repostCount", 0)
    replies = post.get("replyCount", 0)
    created_at = record.get("createdAt", "")

    # Clean URL (remove tracking params)
    clean_url = url.split("?")[0]

    # Build HTML parts
    parts = [
        '<blockquote style="border-left: 3px solid #0085ff; padding: 12px 16px;'
        ' margin: 1em 0; background: #f7f9fa;">',
    ]

    # Author line. clean_url is attacker-reachable (it comes from the source
    # feed/page URL) and lands inside an href attribute, so it needs both an
    # escape (quotes could break out of the attribute) and a scheme check
    # (a well-formed but unescaped `javascript:` URL is an XSS vector that
    # escaping alone does not fix -- see is_safe_url).
    author_display = display_name or (f"@{handle}" if handle else "")
    handle_suffix = f" (@{handle})" if display_name and handle else ""
    link_html = (
        f'<a href="{html.escape(clean_url, quote=True)}" target="_blank" rel="noopener">'
        f"View on Bluesky</a>"
        if is_safe_url(clean_url)
        else "View on Bluesky"
    )
    parts.append(
        f'<p style="margin: 0 0 8px 0;">'
        f"<strong>{_escape(author_display)}</strong>{_escape(handle_suffix)} · "
        f"{link_html}"
        f"</p>"
    )

    # Post text
    if text:
        parts.append(f'<p style="margin: 0 0 8px 0; white-space: pre-wrap;">{_escape(text)}</p>')

    # Images. Same reasoning as clean_url above: escape for the attribute
    # context, and skip the image entirely rather than render an unsafe
    # scheme's URL.
    for img_url in extract_image_urls_from_post(post):
        if not is_safe_url(img_url):
            continue
        parts.append(
            f'<p><img src="{html.escape(img_url, quote=True)}" alt="Bluesky image"'
            f' style="max-width: 100%; border-radius: 8px;"></p>'
        )

    # Engagement stats and date
    stats_parts = []
    if likes:
        stats_parts.append(f"&#9829; {_format_count(likes)}")
    if reposts:
        stats_parts.append(f"&#128257; {_format_count(reposts)}")
    if replies:
        stats_parts.append(f"&#128172; {_format_count(replies)}")
    if created_at:
        formatted_date = _format_post_date(created_at)
        if formatted_date:
            stats_parts.append(formatted_date)

    if stats_parts:
        stats_str = " · ".join(stats_parts)
        parts.append(f'<p style="margin: 0; color: #536471; font-size: 0.9em;">{stats_str}</p>')

    parts.append("</blockquote>")

    logger.debug(f"Built Bluesky embed for {clean_url}")
    return "\n".join(parts)


def _escape(text: str) -> str:
    """Escape HTML special characters.

    Delegates to the stdlib rather than hand-rolling the replace() chain: the
    old version covered ``&``/``<``/``>``/``"`` but missed ``'``, which is
    exploitable wherever the escaped value ends up inside a single-quoted
    attribute (or is used to close out of one). ``html.escape(..., quote=True)``
    covers all five. Same fix, same rationale, as ``twitter._escape``.
    """
    return html.escape(text, quote=True)


def _format_count(count: int) -> str:
    """Format a number for display (e.g. 1234 -> '1.2K')."""
    if count >= 1_000_000:
        return f"{count / 1_000_000:.1f}M"
    if count >= 1_000:
        return f"{count / 1_000:.1f}K"
    return str(count)


def _format_post_date(created_at: str) -> Optional[str]:
    """Format an ISO 8601 Bluesky date string for display."""
    try:
        from datetime import datetime

        # Bluesky returns ISO dates like "2026-06-04T04:34:34.364Z"
        normalized = created_at.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        return dt.strftime("%b %d, %Y")
    except (AttributeError, ValueError, TypeError):
        return None
