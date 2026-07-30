"""Mein-MMO aggregator implementation."""

from typing import Any, Dict, List, Optional, Tuple

from ..utils import clean_html, format_article_content, remove_image_by_url
from ..utils.youtube import proxy_youtube_embeds
from ..website import FullWebsiteAggregator
from .comment_extractor import extract_comments
from .content_extraction import extract_mein_mmo_content
from .multipage_handler import detect_pagination, fetch_all_pages


class MeinMmoAggregator(FullWebsiteAggregator):
    """Specialized aggregator for Mein-MMO.de gaming news."""

    MEIN_MMO_URL = "https://mein-mmo.de/"

    def __init__(self, feed):
        super().__init__(feed)
        # Comment source: fetch_all_pages returns only the combined
        # entry-content blocks, so the multi-page raw_content has no thread.
        self._first_page_html: Optional[str] = None
        # Use Mein-MMO RSS feed if identifier is not set
        if not self.identifier or self.identifier == "":
            self.identifier = "https://mein-mmo.de/feed/"

    def get_source_url(self) -> str:
        """Return the Mein-MMO website URL."""
        return self.MEIN_MMO_URL

    @classmethod
    def get_identifier_choices(
        cls, query: Optional[str] = None, user: Optional[Any] = None
    ) -> List[Tuple[str, str]]:
        """Get available Mein-MMO RSS feed choices."""
        return [
            ("https://mein-mmo.de/feed/", "Main Feed (All Articles)"),
        ]

    @classmethod
    def get_default_identifier(cls) -> str:
        """Get default Mein-MMO identifier."""
        return "https://mein-mmo.de/feed/"

    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """Get Mein-MMO configuration fields."""
        from django import forms

        return {
            "combine_pages": forms.BooleanField(
                initial=True,
                label="Combine Multi-page Articles",
                help_text="Automatically fetch and combine all pages of a multi-page article into one.",
                required=False,
            ),
            "include_comments": forms.BooleanField(
                initial=True,
                label="Include Comments",
                help_text="Extract wpDiscuz reader comments from the article page.",
                required=False,
            ),
            "max_comments": forms.IntegerField(
                initial=5,
                label="Max Comments",
                help_text="Maximum number of comments to extract per article.",
                required=False,
                min_value=0,
                max_value=20,
            ),
        }

    # Body lives in one known container -- keep the first match, never union.
    uses_first_content_match = True

    # Mein-MMO specific selectors
    content_selectors = ["div.entry-content"]

    selectors_to_remove = [
        "div.wp-block-mmo-recirculation-box",
        "div.wp-block-mmo-hub-box",
        "div.reading-position-indicator-end",
        "label.toggle",
        "a.wp-block-mmo-content-box",
        "div.page-links",
        "div.sources-wrapper",
        "div.feedback-box",
        "div.wp-block-wbd-affiliate-widget",
        "script",
        "style",
        "iframe:not([src*='youtube.com']):not([src*='youtu.be'])",
        "noscript",
        ".dailymotion-embed-container",
    ]

    def fetch_article_content(self, url: str) -> str:
        """
        Fetch article content, handling multi-page articles.
        """
        self.logger.debug(f"[fetch_article_content] Starting for URL: {url}")

        # Check configuration
        combine_pages = self.feed.options.get("combine_pages", True)

        # Fetch first page to detect pagination
        self.logger.debug("[fetch_article_content] Fetching first page")
        first_page_html = super().fetch_article_content(url)
        self._first_page_html = first_page_html
        self.logger.debug(
            f"[fetch_article_content] First page fetched ({len(first_page_html)} bytes)"
        )

        if not combine_pages:
            self.logger.info(f"[fetch_article_content] Multi-page combination disabled for {url}")
            return first_page_html

        # Check if multi-page
        self.logger.debug("[fetch_article_content] Detecting pagination")
        page_numbers = detect_pagination(first_page_html, self.logger)

        if len(page_numbers) <= 1:
            # Single page article
            self.logger.info(f"[fetch_article_content] Single page article detected for {url}")
            return first_page_html

        # Multi-page article - fetch all pages
        self.logger.info(
            f"[fetch_article_content] Multi-page article detected: {len(page_numbers)} pages"
        )

        combined_html = fetch_all_pages(
            base_url=url,
            page_numbers=page_numbers,
            fetcher=lambda page_url: super(MeinMmoAggregator, self).fetch_article_content(page_url),
            logger=self.logger,
            first_page_html=first_page_html,
        )

        self.logger.debug(
            f"[fetch_article_content] Returning combined HTML ({len(combined_html)} bytes)"
        )
        return combined_html

    def extract_content(self, html: str, article: Dict[str, Any]) -> str:
        """Extract Mein-MMO specific content."""
        self.logger.debug(f"[extract_content] Starting for {article.get('identifier')}")
        result = extract_mein_mmo_content(
            html=html,
            article=article,
            selectors_to_remove=self.selectors_to_remove,
            logger=self.logger,
        )
        self.logger.debug(f"[extract_content] Completed, result size: {len(result)} bytes")
        return result

    def process_content(self, html: str, article: Dict[str, Any]) -> str:
        """Process Mein-MMO content with header image extraction."""
        self.logger.debug(f"[process_content] Starting for {article.get('identifier')}")

        from bs4 import BeautifulSoup

        # Parse HTML for processing
        soup = BeautifulSoup(html, "html.parser")

        # Proxy YouTube embeds
        proxy_youtube_embeds(soup)

        # Remove header image from content if it was extracted
        header_data = article.get("header_data")
        if header_data and header_data.image_url:
            self.logger.debug(
                f"[process_content] Removing header image from content: {header_data.image_url}"
            )
            remove_image_by_url(soup, header_data.image_url)

        # Convert back to string for cleaning
        html = str(soup)

        # Clean HTML
        self.logger.debug("[process_content] Cleaning HTML")
        cleaned = clean_html(html)

        # Determine header image URL for formatting
        header_image_url = header_data.image_ref if header_data else None

        # wpDiscuz comments live on the article page outside the content div.
        comments_html = None
        include_comments = self.feed.options.get("include_comments", True)
        max_comments = self.feed.options.get("max_comments", 5)

        if include_comments:
            try:
                comment_source = self._first_page_html or article.get("raw_content", "")
                if comment_source:
                    comments_html = extract_comments(
                        comment_source,
                        article["identifier"],
                        max_comments=max_comments,
                        logger=self.logger,
                    )
            except Exception as e:
                self.logger.warning(f"[process_content] Failed to extract comments: {e}")

        # Format with header (image only), comments, and footer
        self.logger.debug("[process_content] Formatting content with header image only")
        formatted = format_article_content(
            cleaned,
            title=article["name"],
            url=article["identifier"],
            header_image_url=header_image_url,
            comments_content=comments_html,
        )

        self.logger.info(f"[process_content] Completed, formatted size: {len(formatted)} bytes")
        return formatted
