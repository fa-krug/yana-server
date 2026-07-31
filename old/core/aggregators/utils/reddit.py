"""
Reddit utilities for header element extraction.

Provides functions for:
- Detecting Reddit embed URLs
- Extracting post info (subreddit, post ID)
- Fetching subreddit icons
"""

import logging
import re
from typing import Optional

import prawcore.exceptions

logger = logging.getLogger(__name__)


def is_reddit_embed_url(url: str) -> bool:
    """
    Check if URL is a Reddit video embed URL.

    Handles:
    - vxreddit.com URLs (Reddit video mirror)
    - reddit.com/embed URLs
    - v.redd.it/embed URLs

    Args:
        url: URL to check

    Returns:
        True if URL is a Reddit embed URL
    """
    if not url:
        return False

    return "vxreddit.com" in url or (
        "/embed" in url and ("reddit.com" in url or "v.redd.it" in url)
    )


def extract_post_info_from_url(url: str) -> dict[str, str | None]:
    """
    Extract subreddit and post ID from Reddit post URL.

    Pattern: /r/{SUBREDDIT}/comments/{POST_ID}/...

    Args:
        url: Reddit post URL

    Returns:
        Dict with keys 'subreddit' and 'post_id' (both Optional[str])
    """
    result: dict[str, str | None] = {"subreddit": None, "post_id": None}

    if not url:
        return result

    # Pattern: /r/subreddit/comments/post_id/
    match = re.search(r"/r/(\w+)/comments/([a-zA-Z0-9]+)", url)
    if match:
        result["subreddit"] = match.group(1)
        result["post_id"] = match.group(2)

    return result


def fetch_subreddit_icon(subreddit: str, user_id: int | None = None) -> Optional[str]:
    """
    Fetch subreddit icon URL using PRAW.

    Args:
        subreddit: Subreddit name (without /r/)
        user_id: User ID for PRAW authentication

    Returns:
        Subreddit icon URL if found, None otherwise
    """
    if not subreddit:
        return None

    if not user_id:
        logger.debug(f"No user_id provided for fetch_subreddit_icon r/{subreddit}, skipping")
        return None

    try:
        from core.aggregators.reddit.auth import get_praw_instance

        reddit = get_praw_instance(user_id)
        sub = reddit.subreddit(subreddit)

        # Try multiple fields for icon in order of preference
        raw_icon_url = sub.icon_img or sub.community_icon or getattr(sub, "header_img", None)

        if not raw_icon_url:
            logger.debug(f"No icon found for subreddit r/{subreddit}")
            return None

        icon_url = fix_reddit_media_url(raw_icon_url)
        logger.debug(f"Found subreddit icon for r/{subreddit}: {icon_url}")
        return icon_url

    except prawcore.exceptions.NotFound:
        logger.debug(f"Subreddit r/{subreddit} not found")
    except prawcore.exceptions.Forbidden:
        logger.debug(f"Subreddit r/{subreddit} is private or banned")
    except ValueError as e:
        logger.debug(f"Reddit not configured for user {user_id}: {e}")
    except Exception as e:
        logger.warning(f"Error fetching subreddit icon for r/{subreddit}: {e}")

    return None


def fix_reddit_media_url(url: str) -> str:
    """
    Fix Reddit media URL encoding.

    Reddit sometimes encodes '&' as '&amp;' in URLs.
    This function fixes those URLs so they work correctly.

    Args:
        url: URL from Reddit API

    Returns:
        Fixed URL
    """
    if not url:
        return url

    return url.replace("&amp;", "&")


def is_reddit_url(url: str) -> bool:
    """
    Check if a URL is a Reddit URL.

    Args:
        url: URL to check

    Returns:
        True if URL is from reddit.com or similar
    """
    if not url:
        return False

    return any(domain in url for domain in ["reddit.com", "v.redd.it", "vxreddit.com"])
