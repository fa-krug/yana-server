"""Reddit image extraction utilities."""

import logging
import re
from typing import Optional

from core.aggregators.services.image_extraction.domain_overrides import get_override_image_url
from core.aggregators.services.image_extraction.extractor import ImageExtractor

from ..utils.twitter import is_twitter_url
from ..utils.youtube import extract_youtube_video_id
from .types import RedditPostData
from .urls import (
    decode_html_entities_in_url,
    extract_urls_from_text,
    fix_reddit_media_url,
)

logger = logging.getLogger(__name__)


def extract_thumbnail_url(post: RedditPostData) -> Optional[str]:
    """
    Extract thumbnail URL from Reddit post.

    Prioritizes high-resolution images from preview data over low-resolution thumbnails.

    Args:
        post: RedditPostData instance

    Returns:
        Thumbnail URL or None
    """
    try:
        # Priority 1: Try preview images (high-resolution source)
        if post.preview and post.preview.get("images") and len(post.preview["images"]) > 0:
            source_url = post.preview["images"][0].get("source", {}).get("url")
            if source_url:
                decoded = decode_html_entities_in_url(source_url)
                return fix_reddit_media_url(decoded)

        # Priority 2: Try post URL if it's an image (original resolution)
        if post.url:
            decoded_url = decode_html_entities_in_url(post.url)
            url_lower = decoded_url.lower()
            if any(ext in url_lower for ext in [".jpg", ".jpeg", ".png", ".webp", ".gif"]):
                return decoded_url
            if "v.redd.it" in url_lower:
                return extract_reddit_video_preview(post)

        # Priority 3: Fall back to post thumbnail property (low-resolution)
        if post.thumbnail and post.thumbnail not in ["self", "default", "nsfw", "spoiler"]:
            if post.thumbnail.startswith("http"):
                return decode_html_entities_in_url(post.thumbnail)
            if post.thumbnail.startswith("/"):
                return decode_html_entities_in_url(f"https://reddit.com{post.thumbnail}")

        return None
    except Exception as e:
        logger.debug(f"Could not extract thumbnail URL: {e}")
        return None


def extract_reddit_video_preview(post: RedditPostData) -> Optional[str]:
    """
    Extract preview/thumbnail image URL from a Reddit video post.

    Args:
        post: RedditPostData instance

    Returns:
        Preview URL or None
    """
    try:
        if not post.preview or not post.preview.get("images") or len(post.preview["images"]) == 0:
            return None

        source_url = post.preview["images"][0].get("source", {}).get("url")
        if not source_url:
            return None

        decoded = decode_html_entities_in_url(source_url)
        preview_url = fix_reddit_media_url(decoded)
        logger.debug(f"Extracted Reddit video preview: {preview_url}")
        return preview_url
    except Exception as e:
        logger.debug(f"Could not extract Reddit video preview: {e}")
        return None


def extract_animated_gif_url(post: RedditPostData) -> Optional[str]:
    """
    Extract animated GIF URL from Reddit preview data.

    Args:
        post: RedditPostData instance

    Returns:
        GIF URL or None
    """
    try:
        if not post.preview or not post.preview.get("images") or len(post.preview["images"]) == 0:
            return None

        image_data = post.preview["images"][0]
        variants = image_data.get("variants", {})

        if variants.get("gif", {}).get("source", {}).get("url"):
            gif_url = variants["gif"]["source"]["url"]
            decoded = decode_html_entities_in_url(gif_url)
            return fix_reddit_media_url(decoded)

        if variants.get("mp4", {}).get("source", {}).get("url"):
            mp4_url = variants["mp4"]["source"]["url"]
            decoded = decode_html_entities_in_url(mp4_url)
            return fix_reddit_media_url(decoded)

        return None
    except Exception as e:
        logger.debug(f"Could not extract animated GIF URL: {e}")
        return None


def extract_header_image_url(post: RedditPostData) -> Optional[str]:
    """
    Extract high-quality header image URL from a Reddit post.

    Prioritizes YouTube videos for embedding, then high-quality images
    suitable for use as header images.

    Args:
        post: RedditPostData instance

    Returns:
        Header image URL or None
    """
    try:
        # Priority -1: Domain image overrides take precedence over everything else.
        # When the linked URL matches a configured override (e.g. Nintendo support
        # pages) we use the configured brand image instead of Reddit's auto-generated
        # preview, which is often an animated GIF placeholder.
        if post.url:
            decoded_post_url = decode_html_entities_in_url(post.url)
            override_url = get_override_image_url(decoded_post_url)
            if override_url:
                return override_url

        # Priority 0: Check for YouTube videos (highest priority)
        # Note: v.redd.it videos are handled as images via thumbnail/preview extraction
        # to ensure we display an image, not a vxreddit.com HTML link
        video_url = _extract_video_embed_url(post)
        if video_url and "vxreddit.com" not in video_url:
            return video_url

        # Priority 0.5: Twitter/X link posts (return URL for header embed)
        if post.url and is_twitter_url(post.url):
            return decode_html_entities_in_url(post.url)

        # Priority 0.6: Twitter/X URL in selftext (return URL for header embed)
        if post.is_self and post.selftext:
            selftext_urls = extract_urls_from_text(post.selftext)
            for url in selftext_urls:
                if is_twitter_url(url):
                    return decode_html_entities_in_url(url)

        # Priority 1: Gallery posts - get first high-quality image
        gallery_url = _extract_gallery_image_url(post)
        if gallery_url:
            return gallery_url

        # Priority 2: Direct image posts (including GIFs)
        if post.url:
            decoded_url = decode_html_entities_in_url(post.url)
            url_lower = decoded_url.lower()

            # Ignore Reddit post URLs
            if not re.search(
                r"https?://[^\s]*reddit\.com/r/[^/\s]+/comments/[a-zA-Z0-9]+/[^/\s]+/?$",
                decoded_url,
            ):
                is_direct_image = (
                    any(
                        ext in url_lower
                        for ext in [".jpg", ".jpeg", ".png", ".webp", ".gif", ".gifv"]
                    )
                    or "i.redd.it" in url_lower
                    or ("preview.redd.it" in url_lower and ".gif" in url_lower)
                )

                if is_direct_image:
                    return decoded_url

        # Priority 3: Extract URLs from text post selftext (check before thumbnail fallback
        # to get high-res images when available in selftext)
        image_url = _extract_image_url_from_selftext(post)
        if image_url:
            return image_url

        # Priority 4: Fall back to thumbnail extraction
        thumbnail_url = extract_thumbnail_url(post)
        if thumbnail_url:
            # Special handling for v.redd.it to get high-res preview if possible
            if post.url and "v.redd.it" in post.url:
                preview_url = extract_reddit_video_preview(post)
                if preview_url:
                    return preview_url
            return thumbnail_url

        # Priority 5: If it is a link post, try to extract image from the linked page
        if post.url and not post.is_self:
            decoded_url = decode_html_entities_in_url(post.url)
            # Ignore Reddit post URLs (they are internal links)
            if not re.search(
                r"https?://[^\s]*reddit\.com/r/[^/\s]+/comments/[a-zA-Z0-9]+/[^/\s]+/?$",
                decoded_url,
            ):
                logger.debug(f"Checking {decoded_url} for header image (link post)")
                page_image = _extract_image_from_url_sync(decoded_url)
                if page_image:
                    return page_image

        return None

    except Exception as e:
        logger.debug(f"Could not extract header image URL: {e}")
        return None


def _extract_video_embed_url(post: RedditPostData) -> Optional[str]:
    """Extract video embed URL (YouTube or v.redd.it) from post URL or selftext."""
    # Check post URL first
    if post.url:
        decoded_url = decode_html_entities_in_url(post.url)

        # Check for v.redd.it videos
        if "v.redd.it" in decoded_url:
            decoded_permalink = decode_html_entities_in_url(post.permalink)
            normalized_permalink = decoded_permalink.rstrip("/")
            return f"https://vxreddit.com{normalized_permalink}"

        # Check for YouTube videos
        if extract_youtube_video_id(decoded_url):
            return decoded_url

    # Check URLs in selftext
    if post.is_self and post.selftext:
        urls = extract_urls_from_text(post.selftext)
        for url in urls:
            if "v.redd.it" in url:
                decoded_permalink = decode_html_entities_in_url(post.permalink)
                normalized_permalink = decoded_permalink.rstrip("/")
                return f"https://vxreddit.com{normalized_permalink}"

            if extract_youtube_video_id(url):
                return url

    return None


def _extract_gallery_image_url(post: RedditPostData) -> Optional[str]:
    """Extract high-quality image URL from a Reddit gallery post."""
    if not post.is_gallery or not post.media_metadata or not post.gallery_data:
        return None

    items = post.gallery_data.get("items", [])
    if not items:
        return None

    media_id = items[0].get("media_id")
    if not media_id:
        return None

    media_info = post.media_metadata.get(media_id)
    if not media_info:
        return None

    # For animated images, prefer GIF or MP4
    if media_info.get("e") == "AnimatedImage":
        animated_url = media_info.get("s", {}).get("gif") or media_info.get("s", {}).get("mp4")
        if animated_url:
            decoded = decode_html_entities_in_url(animated_url)
            return fix_reddit_media_url(decoded)

    # For regular images, get the high-quality URL
    if media_info.get("e") == "Image" and media_info.get("s", {}).get("u"):
        image_url = media_info["s"]["u"]
        decoded = decode_html_entities_in_url(image_url)
        return fix_reddit_media_url(decoded)

    return None


def _extract_image_url_from_selftext(post: RedditPostData) -> Optional[str]:
    """Extract image URL from selftext URLs."""
    if not post.is_self or not post.selftext:
        return None

    # Truncate selftext before comment URLs
    import re

    selftext_to_process = post.selftext
    comment_url_pattern = r"https?://[^\s]*/comments/[a-zA-Z0-9]+/[^/\s]+/[a-zA-Z0-9]+"
    comment_url_match = re.search(comment_url_pattern, selftext_to_process)
    if comment_url_match:
        selftext_to_process = selftext_to_process[: comment_url_match.start()]

    urls = extract_urls_from_text(selftext_to_process)
    if not urls:
        return None

    first_valid_url = None
    for url in urls:
        if not url.startswith(("http://", "https://")):
            continue
        if "preview.redd.it" in url.lower() or any(
            ext in url.lower() for ext in [".jpg", ".jpeg", ".png", ".webp", ".gif"]
        ):
            return url
        # Skip Twitter/X URLs for image extraction - they are handled as
        # header embeds in extract_header_image_url() Priority 0.6
        if first_valid_url is None and not is_twitter_url(url):
            first_valid_url = url

    # If no direct image URL found, try to extract image from the linked page
    if first_valid_url:
        logger.debug(f"Checking {first_valid_url} for header image")
        page_image = _extract_image_from_url_sync(first_valid_url)
        if page_image:
            return page_image

    return None


def _extract_image_from_url_sync(url: str) -> Optional[str]:
    """
    Synchronous wrapper for ImageExtractor.
    """
    try:
        extractor = ImageExtractor()
        result = extractor.extract_image_from_url(url, is_header_image=True)
        if result and result.get("imageUrl"):
            return result["imageUrl"]
        return None
    except Exception as e:
        logger.debug(f"ImageExtractor failed for {url}: {e}")
        return None
