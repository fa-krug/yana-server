"""RSS aggregator base class."""

from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Any, Dict, List, Optional

from django.utils import timezone

from .base import BaseAggregator
from .utils import parse_rss_feed


class RssAggregator(BaseAggregator):
    """Base class for RSS-based aggregators."""

    def __init__(self, feed):
        super().__init__(feed)

    def aggregate(self) -> List[Dict[str, Any]]:
        """Implement template method pattern flow."""
        self.validate()
        limit = self.get_current_run_limit()
        if limit == 0:
            return []
        source_data = self.fetch_source_data(limit)
        articles = self.parse_to_raw_articles(source_data)
        articles = self.filter_articles(articles)
        articles = self.enrich_articles(articles)
        articles = self.finalize_articles(articles)
        return articles

    def fetch_source_data(self, limit: Optional[int] = None) -> Dict[str, Any]:
        """Fetch RSS feed data."""
        self.logger.info(f"Fetching RSS feed: {self.identifier}")
        data = parse_rss_feed(self.identifier)

        return data

    def parse_to_raw_articles(self, source_data: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Parse RSS feed items to article dictionaries."""
        articles = []
        entries = source_data.get("entries", [])
        limit = self.get_current_run_limit()

        for entry in entries[:limit]:
            article = {
                "name": entry.get("title", ""),
                "identifier": entry.get("link", ""),
                "raw_content": "",  # To be filled by enrich_articles
                "content": entry.get("summary", ""),
                "date": self._parse_date(entry.get("published")),
                "author": entry.get("author", ""),
                "icon": None,
            }
            articles.append(article)

        return articles

    def _parse_date(self, date_str: Optional[str]) -> datetime:
        """Parse an RSS date string into an aware datetime."""
        if not date_str:
            return timezone.now()
        try:
            parsed = parsedate_to_datetime(date_str)
        except Exception:
            return timezone.now()
        if timezone.is_naive(parsed):
            return timezone.make_aware(parsed)
        return parsed
