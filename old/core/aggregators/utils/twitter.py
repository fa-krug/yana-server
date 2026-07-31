"""
Twitter/X utilities for header element extraction.

Provides functions for:
- Detecting Twitter/X URLs
- Extracting tweet IDs
- Fetching tweet data from fxtwitter API
- Extracting images from tweets
"""

import html
import logging
import re
from typing import Any, Dict, List, Optional

import requests

from .block_parser import is_safe_url

logger = logging.getLogger(__name__)

# fxtwitter API endpoint
FXTWITTER_API_BASE = "https://api.fxtwitter.com"


def is_twitter_url(url: str) -> bool:
    """
    Check if a URL is a Twitter/X URL.

    Handles:
    - twitter.com
    - x.com (new domain)
    - mobile.twitter.com

    Args:
        url: URL to check

    Returns:
        True if URL is from Twitter/X
    """
    if not url:
        return False

    twitter_domains = ["twitter.com", "x.com", "mobile.twitter.com"]
    return any(domain in url for domain in twitter_domains)


def extract_tweet_id(url: str) -> Optional[str]:
    """
    Extract tweet ID from Twitter/X URL.

    Pattern: /status/{TWEET_ID}

    Args:
        url: Twitter/X URL

    Returns:
        Tweet ID if found, None otherwise
    """
    if not url:
        return None

    match = re.search(r"/status/(\d+)", url)
    if match:
        return match.group(1)

    return None


def fetch_tweet_data(tweet_id: str, timeout: int = 10) -> Optional[Dict[str, Any]]:
    """
    Fetch tweet data from fxtwitter API.

    fxtwitter provides a cleaner API for accessing Twitter/X data
    including direct image URLs without authentication.

    Args:
        tweet_id: Tweet ID to fetch
        timeout: Request timeout in seconds

    Returns:
        Tweet data dict if successful, None if failed
    """
    if not tweet_id:
        return None

    try:
        url = f"{FXTWITTER_API_BASE}/status/{tweet_id}"
        headers = {"User-Agent": "Yana/1.0"}

        response = requests.get(url, headers=headers, timeout=timeout)
        response.raise_for_status()

        data = response.json()
        logger.debug(f"Fetched tweet data for {tweet_id}")
        return data

    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 404:
            logger.debug(f"Tweet {tweet_id} not found")
        else:
            logger.warning(f"HTTP error fetching tweet {tweet_id}: {e.response.status_code}")
    except requests.exceptions.RequestException as e:
        logger.warning(f"Error fetching tweet {tweet_id}: {e}")
    except Exception as e:
        logger.error(f"Unexpected error fetching tweet {tweet_id}: {e}")

    return None


def extract_image_urls_from_tweet(data: Dict[str, Any]) -> List[str]:
    """
    Extract image URLs from tweet data.

    Searches for images in tweet media objects.

    Args:
        data: Tweet data dict from fxtwitter API

    Returns:
        List of image URLs found in tweet
    """
    if not data:
        return []

    image_urls = []

    try:
        # fxtwitter API structure: data.tweet.media
        tweet = data.get("tweet", {})
        media = tweet.get("media") or {}

        # Try photos first
        if "photos" in media:
            for photo in media["photos"]:
                if isinstance(photo, dict) and "url" in photo:
                    image_urls.append(photo["url"])

        # Try all media if no photos found
        if not image_urls and "all" in media:
            for item in media["all"]:
                if isinstance(item, dict) and item.get("type") == "photo" and "url" in item:
                    image_urls.append(item["url"])

        # Try article cover image if no media images found
        if not image_urls:
            article = tweet.get("article") or {}
            cover_media = article.get("cover_media") or {}
            media_info = cover_media.get("media_info") or {}
            original_img_url = media_info.get("original_img_url")
            if original_img_url:
                image_urls.append(original_img_url)

    except (KeyError, TypeError) as e:
        logger.debug(f"Error extracting images from tweet: {e}")

    return image_urls


def get_first_tweet_image(data: Dict[str, Any]) -> Optional[str]:
    """
    Get the first image URL from tweet data.

    Args:
        data: Tweet data dict from fxtwitter API

    Returns:
        First image URL if found, None otherwise
    """
    images = extract_image_urls_from_tweet(data)
    return images[0] if images else None


def build_tweet_embed_html(url: str) -> Optional[str]:
    """
    Build a rich HTML embed for a Twitter/X post.

    Fetches tweet data from fxtwitter API and renders it as a styled blockquote
    with author info, tweet text, images, and engagement stats.

    Args:
        url: Twitter/X URL

    Returns:
        HTML string with the tweet embed, or None if fetching failed
    """
    tweet_id = extract_tweet_id(url)
    if not tweet_id:
        return None

    data = fetch_tweet_data(tweet_id)
    if not data:
        return None

    tweet = data.get("tweet", {})
    if not tweet:
        return None

    # Extract tweet fields
    text = tweet.get("text", "")
    author = tweet.get("author", {})
    author_name = author.get("name", "")
    screen_name = author.get("screen_name", "")
    likes = tweet.get("likes", 0)
    retweets = tweet.get("retweets", 0)
    created_at = tweet.get("created_at", "")

    # Clean URL (remove tracking params)
    clean_url = url.split("?")[0]

    # Build HTML parts
    parts = [
        '<blockquote style="border-left: 3px solid #1d9bf0; padding: 12px 16px;'
        ' margin: 1em 0; background: #f7f9fa;">',
    ]

    # Author line. clean_url is attacker-reachable (it comes from the source
    # feed/page URL) and lands inside an href attribute, so it needs both an
    # escape (quotes could break out of the attribute) and a scheme check
    # (a well-formed but unescaped `javascript:` URL is an XSS vector that
    # escaping alone does not fix -- see is_safe_url).
    author_display = f"@{screen_name}" if screen_name else author_name
    link_html = (
        f'<a href="{html.escape(clean_url, quote=True)}" target="_blank" rel="noopener">'
        f"View on X</a>"
        if is_safe_url(clean_url)
        else "View on X"
    )
    parts.append(
        f'<p style="margin: 0 0 8px 0;">'
        f"<strong>{_escape(author_display)}</strong> · "
        f"{link_html}"
        f"</p>"
    )

    # Tweet text
    if text:
        parts.append(f'<p style="margin: 0 0 8px 0;">{_escape(text)}</p>')

    # Images. Same reasoning as clean_url above: escape for the attribute
    # context, and skip the image entirely rather than render an unsafe
    # scheme's URL.
    image_urls = extract_image_urls_from_tweet(data)
    for img_url in image_urls:
        if not is_safe_url(img_url):
            continue
        parts.append(
            f'<p><img src="{html.escape(img_url, quote=True)}" alt="Tweet image"'
            f' style="max-width: 100%; border-radius: 8px;"></p>'
        )

    # Engagement stats and date
    stats_parts = []
    if likes:
        stats_parts.append(f"&#9829; {_format_count(likes)}")
    if retweets:
        stats_parts.append(f"&#128257; {_format_count(retweets)}")
    if created_at:
        formatted_date = _format_tweet_date(created_at)
        if formatted_date:
            stats_parts.append(formatted_date)

    if stats_parts:
        stats_str = " · ".join(stats_parts)
        parts.append(f'<p style="margin: 0; color: #536471; font-size: 0.9em;">{stats_str}</p>')

    parts.append("</blockquote>")

    logger.debug(f"Built tweet embed for {tweet_id} by @{screen_name}")
    return "\n".join(parts)


def _escape(text: str) -> str:
    """Escape HTML special characters.

    Delegates to the stdlib rather than hand-rolling the replace() chain: the
    old version covered ``&``/``<``/``>``/``"`` but missed ``'``, which is
    exploitable wherever the escaped value ends up inside a single-quoted
    attribute (or is used to close out of one). ``html.escape(..., quote=True)``
    covers all five.
    """
    return html.escape(text, quote=True)


def _format_count(count: int) -> str:
    """Format a number for display (e.g. 1234 -> '1.2K')."""
    if count >= 1_000_000:
        return f"{count / 1_000_000:.1f}M"
    if count >= 1_000:
        return f"{count / 1_000:.1f}K"
    return str(count)


def _format_tweet_date(created_at: str) -> Optional[str]:
    """Format fxtwitter date string for display."""
    try:
        # fxtwitter returns dates like "Wed Jan 15 12:34:56 +0000 2026"
        from datetime import datetime

        dt = datetime.strptime(created_at, "%a %b %d %H:%M:%S %z %Y")
        return dt.strftime("%b %d, %Y")
    except (ValueError, TypeError):
        return None
