"""
Header element extraction orchestrator.

Coordinates multiple header element extraction strategies in a chain of responsibility.
Tries strategies in specific order (RedditEmbed BEFORE RedditPost) until one succeeds.
"""

import logging

from ...exceptions import ArticleSkipError
from ..image_extraction.domain_overrides import get_override_image_url
from ..image_extraction.fetcher import fetch_single_image
from ..image_store import store_image_bytes
from .context import HeaderElementContext, HeaderElementData
from .strategies import (
    GenericImageStrategy,
    HeaderElementStrategy,
    RedditEmbedStrategy,
    RedditPostStrategy,
    YouTubeStrategy,
)

logger = logging.getLogger(__name__)


class HeaderElementExtractor:
    """
    Main orchestrator for header element extraction.

    Uses strategy pattern to try multiple header element extraction methods:
    1. RedditEmbedStrategy - Reddit video embeds (must be BEFORE RedditPostStrategy)
    2. RedditPostStrategy - Reddit subreddit icons
    3. YouTubeStrategy - YouTube video embeds
    4. GenericImageStrategy - Fallback for all other sources

    Strategy order is CRITICAL: RedditEmbedStrategy MUST come before
    RedditPostStrategy to avoid false positives.
    """

    def __init__(self):
        """Initialize extractor with strategies in correct order."""
        # CRITICAL: RedditEmbedStrategy must be BEFORE RedditPostStrategy
        self.strategies: list[HeaderElementStrategy] = [
            RedditEmbedStrategy(),
            RedditPostStrategy(),
            YouTubeStrategy(),
            GenericImageStrategy(),  # Must be last (fallback, accepts all URLs)
        ]

    def extract_header_element(
        self, url: str, alt: str = "Article image", user_id: int | None = None
    ) -> HeaderElementData | None:
        """
        Extract header element from URL using strategy chain.

        Tries strategies in order:
        1. Reddit embed (converted to image)
        2. Reddit post (subreddit icon)
        3. YouTube (thumbnail image)
        4. Generic image extraction

        Args:
            url: URL to extract header element from
            alt: Alt text / title for element
            user_id: Optional user ID for authenticated API calls (e.g. Reddit)

        Returns:
            HeaderElementData containing raw bytes and the stored image's hash, or None if
            extraction fails

        Raises:
            ArticleSkipError: On 4xx HTTP errors (article should be skipped)
        """
        if not url:
            logger.warning("Empty URL provided to extract_header_element")
            return None

        logger.debug(f"HeaderElementExtractor: Starting extraction from {url}")

        override_result = self._build_override_data(url)
        if override_result is not None:
            return override_result

        context = HeaderElementContext(url=url, alt=alt, user_id=user_id)

        # Try each strategy in order
        for strategy in self.strategies:
            strategy_name = strategy.__class__.__name__

            # Check if strategy can handle this URL
            if not strategy.can_handle(url):
                logger.debug(f"HeaderElementExtractor: {strategy_name} cannot handle URL")
                continue

            logger.debug(f"HeaderElementExtractor: Trying {strategy_name}")

            try:
                result = strategy.create(context)

                if result:
                    logger.debug(f"HeaderElementExtractor: Success with {strategy_name}")
                    return result

                # Strategy returned None, try next
                logger.debug(f"HeaderElementExtractor: {strategy_name} returned None")

            except ArticleSkipError as e:
                # Re-raise 4xx errors immediately - skip this article
                logger.warning(
                    f"HeaderElementExtractor: {strategy_name} raised ArticleSkipError: {e}"
                )
                raise

            except Exception as e:
                # Log error and try next strategy
                logger.debug(f"HeaderElementExtractor: {strategy_name} raised exception: {e}")

        # All strategies tried, none succeeded
        logger.debug("HeaderElementExtractor: All strategies failed")
        return None

    @staticmethod
    def _build_override_data(url: str) -> HeaderElementData | None:
        """Return HeaderElementData built from a domain override, or None."""
        override_url = get_override_image_url(url)
        if not override_url:
            return None

        logger.debug(
            f"HeaderElementExtractor: Using domain override image {override_url} for {url}"
        )
        image_result = fetch_single_image(override_url)
        if not image_result:
            logger.warning(
                f"HeaderElementExtractor: Domain override fetch failed for {override_url}, "
                "falling back to normal extraction"
            )
            return None

        content_hash = store_image_bytes(
            image_result["imageData"],
            image_result["contentType"],
            is_header=True,
        )
        if not content_hash:
            logger.warning(f"HeaderElementExtractor: Failed to store override image {override_url}")
            return None

        return HeaderElementData(
            image_bytes=image_result["imageData"],
            content_type=image_result["contentType"],
            content_hash=content_hash,
            image_url=override_url,
        )
