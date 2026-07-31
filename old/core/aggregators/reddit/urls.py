"""Reddit URL utilities."""

import html
import logging
import re
from typing import Any, Dict, Optional

import prawcore.exceptions

from .auth import get_praw_instance

logger = logging.getLogger(__name__)

REDDIT_API_BASE = "https://www.reddit.com"


def decode_html_entities_in_url(url: str) -> str:
    """
    Decode HTML entities in URLs using html.unescape.

    Args:
        url: URL string

    Returns:
        Decoded URL
    """
    return html.unescape(url)


def fix_reddit_media_url(url: Optional[str]) -> Optional[str]:
    """
    Fix Reddit media URLs by decoding HTML entities.
    Reddit API often returns URLs with double-escaped entities like &amp;amp;.

    Args:
        url: URL from Reddit API

    Returns:
        Fixed URL or None
    """
    if not url:
        return None

    # Use html.unescape twice to handle double-escaped entities like &amp;amp;
    decoded = html.unescape(url)
    if "&" in decoded:
        decoded = html.unescape(decoded)

    return decoded


def normalize_subreddit(identifier: str) -> str:
    """
    Extract subreddit name from URL or identifier.

    Args:
        identifier: Subreddit identifier (can be URL, r/subreddit, or just subreddit)

    Returns:
        Normalized subreddit name
    """
    identifier = identifier.strip()

    # Match /r/name, r/name, or reddit.com/r/name
    # Allows for leading slash to be optional
    url_match = re.search(r"(?:reddit\.com)?/?r/(\w+)", identifier)
    if url_match:
        return url_match.group(1)

    # Remove r/ or /r/ prefix if still there (fallback)
    if identifier.startswith("/r/"):
        identifier = identifier[3:]
    elif identifier.startswith("r/"):
        identifier = identifier[2:]

    # Remove trailing slash and anything after it
    identifier = identifier.split("/")[0]

    # Remove anything after a colon or space if it looks like a label was accidentally included
    identifier = re.split(r"[:\s]", identifier)[0]

    return identifier


def extract_post_info_from_url(url: str) -> Dict[str, Optional[str]]:
    """
    Extract post ID and subreddit from Reddit URL.

    Format: https://reddit.com/r/{subreddit}/comments/{postId}/...

    Args:
        url: Reddit post URL

    Returns:
        Dict with 'subreddit' and 'post_id' keys
    """
    match = re.search(r"/r/(\w+)/comments/([a-zA-Z0-9]+)", url)
    if match:
        return {"subreddit": match.group(1), "post_id": match.group(2)}
    return {"subreddit": None, "post_id": None}


def validate_subreddit(subreddit: str) -> Dict[str, Any]:
    """
    Validate subreddit name.

    Args:
        subreddit: Subreddit name

    Returns:
        Dict with 'valid' (bool) and optional 'error' (str)
    """
    if not subreddit:
        return {"valid": False, "error": "Subreddit is required"}

    # Subreddit names: 2-21 characters, alphanumeric and underscores only
    if not re.match(r"^\w{2,21}$", subreddit):
        return {
            "valid": False,
            "error": "Invalid subreddit name. Use 2-21 alphanumeric characters or underscores.",
        }

    return {"valid": True}


def fetch_subreddit_info(subreddit: str, user_id: int) -> Dict[str, Optional[str]]:
    """
    Fetch subreddit information including icon using PRAW.

    Args:
        subreddit: Subreddit name (without /r/)
        user_id: User ID for authentication

    Returns:
        Dict with 'iconUrl' key
    """
    try:
        reddit = get_praw_instance(user_id)
        sub = reddit.subreddit(subreddit)

        # Try multiple fields for icon in order of preference
        # Access .icon_img first; PRAW lazily fetches subreddit data on attribute access
        raw_icon_url = sub.icon_img or sub.community_icon or getattr(sub, "header_img", None)

        icon_url = None
        if raw_icon_url:
            icon_url = fix_reddit_media_url(raw_icon_url)

        if icon_url:
            logger.debug(f"Fetched subreddit icon for r/{subreddit}: {icon_url}")

        return {"iconUrl": icon_url}

    except prawcore.exceptions.NotFound:
        logger.warning(f"Subreddit r/{subreddit} not found")
        return {"iconUrl": None}

    except prawcore.exceptions.Forbidden:
        logger.warning(f"Subreddit r/{subreddit} is private or banned")
        return {"iconUrl": None}

    except Exception as e:
        logger.warning(f"Failed to fetch subreddit info for r/{subreddit}: {e}")
        return {"iconUrl": None}


def extract_urls_from_text(text: str) -> list[str]:
    """
    Extract URLs from Reddit post text (selftext).

    Handles both plain URLs and markdown links [text](url).
    Decodes HTML entities in extracted URLs.

    Args:
        text: Text to extract URLs from

    Returns:
        List of URLs
    """
    if not text:
        return []

    urls = []

    # Pattern for markdown links: [text](url)
    markdown_link_pattern = re.compile(r"\[([^\]]*)\]\((https?://[^)]+)\)")
    for match in markdown_link_pattern.finditer(text):
        urls.append(decode_html_entities_in_url(match.group(2)))

    # Pattern for plain URLs: http:// or https://
    plain_url_pattern = re.compile(r"(?<!\]\()(https?://[^\s)]+)")
    for match in plain_url_pattern.finditer(text):
        # Remove trailing punctuation
        url = re.sub(r"[.,;:!?)]+$", "", match.group(1))
        decoded_url = decode_html_entities_in_url(url)
        if decoded_url not in urls:
            urls.append(decoded_url)

    return urls
