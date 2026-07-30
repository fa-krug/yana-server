"""
Header element extraction strategies using Strategy Pattern.

Provides strategies for extracting header elements (HTML) from different sources:
1. RedditEmbedStrategy - Reddit video embeds (vxreddit.com, reddit.com/embed)
2. RedditPostStrategy - Reddit post subreddit icons (fetches icon, stores it in the image store)
3. YouTubeStrategy - YouTube video iframes
4. GenericImageStrategy - Fallback for all other sources (uses ImageExtractor)
"""

import logging
from abc import ABC, abstractmethod

from core.aggregators.exceptions import ArticleSkipError
from core.aggregators.services.header_element.context import HeaderElementContext, HeaderElementData
from core.aggregators.services.image_extraction.extractor import ImageExtractor
from core.aggregators.services.image_extraction.fetcher import fetch_single_image
from core.aggregators.services.image_store import store_image_bytes
from core.aggregators.utils.reddit import (
    extract_post_info_from_url,
    fetch_subreddit_icon,
    is_reddit_embed_url,
)
from core.aggregators.utils.youtube import (
    extract_youtube_video_id,
    get_youtube_thumbnail_url,
)

logger = logging.getLogger(__name__)


class HeaderElementStrategy(ABC):
    """Base class for header element extraction strategies."""

    @abstractmethod
    def can_handle(self, url: str) -> bool:
        """Check if this strategy can handle the URL."""
        pass

    @abstractmethod
    def create(self, context: HeaderElementContext) -> HeaderElementData | None:
        """
        Create header element data.

        Returns:
            HeaderElementData object, or None if creation fails
        """
        pass


class RedditEmbedStrategy(HeaderElementStrategy):
    """Strategy for Reddit video embeds."""

    def can_handle(self, url: str) -> bool:
        """Check if URL is a Reddit embed URL."""
        return is_reddit_embed_url(url)

    def create(self, context: HeaderElementContext) -> HeaderElementData | None:
        """Extract image from Reddit embed."""
        logger.debug(f"RedditEmbedStrategy: Extracting image for {context.url}")

        try:
            # Try to extract image using GenericImageStrategy for the embed URL
            strategy = GenericImageStrategy()
            return strategy.create(context)
        except Exception as e:
            logger.warning(f"RedditEmbedStrategy: Failed - {e}")
            return None


class RedditPostStrategy(HeaderElementStrategy):
    """Strategy for Reddit post subreddit icons."""

    def can_handle(self, url: str) -> bool:
        """Check if URL is a Reddit post (but not an embed)."""
        # Must NOT be an embed URL (RedditEmbedStrategy handles those)
        if is_reddit_embed_url(url):
            return False

        post_info = extract_post_info_from_url(url)
        return post_info["subreddit"] is not None

    def create(self, context: HeaderElementContext) -> HeaderElementData | None:
        """Fetch subreddit icon and return header element data."""
        logger.debug(f"RedditPostStrategy: Extracting icon for {context.url}")

        try:
            post_info = extract_post_info_from_url(context.url)
            subreddit = post_info.get("subreddit")

            if not subreddit:
                return None

            # Fetch subreddit icon URL
            icon_url = fetch_subreddit_icon(subreddit, user_id=context.user_id)
            if not icon_url:
                logger.debug(f"RedditPostStrategy: No icon found for r/{subreddit}")
                return None

            # Fetch the icon image
            image_result = fetch_single_image(icon_url)
            if not image_result:
                logger.debug(f"RedditPostStrategy: Failed to fetch icon from {icon_url}")
                return None

            content_hash = store_image_bytes(
                image_result["imageData"],
                image_result["contentType"],
            )

            if not content_hash:
                logger.debug("RedditPostStrategy: Failed to store image")
                return None

            logger.debug("RedditPostStrategy: Successfully extracted and stored icon")
            return HeaderElementData(
                image_bytes=image_result["imageData"],
                content_type=image_result["contentType"],
                content_hash=content_hash,
            )

        except ArticleSkipError:
            raise
        except Exception as e:
            logger.warning(f"RedditPostStrategy: Failed - {e}")
            return None


class YouTubeStrategy(HeaderElementStrategy):
    """Strategy for YouTube video thumbnails."""

    def can_handle(self, url: str) -> bool:
        """Check if URL is a YouTube URL."""
        return extract_youtube_video_id(url) is not None

    def create(self, context: HeaderElementContext) -> HeaderElementData | None:
        """Fetch YouTube thumbnail and return header element data."""
        logger.debug(f"YouTubeStrategy: Fetching thumbnail for {context.url}")

        try:
            video_id = extract_youtube_video_id(context.url)
            if not video_id:
                return None

            # Get thumbnail URL
            thumbnail_url = get_youtube_thumbnail_url(video_id, quality="maxresdefault")

            # Fetch the thumbnail image
            image_result = fetch_single_image(thumbnail_url)
            if not image_result:
                # Try lower quality if maxresdefault fails
                thumbnail_url = get_youtube_thumbnail_url(video_id, quality="hqdefault")
                image_result = fetch_single_image(thumbnail_url)

            if not image_result:
                logger.debug(f"YouTubeStrategy: Failed to fetch thumbnail for {video_id}")
                return None

            content_hash = store_image_bytes(
                image_result["imageData"],
                image_result["contentType"],
            )

            if not content_hash:
                logger.debug("YouTubeStrategy: Failed to store image")
                return None

            logger.debug("YouTubeStrategy: Successfully fetched and stored thumbnail")
            return HeaderElementData(
                image_bytes=image_result["imageData"],
                content_type=image_result["contentType"],
                content_hash=content_hash,
            )

        except Exception as e:
            logger.warning(f"YouTubeStrategy: Failed - {e}")
            return None


class GenericImageStrategy(HeaderElementStrategy):
    """Strategy for extracting images from any URL (fallback)."""

    def can_handle(self, url: str) -> bool:
        """Check if this is any other URL (fallback strategy)."""
        # Skip v.redd.it non-embed URLs (they don't work for image extraction)
        if "v.redd.it" in url and not is_reddit_embed_url(url):
            logger.debug("GenericImageStrategy: Skipping v.redd.it non-embed URL")
            return False

        # Accept all other URLs (fallback)
        return True

    def create(self, context: HeaderElementContext) -> HeaderElementData | None:
        """Extract image using ImageExtractor."""
        logger.debug(f"GenericImageStrategy: Extracting from {context.url}")

        extractor = None
        try:
            extractor = ImageExtractor()
            image_result = extractor.extract_image_from_url(context.url, is_header_image=True)

            if not image_result:
                logger.debug("GenericImageStrategy: No image extracted")
                return None

            content_hash = store_image_bytes(
                image_result["imageData"],
                image_result["contentType"],
                is_header=True,
            )

            if not content_hash:
                logger.debug("GenericImageStrategy: Failed to store image")
                return None

            logger.debug("GenericImageStrategy: Successfully extracted and stored image")
            return HeaderElementData(
                image_bytes=image_result["imageData"],
                content_type=image_result["contentType"],
                content_hash=content_hash,
                image_url=image_result.get("imageUrl"),
            )

        except ArticleSkipError:
            raise
        except Exception as e:
            logger.warning(f"GenericImageStrategy: Failed - {e}")
            return None
