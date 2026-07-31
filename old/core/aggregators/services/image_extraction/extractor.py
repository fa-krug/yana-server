"""
Image extraction orchestrator.

Coordinates multiple image extraction strategies in a chain of responsibility pattern.
Uses BeautifulSoup for HTML parsing (no browser automation).
"""

import logging
from typing import Any, Dict, Optional

import requests
from bs4 import BeautifulSoup

from ...exceptions import ArticleSkipError
from .domain_overrides import get_override_image_url
from .fetcher import fetch_single_image
from .strategies import (
    DirectImageStrategy,
    ImageExtractionContext,
    MetaTagImageStrategy,
    PageImagesStrategy,
    TwitterImageStrategy,
    YouTubeThumbnailStrategy,
)

logger = logging.getLogger(__name__)


class ImageExtractor:
    """
    Main orchestrator for image extraction.

    Uses strategy pattern to try multiple image extraction methods:
    1. Direct image URLs (fast, no network)
    2. YouTube thumbnails (fast, specific domain)
    3. Twitter images (requires API call)
    4. Meta tags (og:image, twitter:image)
    5. Page images (first large image)

    All strategies use BeautifulSoup for HTML parsing (no browser automation).
    """

    def __init__(self):
        """Initialize extractor with strategies."""
        # All strategies in order
        self.strategies = [
            DirectImageStrategy(),
            YouTubeThumbnailStrategy(),
            TwitterImageStrategy(),
            MetaTagImageStrategy(),
            PageImagesStrategy(),
        ]

    def extract_image_from_url(
        self, url: str, is_header_image: bool = False
    ) -> Optional[Dict[str, Any]]:
        """
        Extract image from URL using strategy chain.

        Tries strategies in order:
        1. Direct image URLs
        2. YouTube thumbnails
        3. Twitter images
        4. Meta tags (og:image, twitter:image)
        5. Page images (first large image on page)

        Args:
            url: URL to extract image from
            is_header_image: Whether this is for a header (affects size validation)

        Returns:
            Dict with imageData and contentType, or None if extraction fails

        Raises:
            ArticleSkipError: On 4xx HTTP errors (article should be skipped)
        """
        if not url:
            logger.warning("Empty URL provided to extract_image_from_url")
            return None

        logger.debug(f"ImageExtractor: Starting extraction from {url}")

        override_url = get_override_image_url(url)
        if override_url:
            logger.debug(f"ImageExtractor: Using domain override image {override_url} for {url}")
            override_result = fetch_single_image(override_url)
            if override_result:
                override_result["imageUrl"] = override_url
                return override_result
            logger.warning(
                f"ImageExtractor: Domain override fetch failed for {override_url}, "
                "falling back to normal extraction"
            )

        context = ImageExtractionContext(url=url, is_header_image=is_header_image)

        # Try strategies that don't require HTML first
        for strategy in self.strategies[:3]:  # Direct, YouTube, Twitter
            if not strategy.can_handle(context):
                continue

            logger.debug(f"ImageExtractor: Trying {strategy.__class__.__name__}")
            try:
                result = strategy.extract(context)
                if result:
                    logger.debug(f"ImageExtractor: Success with {strategy.__class__.__name__}")
                    return result
            except ArticleSkipError:
                raise
            except Exception as e:
                logger.debug(f"ImageExtractor: {strategy.__class__.__name__} failed: {e}")

        # If simple strategies fail, parse page for meta tags and images
        logger.debug("ImageExtractor: Simple strategies failed, parsing page...")

        try:
            # Fetch and parse page
            context.soup = self._fetch_and_parse_page(url)
            if not context.soup:
                logger.debug("ImageExtractor: Failed to fetch/parse page")
                return None

        except ArticleSkipError:
            raise
        except Exception as e:
            logger.warning(f"ImageExtractor: Failed to fetch page: {e}")
            return None

        # Try HTML-based strategies with parsed soup
        for strategy in self.strategies[3:]:  # MetaTag, PageImages
            if not strategy.can_handle(context):
                continue

            logger.debug(f"ImageExtractor: Trying {strategy.__class__.__name__}")
            try:
                result = strategy.extract(context)
                if result:
                    logger.debug(f"ImageExtractor: Success with {strategy.__class__.__name__}")
                    return result
            except ArticleSkipError:
                raise
            except Exception as e:
                logger.debug(f"ImageExtractor: {strategy.__class__.__name__} failed: {e}")

        logger.debug("ImageExtractor: All strategies failed")
        return None

    @staticmethod
    def _fetch_and_parse_page(url: str) -> Optional[BeautifulSoup]:
        """
        Fetch and parse page HTML using requests + BeautifulSoup.

        Args:
            url: URL to fetch

        Returns:
            BeautifulSoup object, or None if fetch fails
        """
        try:
            # Set headers for HTTP request
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            }

            response = requests.get(url, headers=headers, timeout=10, allow_redirects=True)
            response.raise_for_status()

            # Parse with BeautifulSoup
            soup = BeautifulSoup(response.content, "html.parser")
            logger.debug(f"ImageExtractor: Successfully fetched and parsed {url}")
            return soup

        except requests.exceptions.HTTPError as e:
            if 400 <= e.response.status_code < 500:
                raise ArticleSkipError(
                    f"4xx error fetching page: {e.response.status_code}",
                    status_code=e.response.status_code,
                    original_error=e,
                ) from e
            logger.warning(f"HTTP error fetching page: {e.response.status_code}")
            return None
        except requests.exceptions.RequestException as e:
            logger.warning(f"Error fetching page: {e}")
            return None
