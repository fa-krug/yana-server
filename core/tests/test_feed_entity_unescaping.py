"""Feeds that double-encode HTML entities leave a literal entity in the title
or author after feedparser's single decode pass (e.g. ``&#8217;`` survives as
text instead of becoming ``'``). Confirmed live against The Verge's feed,
where some entries in the same feed are already correctly decoded and others
are not -- so the fix must be idempotent, not merely "always decode once".

This only concerns plain-text metadata (title, author). HTML fields
(content/summary) must NOT be unescaped here: that HTML still has to survive
the sanitizer and block parser, and unescaping markup could corrupt it or
reintroduce stripped tags.
"""

import pytest
from bs4 import BeautifulSoup

from core.aggregators.implementations import FeedContentAggregator
from core.aggregators.rss import RssAggregator
from core.aggregators.utils import build_header_html
from core.models import Feed


@pytest.fixture
def rss_feed_row(db, user, feed_group):
    return Feed.objects.create(
        name="RSS Feed",
        aggregator="rss",
        identifier="https://example.com/rss",
        user=user,
        group=feed_group,
    )


@pytest.fixture
def feed_content_feed_row(db, user, feed_group):
    return Feed.objects.create(
        name="Feed Content Feed",
        aggregator="feed_content",
        identifier="https://example.com/rss",
        user=user,
        group=feed_group,
    )


@pytest.mark.django_db
class TestRssAggregatorEntityUnescaping:
    def test_double_encoded_apostrophe_is_decoded(self, rss_feed_row):
        entries = [
            {
                "title": "Apple&#8217;s iPhone and Mac sales keep growing",
                "link": "https://example.com/a",
                "summary": "",
                "published": None,
            }
        ]
        [article] = RssAggregator(rss_feed_row).parse_to_raw_articles({"entries": entries})
        assert article["name"] == "Apple’s iPhone and Mac sales keep growing"

    def test_double_encoded_curly_quotes_are_decoded(self, rss_feed_row):
        entries = [
            {
                "title": "Xbox CEO lays out priorities in memo after major &#8216;reset&#8217;",
                "link": "https://example.com/b",
                "summary": "",
                "published": None,
            }
        ]
        [article] = RssAggregator(rss_feed_row).parse_to_raw_articles({"entries": entries})
        assert article["name"] == "Xbox CEO lays out priorities in memo after major ‘reset’"

    def test_already_correct_title_is_unchanged(self, rss_feed_row):
        """Idempotency: a real apostrophe must survive untouched."""
        entries = [
            {
                "title": "Samsung's Galaxy Watch 9 is $40 off",
                "link": "https://example.com/c",
                "summary": "",
                "published": None,
            }
        ]
        [article] = RssAggregator(rss_feed_row).parse_to_raw_articles({"entries": entries})
        assert article["name"] == "Samsung's Galaxy Watch 9 is $40 off"

    def test_amp_entity_in_title_is_decoded(self, rss_feed_row):
        entries = [
            {
                "title": "Rock &amp; Roll Hall of Fame announces inductees",
                "link": "https://example.com/d",
                "summary": "",
                "published": None,
            }
        ]
        [article] = RssAggregator(rss_feed_row).parse_to_raw_articles({"entries": entries})
        assert article["name"] == "Rock & Roll Hall of Fame announces inductees"

    def test_author_entity_is_decoded(self, rss_feed_row):
        entries = [
            {
                "title": "Some title",
                "link": "https://example.com/e",
                "summary": "",
                "author": "M&#246;bius Author",
                "published": None,
            }
        ]
        [article] = RssAggregator(rss_feed_row).parse_to_raw_articles({"entries": entries})
        assert article["author"] == "Möbius Author"

    def test_html_summary_content_is_not_unescaped(self, rss_feed_row):
        """Pin: content/summary is HTML and must pass through this step untouched."""
        entries = [
            {
                "title": "Some title",
                "link": "https://example.com/f",
                "summary": "A tag written as &lt;b&gt;bold&lt;/b&gt; should stay escaped",
                "published": None,
            }
        ]
        [article] = RssAggregator(rss_feed_row).parse_to_raw_articles({"entries": entries})
        assert article["content"] == "A tag written as &lt;b&gt;bold&lt;/b&gt; should stay escaped"


@pytest.mark.django_db
class TestFeedContentAggregatorEntityUnescaping:
    def test_double_encoded_title_is_decoded(self, feed_content_feed_row):
        entries = [
            {
                "title": "Apple&#8217;s iPhone and Mac sales keep growing",
                "link": "https://example.com/a",
                "content": [{"value": "<p>body</p>", "type": "text/html"}],
                "published": None,
            }
        ]
        [article] = FeedContentAggregator(feed_content_feed_row).parse_to_raw_articles(
            {"entries": entries}
        )
        assert article["name"] == "Apple’s iPhone and Mac sales keep growing"

    def test_already_correct_title_is_unchanged(self, feed_content_feed_row):
        entries = [
            {
                "title": "Samsung's Galaxy Watch 9 is $40 off",
                "link": "https://example.com/c",
                "content": [{"value": "<p>body</p>", "type": "text/html"}],
                "published": None,
            }
        ]
        [article] = FeedContentAggregator(feed_content_feed_row).parse_to_raw_articles(
            {"entries": entries}
        )
        assert article["name"] == "Samsung's Galaxy Watch 9 is $40 off"

    def test_author_entity_is_decoded(self, feed_content_feed_row):
        entries = [
            {
                "title": "Some title",
                "link": "https://example.com/e",
                "content": [{"value": "<p>body</p>", "type": "text/html"}],
                "author": "M&#246;bius Author",
                "published": None,
            }
        ]
        [article] = FeedContentAggregator(feed_content_feed_row).parse_to_raw_articles(
            {"entries": entries}
        )
        assert article["author"] == "Möbius Author"

    def test_html_content_is_not_unescaped(self, feed_content_feed_row):
        """Pin: the RSS 'content' HTML must pass through this step untouched."""
        entries = [
            {
                "title": "Some title",
                "link": "https://example.com/f",
                "content": [
                    {
                        "value": "A tag written as &lt;b&gt;bold&lt;/b&gt; should stay escaped",
                        "type": "text/html",
                    }
                ],
                "published": None,
            }
        ]
        [article] = FeedContentAggregator(feed_content_feed_row).parse_to_raw_articles(
            {"entries": entries}
        )
        assert (
            article["raw_content"] == "A tag written as &lt;b&gt;bold&lt;/b&gt; should stay escaped"
        )


@pytest.mark.django_db
class TestDecodeThenEscapeAtTheHtmlBoundary:
    """Store text decoded (this file); escape only where it becomes markup
    (core/aggregators/utils/content_formatter.py::build_header_html).

    A title that is both double-encoded *and* contains a quote exercises the
    full split: parse_to_raw_articles must decode it to plain text with a
    real ``"``, and build_header_html must then escape that same ``"`` back
    out when it builds the header's ``alt`` attribute.
    """

    def test_double_encoded_title_with_a_quote_decodes_then_escapes_safely(self, rss_feed_row):
        entries = [
            {
                # Double-encoded: the real title is `Report: Company "X" wins`;
                # a feed that encoded it twice leaves this literal &quot; behind
                # after feedparser's one decode pass.
                "title": "Report: Company &quot;X&quot; wins",
                "link": "https://example.com/g",
                "summary": "",
                "published": None,
            }
        ]
        [article] = RssAggregator(rss_feed_row).parse_to_raw_articles({"entries": entries})

        # Stored title is decoded plain text with a real quote character.
        assert article["name"] == 'Report: Company "X" wins'

        # Building the header from that stored title must escape it again --
        # nothing runs clean_html() on the header after this point.
        header = build_header_html("https://example.com/photo.jpg", title=article["name"])
        soup = BeautifulSoup(header, "html.parser")
        imgs = soup.find_all("img")
        assert len(imgs) == 1
        assert imgs[0]["alt"] == article["name"]
        assert "&quot;" in header
