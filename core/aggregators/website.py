"""Full website aggregator base class."""

from typing import Any, Dict, List

from bs4 import BeautifulSoup

from .exceptions import ArticleSkipError
from .rss import RssAggregator
from .utils import (
    DEFAULT_CONTENT_SELECTORS,
    clean_html,
    extract_main_content,
    fetch_html,
    format_article_content,
    remove_image_by_url,
    sanitize_class_names,
)
from .utils.youtube import proxy_youtube_embeds


class FullWebsiteAggregator(RssAggregator):
    """Aggregator that extracts full content from article URLs."""

    # CSS selectors to remove from extracted content
    selectors_to_remove: List[str] = [
        "script",
        "style",
        "iframe:not([src*='youtube.com']):not([src*='youtu.be'])",
        "noscript",
        ".advertisement",
        ".ad",
        ".social-share",
    ]

    # Places to look for the main content (override in subclasses)
    content_selectors: List[str] = list(DEFAULT_CONTENT_SELECTORS)

    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """Get configuration fields for FullWebsiteAggregator."""
        from django import forms

        return {
            "use_full_content": forms.BooleanField(
                initial=True,
                label="Fetch Full Content",
                help_text="If enabled, Yana will fetch the article URL and extract the main content. If disabled, only the RSS summary will be used.",
                required=False,
            ),
            "custom_content_selector": forms.CharField(
                initial="",
                label="Custom Content Selector",
                help_text="Override the default CSS selector to find the main content. Example: div.my-article-body",
                required=False,
            ),
            "custom_selectors_to_remove": forms.CharField(
                initial="",
                label="Selectors to Remove",
                help_text="Additional CSS selectors to remove from the content (comma-separated). Example: .ads, .sidebar, #newsletter",
                required=False,
            ),
        }

    def enrich_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Fetch and extract full article content with header elements."""
        enriched = []

        # Check configuration
        use_full_content = self.feed.options.get("use_full_content", True)

        if not use_full_content:
            self.logger.info("Full content extraction disabled via options.")
            return articles

        for article in articles:
            url = article["identifier"]
            self.logger.info(f"Fetching full content from: {url}")

            try:
                # Extract header element FIRST (may throw ArticleSkipError)
                header_data = self.extract_header_element(article)
                if header_data:
                    article["header_data"] = header_data
                    self.logger.debug(f"Extracted header data for {url}")
                else:
                    self.logger.debug(f"No header element found for {url}")

                # Fetch HTML
                raw_html = self.fetch_article_content(url)
                article["raw_content"] = raw_html

                # Extract content
                content = self.extract_content(raw_html, article)

                # Process content (clean, format)
                processed = self.process_content(content, article)

                # Update article
                article["content"] = processed

                enriched.append(article)

            except ArticleSkipError as e:
                # Skip article on 4xx HTTP errors (e.g., from header extraction)
                self.logger.warning(f"Skipping article {url}: {e}")

            except Exception as e:
                self.logger.error(f"Failed to fetch article {url}: {e}")
                # Keep original RSS content without header element
                enriched.append(article)

        return enriched

    def fetch_article_content(self, url: str) -> str:
        """Fetch HTML content from URL."""
        return fetch_html(url, timeout=30)

    def extract_content(self, html: str, article: Dict[str, Any]) -> str:
        """Extract main content from HTML."""
        # Get selectors from options
        content_selectors = (
            self.feed.options.get("custom_content_selector") or self.content_selectors
        )
        if isinstance(content_selectors, str):
            content_selectors = [content_selectors]

        remove_selectors = list(self.selectors_to_remove)
        custom_remove = self.feed.options.get("custom_selectors_to_remove", "")
        if custom_remove:
            # Split comma-separated string and add to list
            additional = [s.strip() for s in custom_remove.split(",") if s.strip()]
            remove_selectors.extend(additional)

        return extract_main_content(
            html, content_selectors=content_selectors, remove_selectors=remove_selectors
        )

    def process_content(self, html: str, article: Dict[str, Any]) -> str:
        """Process and format content."""
        # Parse HTML
        soup = BeautifulSoup(html, "html.parser")

        # Proxy YouTube embeds
        proxy_youtube_embeds(soup)

        # Remove header image from content if it was extracted
        header_data = article.get("header_data")
        if header_data and header_data.image_url:
            self.logger.debug(f"Removing header image from content: {header_data.image_url}")
            remove_image_by_url(soup, header_data.image_url)

        # Sanitize class names
        sanitize_class_names(soup)

        # Clean HTML
        cleaned = clean_html(str(soup))

        # Determine header image URL for formatting
        header_image_url = None
        if header_data:
            header_image_url = header_data.base64_data_uri or header_data.image_url

        # Format with header and footer
        formatted = format_article_content(
            cleaned,
            title=article["name"],
            url=article["identifier"],
            header_image_url=header_image_url,
        )

        return formatted
