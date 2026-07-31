"""
Image extraction strategies using Strategy Pattern.

Provides strategies for extracting images from different sources:
1. DirectImageStrategy - Direct image URLs (.jpg, .png, etc.)
2. YouTubeThumbnailStrategy - YouTube video thumbnails
3. TwitterImageStrategy - Twitter/X post images (via fxtwitter API)
4. MetaTagImageStrategy - Open Graph / Twitter meta tags
5. PageImagesStrategy - First large image on page
"""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from bs4 import BeautifulSoup, Tag

from ...exceptions import ArticleSkipError
from ...utils import get_attr_str
from ...utils.twitter import extract_tweet_id, fetch_tweet_data, get_first_tweet_image
from ...utils.youtube import extract_youtube_video_id, get_youtube_thumbnail_url
from .fetcher import fetch_single_image

logger = logging.getLogger(__name__)


@dataclass
class ImageExtractionContext:
    """Context for image extraction strategies."""

    url: str  # Source URL
    is_header_image: bool = False  # Whether this is for a header (affects size validation)
    soup: Optional[BeautifulSoup] = None  # Parsed HTML (for meta tag / page strategies)


class ImageStrategy(ABC):
    """Base class for image extraction strategies."""

    @abstractmethod
    def can_handle(self, context: ImageExtractionContext) -> bool:
        """Check if this strategy can handle the URL/context."""
        pass

    @abstractmethod
    def extract(self, context: ImageExtractionContext) -> Optional[Dict[str, Any]]:
        """
        Extract image from context.

        Returns:
            Dict with keys:
                - imageData: bytes
                - contentType: str (MIME type)
            Returns None if extraction fails
        """
        pass


class DirectImageStrategy(ImageStrategy):
    """Strategy for direct image URLs (.jpg, .png, .gif, .webp, etc.)."""

    IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".ico"}

    def can_handle(self, context: ImageExtractionContext) -> bool:
        """Check if URL ends with image extension."""
        try:
            path = urlparse(context.url).path.lower()
            return any(path.endswith(ext) for ext in self.IMAGE_EXTENSIONS)
        except Exception:
            return False

    def extract(self, context: ImageExtractionContext) -> Optional[Dict[str, Any]]:
        """Fetch direct image URL."""
        logger.debug(f"DirectImageStrategy: Attempting to fetch {context.url}")

        try:
            result = fetch_single_image(context.url)
            if result:
                logger.debug("DirectImageStrategy: Successfully extracted image")
                result["imageUrl"] = context.url
            return result
        except ArticleSkipError:
            raise  # Re-raise 4xx errors
        except Exception as e:
            logger.debug(f"DirectImageStrategy: Failed - {e}")
            return None


class YouTubeThumbnailStrategy(ImageStrategy):
    """Strategy for YouTube video thumbnails."""

    def can_handle(self, context: ImageExtractionContext) -> bool:
        """Check if URL is a YouTube URL."""
        return extract_youtube_video_id(context.url) is not None

    def extract(self, context: ImageExtractionContext) -> Optional[Dict[str, Any]]:
        """Fetch YouTube thumbnail."""
        logger.debug(f"YouTubeThumbnailStrategy: Attempting to extract from {context.url}")

        try:
            video_id = extract_youtube_video_id(context.url)
            if not video_id:
                return None

            # Try maxresdefault first, fallback to hqdefault
            for quality in ["maxresdefault", "hqdefault"]:
                thumbnail_url = get_youtube_thumbnail_url(video_id, quality)

                result = fetch_single_image(thumbnail_url)
                if result:
                    logger.debug(
                        f"YouTubeThumbnailStrategy: Found thumbnail with quality {quality}"
                    )
                    result["imageUrl"] = thumbnail_url
                    return result

            logger.debug("YouTubeThumbnailStrategy: No thumbnail found")
            return None

        except ArticleSkipError:
            raise
        except Exception as e:
            logger.debug(f"YouTubeThumbnailStrategy: Failed - {e}")
            return None


class TwitterImageStrategy(ImageStrategy):
    """Strategy for Twitter/X post images via fxtwitter API."""

    def can_handle(self, context: ImageExtractionContext) -> bool:
        """Check if URL is a Twitter/X URL."""
        if not context.url:
            return False

        twitter_domains = ["twitter.com", "x.com", "mobile.twitter.com"]
        return any(domain in context.url for domain in twitter_domains)

    def extract(self, context: ImageExtractionContext) -> Optional[Dict[str, Any]]:
        """Fetch image from Twitter post via fxtwitter API."""
        logger.debug(f"TwitterImageStrategy: Attempting to extract from {context.url}")

        try:
            tweet_id = extract_tweet_id(context.url)
            if not tweet_id:
                logger.debug("TwitterImageStrategy: No tweet ID found")
                return None

            # Fetch tweet data from fxtwitter API
            tweet_data = fetch_tweet_data(tweet_id)
            if not tweet_data:
                logger.debug("TwitterImageStrategy: Failed to fetch tweet data")
                return None

            # Extract first image from tweet
            image_url = get_first_tweet_image(tweet_data)
            if not image_url:
                logger.debug("TwitterImageStrategy: No images in tweet")
                return None

            # Fetch the image
            result = fetch_single_image(image_url)
            if result:
                logger.debug("TwitterImageStrategy: Successfully extracted image")
                result["imageUrl"] = image_url
                return result

            logger.debug("TwitterImageStrategy: Failed to fetch image from URL")
            return None

        except ArticleSkipError:
            raise
        except Exception as e:
            logger.debug(f"TwitterImageStrategy: Failed - {e}")
            return None


class MetaTagImageStrategy(ImageStrategy):
    """Strategy for og:image and twitter:image meta tags."""

    def can_handle(self, context: ImageExtractionContext) -> bool:
        """Check if we have parsed HTML (soup)."""
        return context.soup is not None

    def extract(self, context: ImageExtractionContext) -> Optional[Dict[str, Any]]:
        """Extract image from meta tags."""
        logger.debug(f"MetaTagImageStrategy: Extracting from {context.url}")

        if not context.soup:
            return None

        try:
            image_url = None

            # Try og:image first
            og_image = context.soup.select_one('meta[property="og:image"]')
            if isinstance(og_image, Tag):
                content = get_attr_str(og_image, "content")
                if content:
                    image_url = content
                    logger.debug("MetaTagImageStrategy: Found og:image")

            # Fallback to twitter:image
            if not image_url:
                twitter_image = context.soup.select_one('meta[name="twitter:image"]')
                if isinstance(twitter_image, Tag):
                    content = get_attr_str(twitter_image, "content")
                    if content:
                        image_url = content
                        logger.debug("MetaTagImageStrategy: Found twitter:image")

            if not image_url:
                logger.debug("MetaTagImageStrategy: No meta tag images found")
                return None

            # Resolve relative URLs
            image_url = self._resolve_url(image_url, context.url)

            # Fetch the image
            result = fetch_single_image(image_url)
            if result:
                logger.debug("MetaTagImageStrategy: Successfully extracted image")
                result["imageUrl"] = image_url
                return result

            logger.debug("MetaTagImageStrategy: Failed to fetch image")
            return None

        except ArticleSkipError:
            raise
        except Exception as e:
            logger.debug(f"MetaTagImageStrategy: Failed - {e}")
            return None

    @staticmethod
    def _resolve_url(relative_url: str, base_url: str) -> str:
        """Resolve relative URL against base URL."""
        if relative_url.startswith("http"):
            return relative_url

        try:
            parsed_base = urlparse(base_url)
            base_domain = f"{parsed_base.scheme}://{parsed_base.netloc}"

            if relative_url.startswith("/"):
                return base_domain + relative_url
            else:
                base_path = "/".join(parsed_base.path.split("/")[:-1])
                return f"{base_domain}{base_path}/{relative_url}"
        except Exception:
            return relative_url


class PageImagesStrategy(ImageStrategy):
    """Strategy for finding the first large image on a page."""

    MIN_IMAGE_SIZE = 100  # Minimum 100x50
    MIN_HEADER_IMAGE_SIZE = 200  # Minimum 200x200 for header

    def can_handle(self, context: ImageExtractionContext) -> bool:
        """Check if we have parsed HTML."""
        return context.soup is not None

    def extract(self, context: ImageExtractionContext) -> Optional[Dict[str, Any]]:
        """Find and extract first large image from page."""
        logger.debug(f"PageImagesStrategy: Extracting from {context.url}")

        if not context.soup:
            return None

        try:
            # Find all img elements
            img_elements = context.soup.find_all("img", limit=20)

            if not img_elements:
                logger.debug("PageImagesStrategy: No images found")
                return None

            # Try each image
            for img in img_elements:
                if not isinstance(img, Tag):
                    continue

                img_url = (
                    get_attr_str(img, "src")
                    or get_attr_str(img, "data-src")
                    or get_attr_str(img, "data-lazy-src")
                )
                if not img_url:
                    continue

                # Resolve relative URLs
                img_url = self._resolve_url(img_url, context.url)

                # Check dimensions from HTML attributes
                width = self._get_dimension(get_attr_str(img, "width"))
                height = self._get_dimension(get_attr_str(img, "height"))

                min_size = (
                    self.MIN_HEADER_IMAGE_SIZE if context.is_header_image else self.MIN_IMAGE_SIZE
                )

                # Skip if dimensions too small
                if width and height and (width < min_size or height < min_size):
                    logger.debug(f"PageImagesStrategy: Skipping image {width}x{height} (too small)")
                    continue

                # Fetch the image
                try:
                    result = fetch_single_image(img_url)
                    if result:
                        logger.debug(f"PageImagesStrategy: Found image {img_url}")
                        result["imageUrl"] = img_url
                        return result
                except ArticleSkipError:
                    raise
                except Exception as e:
                    logger.debug(f"PageImagesStrategy: Failed to fetch {img_url} - {e}")
                    continue

            logger.debug("PageImagesStrategy: No suitable images found")
            return None

        except Exception as e:
            logger.debug(f"PageImagesStrategy: Failed - {e}")
            return None

    @staticmethod
    def _resolve_url(relative_url: str, base_url: str) -> str:
        """Resolve relative URL against base URL."""
        if relative_url.startswith("http"):
            return relative_url

        try:
            parsed_base = urlparse(base_url)
            base_domain = f"{parsed_base.scheme}://{parsed_base.netloc}"

            if relative_url.startswith("/"):
                return base_domain + relative_url
            elif relative_url.startswith("//"):
                return f"{parsed_base.scheme}:{relative_url}"
            else:
                base_path = "/".join(parsed_base.path.split("/")[:-1])
                return f"{base_domain}{base_path}/{relative_url}"
        except Exception:
            return relative_url

    @staticmethod
    def _get_dimension(value: Optional[str]) -> Optional[int]:
        """Extract numeric dimension from HTML attribute."""
        if not value:
            return None

        try:
            # Remove 'px' or other units
            value_str = str(value).replace("px", "").strip()
            return int(value_str)
        except (ValueError, AttributeError):
            return None
