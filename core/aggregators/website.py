"""Full website aggregator base class."""

from typing import Any, Dict, List

from bs4 import BeautifulSoup

from .exceptions import ArticleSkipError
from .rss import RssAggregator
from .utils import (
    DEFAULT_CONTENT_SELECTORS,
    DEFAULT_IGNORE_SELECTORS,
    IFRAME_SANITIZE_SELECTOR,
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

    # Scraper-specific removals, always applied on top of the feed's
    # ignore_selectors (so a feed option cannot disable them). script/style/
    # noscript/template are handled by the extractor and are not listed here;
    # the iframe rule stays here because scrapers such as Caschy's Blog widen it.
    selectors_to_remove: List[str] = [IFRAME_SANITIZE_SELECTOR]

    # Places to look for the main content (override in subclasses)
    content_selectors: List[str] = list(DEFAULT_CONTENT_SELECTORS)

    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """Get configuration fields for FullWebsiteAggregator."""
        from .form_fields import SelectorListField

        return {
            "content_selectors": SelectorListField(
                label="Content Selectors",
                help_text=(
                    "Comma-separated CSS selectors for the article body. Every match is "
                    "combined, so a body split across containers stays complete. Leave blank "
                    "for the defaults: " + ", ".join(DEFAULT_CONTENT_SELECTORS)
                ),
                required=False,
            ),
            "ignore_selectors": SelectorListField(
                label="Ignore Selectors",
                help_text=(
                    "Comma-separated CSS selectors to remove from the content. Leave blank "
                    "for the defaults: " + ", ".join(DEFAULT_IGNORE_SELECTORS)
                ),
                required=False,
            ),
        }

    def enrich_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Fetch and extract full article content with header elements."""
        enriched = []

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

    def get_content_selectors(self) -> List[str]:
        """Resolve the content selectors: feed option if set, else the class default."""
        options = self.feed.options or {}
        if "content_selectors" in options:
            return self._clean_selector_list(options["content_selectors"])
        return list(self.content_selectors)

    def get_ignore_selectors(self) -> List[str]:
        """Resolve removals: the class list plus the feed option (or the shared defaults)."""
        options = self.feed.options or {}
        if "ignore_selectors" in options:
            configured = self._clean_selector_list(options["ignore_selectors"])
        else:
            configured = list(DEFAULT_IGNORE_SELECTORS)
        return list(self.selectors_to_remove) + configured

    @staticmethod
    def _clean_selector_list(value: Any) -> List[str]:
        """Normalize a stored option value into a list of non-empty selectors."""
        if isinstance(value, str):
            parts = value.split(",")
        elif isinstance(value, (list, tuple)):
            parts = [str(item) for item in value]
        else:
            return []
        return [part.strip() for part in parts if part.strip()]

    def extract_content(self, html: str, article: Dict[str, Any]) -> str:
        """Extract main content from HTML."""
        return extract_main_content(
            html,
            content_selectors=self.get_content_selectors(),
            remove_selectors=self.get_ignore_selectors(),
            first_match_only=self.uses_first_content_match,
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
