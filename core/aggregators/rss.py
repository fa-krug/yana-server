"""RSS aggregator base class."""

from datetime import datetime
from datetime import timezone as dt_timezone
from email.utils import parsedate_to_datetime
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from django.utils import timezone

from .base import BaseAggregator
from .utils import discover_feed_url, parse_rss_feed


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
        """Fetch RSS feed data, following a homepage to its advertised feed.

        ``parse_rss_feed`` raises ``ValueError`` both when the identifier is not
        a feed and when it yields zero entries. Either way, if the identifier
        looks like a page URL, try the feed the page advertises. Best-effort: an
        identifier with no discoverable feed re-raises the original error, so the
        outcome stays the existing "no entries" one rather than a new error class.
        """
        self.logger.info(f"Fetching RSS feed: {self.identifier}")
        try:
            return parse_rss_feed(self.identifier)
        except ValueError:
            parsed = urlparse(self.identifier or "")
            if not parsed.scheme or not parsed.netloc:
                raise

            discovered = discover_feed_url(self.identifier)
            if not discovered or discovered == self.identifier:
                raise

            self.logger.info(f"Discovered feed for {self.identifier}: {discovered}")
            return parse_rss_feed(discovered)

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
        """Parse an RSS date string into an aware datetime.

        ``parsedate_to_datetime`` returns a naive datetime both when the
        source has no timezone at all and for the RFC 5322 "-0000" offset
        ("UTC, local zone unknown"). Either way there is no basis for
        assuming the server's local ``TIME_ZONE`` -- attach UTC instead, so
        the instant is not silently shifted by whatever zone the server
        happens to run in.
        """
        if not date_str:
            return timezone.now()
        try:
            parsed = parsedate_to_datetime(date_str)
        except Exception:
            return timezone.now()
        if timezone.is_naive(parsed):
            return parsed.replace(tzinfo=dt_timezone.utc)
        return parsed
