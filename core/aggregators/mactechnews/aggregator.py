"""MacTechNews aggregator implementation."""

import re
from typing import Any, Dict, List
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from ..utils import (
    clean_html,
    format_article_content,
    remove_image_by_url,
    sanitize_class_names,
)
from ..utils.youtube import proxy_youtube_embeds
from ..website import FullWebsiteAggregator
from .comment_extractor import extract_comments
from .multipage_handler import detect_pagination, fetch_all_pages

# Recurring "TechTicker:" link-roundup posts are noise. Prefix match, case
# sensitive -- mirroring iOS's shouldInclude. A looser `contains` would drop
# legitimate articles that merely mention the word. Heise's title skip-list is
# deliberately the opposite (substring, case-insensitive); do not unify them.
TECHTICKER_TITLE_PREFIX = "TechTicker:"


class MactechnewsAggregator(FullWebsiteAggregator):
    """Aggregator for MacTechNews (mactechnews.de)."""

    brand_site_url = "https://www.mactechnews.de/"

    def __init__(self, feed):
        super().__init__(feed)
        if not self.identifier or self.identifier == "":
            self.identifier = "https://www.mactechnews.de/Rss/News.x"

    def get_source_url(self) -> str:
        return "https://www.mactechnews.de"

    @classmethod
    def resolves_feed_url(cls) -> bool:
        """Fixed-brand scraper: the identifier is its own hardcoded feed URL."""
        return False

    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """Configuration options for MacTechNews aggregator."""
        from django import forms

        return {
            "combine_pages": forms.BooleanField(
                initial=True,
                label="Combine Multi-page Articles",
                help_text="Automatically fetch and combine all pages of a multi-page article.",
                required=False,
            ),
            "include_comments": forms.BooleanField(
                initial=True,
                label="Include Comments",
                help_text="Extract user comments from article pages.",
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

    def filter_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Drop TechTicker link roundups, then apply the base age filter."""
        articles = super().filter_articles(articles)

        kept = []
        for article in articles:
            if article.get("name", "").startswith(TECHTICKER_TITLE_PREFIX):
                self.logger.info(
                    f"[filter_articles] Skipping TechTicker roundup: {article.get('name')}"
                )
                continue
            kept.append(article)

        return kept

    # Multipage articles are combined by fetch_all_pages into sibling
    # .MtnArticle containers (one per page), so every match must be kept --
    # keeping only the first would silently truncate to page 1 after fetching
    # every page over the network. A single-page article has exactly one
    # match, so the union degenerates to the same result.
    uses_first_content_match = False

    # Main content container
    content_selectors = [".MtnArticle"]

    # Selectors to strip
    selectors_to_remove = [
        ".NewsPictureMobile",
        "aside",
        "script",
        "style",
        "iframe",
        "noscript",
        "svg",
        "header",  # Remove article header (title, meta) to avoid duplication
        ".TexticonBox.Right",  # Remove sidebars/summary boxes inside content
    ]

    @staticmethod
    def _extract_mtn_image_id(url: str) -> str | None:
        """Extract numeric image ID from mactechnews image URLs.

        URLs follow the pattern: Name.{numeric_id}.{ext}
        e.g. Cover-Raumakustik.592736.jpg -> 592736
             Bild.592736.jpg -> 592736
        """
        match = re.search(r"\.(\d{5,})\.\w+$", url)
        return match.group(1) if match else None

    def fetch_article_content(self, url: str) -> str:
        """Fetch article content, handling multi-page articles."""
        self.logger.debug(f"[fetch_article_content] Starting for URL: {url}")

        combine_pages = self.feed.options.get("combine_pages", True)

        # Fetch first page
        first_page_html = super().fetch_article_content(url)
        self.logger.debug(
            f"[fetch_article_content] First page fetched ({len(first_page_html)} bytes)"
        )

        if not combine_pages:
            self.logger.info(f"[fetch_article_content] Multi-page combination disabled for {url}")
            return first_page_html

        # Detect pagination
        page_numbers = detect_pagination(first_page_html, self.logger)

        if len(page_numbers) <= 1:
            self.logger.info(f"[fetch_article_content] Single page article for {url}")
            return first_page_html

        # Multi-page article - fetch and combine all pages
        self.logger.info(f"[fetch_article_content] Multi-page article: {len(page_numbers)} pages")

        combined_html = fetch_all_pages(
            base_url=url,
            page_numbers=page_numbers,
            content_selectors=self.content_selectors,
            fetcher=lambda page_url: super(MactechnewsAggregator, self).fetch_article_content(
                page_url
            ),
            logger=self.logger,
            first_page_html=first_page_html,
        )

        self.logger.debug(f"[fetch_article_content] Combined HTML: {len(combined_html)} bytes")
        return combined_html

    def process_content(self, html: str, article: Dict[str, Any]) -> str:
        """Process content with relative URL resolution, header dedup, and comments."""
        soup = BeautifulSoup(html, "html.parser")
        base_url = article["identifier"]

        # Remove content images that duplicate the header image.
        # mactechnews uses the same numeric ID across different image variants
        header_data = article.get("header_data")
        if header_data and header_data.image_url:
            header_image_id = self._extract_mtn_image_id(header_data.image_url)
            if header_image_id:
                for img in soup.find_all("img"):
                    src = img.get("src")
                    if (
                        src
                        and not isinstance(src, list)
                        and self._extract_mtn_image_id(src) == header_image_id
                    ):
                        img.decompose()

        # Resolve relative URLs for images
        for img in soup.find_all("img"):
            src = img.get("src")
            if (
                src
                and not isinstance(src, list)
                and not src.startswith(("http://", "https://", "data:"))
            ):
                img["src"] = urljoin(base_url, str(src))

        # Resolve relative URLs for links
        for a in soup.find_all("a"):
            href = a.get("href")
            if (
                href
                and not isinstance(href, list)
                and not href.startswith(("http://", "https://", "mailto:", "tel:", "#"))
            ):
                a["href"] = urljoin(base_url, str(href))

        # Proxy YouTube embeds
        proxy_youtube_embeds(soup)

        # Remove header image from content if extracted
        if header_data and header_data.image_url:
            remove_image_by_url(soup, header_data.image_url)

        # Sanitize class names
        sanitize_class_names(soup)

        # Clean HTML
        cleaned = clean_html(str(soup))

        # Determine header image URL
        header_image_url = header_data.image_ref if header_data else None

        # Extract comments from the raw (full) HTML
        comments_html = None
        include_comments = self.feed.options.get("include_comments", True)
        max_comments = self.feed.options.get("max_comments", 5)

        if include_comments:
            try:
                raw_html = article.get("raw_content", "")
                if raw_html:
                    comments_html = extract_comments(
                        raw_html,
                        article["identifier"],
                        max_comments=max_comments,
                        logger=self.logger,
                    )
            except Exception as e:
                self.logger.warning(f"[process_content] Failed to extract comments: {e}")

        # Format with header, content, comments, and footer
        formatted = format_article_content(
            cleaned,
            title=article["name"],
            url=article["identifier"],
            header_image_url=header_image_url,
            comments_content=comments_html,
        )

        return formatted
