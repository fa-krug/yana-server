"""Article date semantics: real publish times, never import times."""

from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

from django.utils import timezone

import pytest

from core.aggregators.rss import RssAggregator
from core.models import Article


@pytest.fixture
def agg(rss_feed):
    aggregator = RssAggregator(rss_feed)
    aggregator.logger = MagicMock()
    return aggregator


@pytest.mark.django_db
class TestFilterArticlesPreservesDates:
    def test_recent_article_keeps_its_exact_date(self, agg):
        published = timezone.now() - timedelta(days=3)

        filtered = agg.filter_articles([{"name": "Recent", "date": published}])

        assert len(filtered) == 1
        assert filtered[0]["date"] == published

    def test_old_article_is_filtered_out(self, agg):
        filtered = agg.filter_articles(
            [{"name": "Ancient", "date": timezone.now() - timedelta(days=90)}]
        )

        assert filtered == []

    def test_filter_articles_never_mutates_the_date(self, agg):
        """Regression guard: this is the behavior most likely to be reintroduced."""
        published = timezone.now() - timedelta(days=10)
        articles = [{"name": "A", "date": published}, {"name": "B", "date": published}]

        agg.filter_articles(articles)

        assert [article["date"] for article in articles] == [published, published]

    def test_naive_dates_are_made_aware_without_shifting_the_instant(self, agg):
        naive = datetime(2026, 7, 20, 12, 30, 0)

        filtered = agg.filter_articles([{"name": "Naive", "date": naive}])

        assert timezone.is_aware(filtered[0]["date"])
        assert filtered[0]["date"] == timezone.make_aware(naive)

    def test_missing_date_is_left_alone(self, agg):
        filtered = agg.filter_articles([{"name": "No date", "date": None}])

        assert len(filtered) == 1
        assert filtered[0]["date"] is None


class TestRssDateParsing:
    def test_rfc822_date_with_offset_is_preserved(self, agg):
        parsed = agg._parse_date("Mon, 20 Jul 2026 12:30:00 +0200")

        assert timezone.is_aware(parsed)
        assert parsed.hour == 12
        assert parsed.utcoffset() == timedelta(hours=2)

    def test_date_without_timezone_becomes_aware(self, agg, settings):
        # Force a non-UTC server zone so the assertion can't pass by accident
        # of the test environment's default TIME_ZONE.
        settings.TIME_ZONE = "Europe/Berlin"

        parsed = agg._parse_date("Mon, 20 Jul 2026 12:30:00")

        assert timezone.is_aware(parsed)
        # RFC 5322 gives no basis for assuming any particular zone -- the
        # server's local TIME_ZONE must not silently shift the instant.
        assert parsed.utcoffset() == timedelta(0)

    def test_dash_zero_offset_means_utc_unknown_zone_not_server_local(self, agg, settings):
        """RFC 5322: "-0000" means UTC, local zone unknown -- never the
        server's TIME_ZONE."""
        settings.TIME_ZONE = "Europe/Berlin"

        parsed = agg._parse_date("Mon, 20 Jul 2026 12:30:00 -0000")

        assert timezone.is_aware(parsed)
        assert parsed.utcoffset() == timedelta(0)
        assert parsed.hour == 12

    def test_missing_and_unparseable_dates_fall_back_to_aware_now(self, agg):
        for value in (None, "not a date"):
            parsed = agg._parse_date(value)
            assert timezone.is_aware(parsed)


@pytest.mark.django_db
class TestPersistedDates:
    def test_service_saves_the_real_publish_date(self, rss_feed):
        from core.services.aggregator_service import AggregatorService

        published = timezone.now() - timedelta(days=5)
        with patch("core.services.aggregator_service.get_aggregator") as get_agg:
            get_agg.return_value.aggregate.return_value = [
                {
                    "name": "Real date",
                    "identifier": "https://example.com/a",
                    "raw_content": "raw",
                    "content": "content",
                    "date": published,
                    "author": "",
                }
            ]

            AggregatorService.trigger_by_feed_id(rss_feed.id)

        article = Article.objects.get(identifier="https://example.com/a")
        assert article.date == published

    def test_missing_date_falls_back_to_now(self, rss_feed):
        from core.services.aggregator_service import AggregatorService

        with patch("core.services.aggregator_service.get_aggregator") as get_agg:
            get_agg.return_value.aggregate.return_value = [
                {
                    "name": "No date",
                    "identifier": "https://example.com/b",
                    "raw_content": "raw",
                    "content": "content",
                    "date": None,
                    "author": "",
                }
            ]

            AggregatorService.trigger_by_feed_id(rss_feed.id)

        article = Article.objects.get(identifier="https://example.com/b")
        assert article.date is not None

    def test_two_articles_published_in_the_same_second_both_persist(self, rss_feed):
        published = timezone.now() - timedelta(days=1)
        Article.objects.create(
            feed=rss_feed, name="One", identifier="u1", raw_content="", content="", date=published
        )
        Article.objects.create(
            feed=rss_feed, name="Two", identifier="u2", raw_content="", content="", date=published
        )

        ordered = list(
            Article.objects.filter(feed=rss_feed)
            .order_by("-created_at", "-id")
            .values_list("name", flat=True)
        )

        assert ordered == ["Two", "One"]
