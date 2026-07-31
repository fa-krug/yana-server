from unittest.mock import patch

from django.utils import timezone

import pytest

from core.aggregators.rss import RssAggregator
from core.models import Feed


@pytest.mark.django_db
class TestDailyLimit:
    def test_daily_limit_respects_setting(self):
        # Setup Feed
        feed = Feed.objects.create(
            name="Test Feed", identifier="http://example.com/rss", daily_limit=3
        )

        # Setup Mock Data (10 items)
        mock_entries = [
            {
                "title": f"Item {i}",
                "link": f"http://example.com/{i}",
                "summary": "summary",
                "published": None,
            }
            for i in range(10)
        ]
        mock_feed_data = {"entries": mock_entries}

        # Instantiate Aggregator
        aggregator = RssAggregator(feed)

        # Mock time to middle of day (12:00)
        midday = timezone.now().replace(hour=12, minute=0, second=0, microsecond=0)

        with (
            patch("django.utils.timezone.now", return_value=midday),
            patch("core.models.Article.objects.filter") as mock_filter,
        ):
            mock_filter.return_value.count.return_value = 0

            # Patch parse_rss_feed
            with patch("core.aggregators.rss.parse_rss_feed", return_value=mock_feed_data):
                # Run
                articles = aggregator.aggregate()

        # Target at 12:00 is 50% of 3 = 1.5. ceil(1.5) = 2.
        # But base_allowance is max(1, 3/48) = 1.
        # Proportional allowance is 20% of 3 = 0.
        # Result should be 2.
        assert len(articles) == 2

    def test_daily_limit_larger_than_feed(self):
        # Setup Feed
        feed = Feed.objects.create(
            name="Test Feed", identifier="http://example.com/rss", daily_limit=20
        )

        # Setup Mock Data (5 items)
        mock_entries = [
            {
                "title": f"Item {i}",
                "link": f"http://example.com/{i}",
                "summary": "summary",
                "published": None,
            }
            for i in range(5)
        ]
        mock_feed_data = {"entries": mock_entries}

        # Instantiate Aggregator
        aggregator = RssAggregator(feed)

        # Mock midday
        midday = timezone.now().replace(hour=12, minute=0, second=0, microsecond=0)

        with (
            patch("django.utils.timezone.now", return_value=midday),
            patch("core.aggregators.rss.parse_rss_feed", return_value=mock_feed_data),
        ):
            # Run
            articles = aggregator.aggregate()

        # target = 50% of 20 = 10.
        # proportional = 20% of 20 = 4.
        # limit should be 10.
        assert len(articles) == 5  # Mock data only has 5

    def test_daily_limit_adaptive_morning(self):
        # Setup Feed: 100 daily limit, 0 collected
        feed = Feed.objects.create(
            name="Test Feed", identifier="http://example.com/rss", daily_limit=100
        )
        aggregator = RssAggregator(feed)

        # Mock morning time (8:00 AM)
        morning_time = timezone.now().replace(hour=8, minute=0, second=0, microsecond=0)

        with (
            patch("django.utils.timezone.now", return_value=morning_time),
            patch("core.models.Article.objects.filter") as mock_filter,
        ):
            mock_filter.return_value.count.return_value = 0
            limit = aggregator.get_current_run_limit()

        # Morning (8 AM) before 10 AM -> 40% of remaining (100) = 40
        assert limit == 40

    def test_daily_limit_adaptive_evening(self):
        # Setup Feed: 100 daily limit, 0 collected
        feed = Feed.objects.create(
            name="Test Feed", identifier="http://example.com/rss", daily_limit=100
        )
        aggregator = RssAggregator(feed)

        # Mock evening time (8:00 PM = 20:00)
        evening_time = timezone.now().replace(hour=20, minute=0, second=0, microsecond=0)

        with (
            patch("django.utils.timezone.now", return_value=evening_time),
            patch("core.models.Article.objects.filter") as mock_filter,
        ):
            mock_filter.return_value.count.return_value = 0
            limit = aggregator.get_current_run_limit()

        # Evening (8 PM) -> target_quota = ceil(100 * (20/24)) = 84
        assert limit == 84

    def test_daily_limit_adaptive_evening_mostly_done(self):
        # Setup Feed: 100 daily limit, 90 collected
        feed = Feed.objects.create(
            name="Test Feed", identifier="http://example.com/rss", daily_limit=100
        )
        aggregator = RssAggregator(feed)

        # Mock evening time (8:00 PM = 20:00)
        evening_time = timezone.now().replace(hour=20, minute=0, second=0, microsecond=0)

        with (
            patch("django.utils.timezone.now", return_value=evening_time),
            patch("core.models.Article.objects.filter") as mock_filter,
        ):
            mock_filter.return_value.count.return_value = 90
            limit = aggregator.get_current_run_limit()

        # Evening (8 PM), 90/100 collected
        # target_quota = 84
        # gap_to_target = 0
        # remaining = 10
        # proportional = 20% of 10 = 2
        # base = 100 / 48 = 2
        assert limit == 2
