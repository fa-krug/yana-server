"""
Aggregator implementations that don't fit into other categories.
"""

from typing import Any, Dict, List

from bs4 import BeautifulSoup

from .rss import RssAggregator
from .utils import clean_html, format_article_content, sanitize_class_names
from .utils.youtube import proxy_youtube_embeds


class FeedContentAggregator(RssAggregator):
    """
    RSS-Only aggregator.

    Lightweight aggregator that uses content directly from the RSS feed
    without fetching full articles from the web. Ideal for feeds that already
    include full content in their RSS entries.
    """

    def parse_to_raw_articles(self, source_data: Any) -> List[Dict[str, Any]]:
        """
        Parse RSS feed items, extracting full content from feed entries.

        Overrides base implementation to properly extract content from feedparser
        entries, preferring content over summary (matching old TypeScript behavior).
        """
        articles = []
        entries = source_data.get("entries", [])
        limit = self.get_current_run_limit()

        for entry in entries[:limit]:
            # Extract content from feedparser entry
            # feedparser provides content as a list of dicts with 'value' field
            content = ""
            if entry.get("content"):
                # content is a list of dicts: [{"value": "...", "type": "text/html"}, ...]
                content_parts = []
                for content_item in entry.get("content", []):
                    if isinstance(content_item, dict) and "value" in content_item:
                        content_parts.append(content_item["value"])
                    elif isinstance(content_item, str):
                        content_parts.append(content_item)
                content = "".join(content_parts)

            # Fallback to summary if content is empty
            if not content:
                content = entry.get("summary", "")

            # Fallback to description if both are empty
            if not content:
                content = entry.get("description", "")

            article = {
                "name": self._unescape_entities(entry.get("title", "")),
                "identifier": entry.get("link", ""),
                "raw_content": content,  # Store RSS content as raw_content
                "content": content,  # Also store in content for processing
                "summary": entry.get("summary", ""),  # Keep summary for fallback
                "date": self._parse_date(entry.get("published")),
                "author": self._unescape_entities(entry.get("author", "")),
                "icon": None,
            }
            articles.append(article)

        return articles

    def enrich_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Process RSS content directly without fetching from web.

        Uses content from RSS feed entries, processes it through cleaning
        and formatting, but never fetches full articles from URLs.
        """
        enriched = []

        for article in articles:
            # Get content from RSS feed (already populated in parse_to_raw_articles)
            rss_content = article.get("content", "")

            # Fallback to summary if content is empty
            if not rss_content:
                rss_content = article.get("summary", "")

            # Ensure raw_content is set
            if not article.get("raw_content"):
                article["raw_content"] = rss_content

            # Process RSS content (clean and format)
            processed = self.process_content(rss_content, article)
            article["content"] = processed

            enriched.append(article)

        return enriched

    def process_content(self, html: str, article: Dict[str, Any]) -> str:
        """
        Process and format RSS content.

        Cleans HTML, sanitizes class names, and wraps it in a content section.
        """
        if not html:
            return ""

        # Parse HTML
        soup = BeautifulSoup(html, "html.parser")

        # Replace YouTube iframes with click-through facades
        proxy_youtube_embeds(soup)

        # Sanitize class names
        sanitize_class_names(soup)

        # Clean HTML
        cleaned = clean_html(str(soup))

        # Wrap content (no header image for this aggregator)
        formatted = format_article_content(
            cleaned,
            title=article["name"],
            url=article["identifier"],
        )

        return formatted
