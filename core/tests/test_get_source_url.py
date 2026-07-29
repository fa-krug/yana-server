"""Tests for BaseAggregator.get_source_url() and its overrides.

get_source_url() lost all coverage when the Google Reader API was removed:
core/services/greader/stream_format.py was the only production caller, and
test_greader_subscription.py was what exercised it. The method is kept for a
future tailored API, so it needs its own direct tests now.
"""

import pytest

from core.aggregators.heise import HeiseAggregator
from core.aggregators.implementations import FeedContentAggregator
from core.aggregators.mein_mmo import MeinMmoAggregator
from core.aggregators.merkur import MerkurAggregator
from core.aggregators.oglaf import OglafAggregator
from core.aggregators.reddit import RedditAggregator
from core.models import Feed


@pytest.mark.django_db
class TestBaseAggregatorDefaultSourceUrl:
    """BaseAggregator.get_source_url() defaults to the feed identifier."""

    def test_returns_feed_identifier(self, rss_feed):
        aggregator = FeedContentAggregator(rss_feed)
        assert aggregator.get_source_url() == "https://example.com/rss"

    def test_returns_empty_string_when_identifier_is_blank(self, user, feed_group):
        feed = Feed.objects.create(
            name="Blank Identifier Feed",
            aggregator="feed_content",
            identifier="",
            user=user,
            group=feed_group,
        )
        aggregator = FeedContentAggregator(feed)
        assert aggregator.get_source_url() == ""


@pytest.mark.django_db
class TestRedditGetSourceUrl:
    """RedditAggregator normalizes the subreddit identifier into a full URL."""

    @pytest.mark.parametrize(
        "identifier,expected",
        [
            ("python", "https://www.reddit.com/r/python"),
            ("r/python", "https://www.reddit.com/r/python"),
            ("/r/python", "https://www.reddit.com/r/python"),
            ("https://www.reddit.com/r/python/", "https://www.reddit.com/r/python"),
        ],
    )
    def test_normalizes_identifier_forms(self, reddit_feed, identifier, expected):
        reddit_feed.identifier = identifier
        aggregator = RedditAggregator(reddit_feed)
        assert aggregator.get_source_url() == expected

    def test_returns_reddit_root_when_identifier_missing(self, reddit_feed):
        reddit_feed.identifier = ""
        aggregator = RedditAggregator(reddit_feed)
        assert aggregator.get_source_url() == "https://www.reddit.com"


@pytest.mark.django_db
@pytest.mark.parametrize(
    "aggregator_cls,aggregator_type,expected_url",
    [
        (HeiseAggregator, "heise", "https://www.heise.de/"),
        (MerkurAggregator, "merkur", "https://www.merkur.de"),
        (MeinMmoAggregator, "mein_mmo", "https://mein-mmo.de/"),
        (OglafAggregator, "oglaf", "https://www.oglaf.com"),
    ],
)
def test_constant_source_urls(user, feed_group, aggregator_cls, aggregator_type, expected_url):
    """These aggregators ignore the feed identifier and always return their fixed site URL."""
    feed = Feed.objects.create(
        name=f"{aggregator_type} feed",
        aggregator=aggregator_type,
        identifier="",
        user=user,
        group=feed_group,
    )
    aggregator = aggregator_cls(feed)
    assert aggregator.get_source_url() == expected_url
