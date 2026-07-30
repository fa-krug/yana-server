import unittest
from unittest.mock import MagicMock, patch

import pytest

from core.aggregators.mactechnews.aggregator import MactechnewsAggregator
from core.aggregators.mactechnews.comment_extractor import extract_comments
from core.aggregators.mactechnews.multipage_handler import (
    _build_page_url,
    detect_pagination,
    fetch_all_pages,
)


class TestMactechnewsAggregator(unittest.TestCase):
    def setUp(self):
        self.feed = MagicMock()
        self.feed.identifier = "https://www.mactechnews.de/Rss/News.x"
        self.feed.daily_limit = 5
        self.feed.options = {}
        self.aggregator = MactechnewsAggregator(self.feed)

    @patch("core.aggregators.website.FullWebsiteAggregator.extract_header_element")
    @patch("core.aggregators.website.fetch_html")
    def test_extract_content_mactechnews(self, mock_fetch, mock_header):
        # Mock header extraction
        mock_header.return_value = None

        # Read fixture
        with open("core/tests/fixtures/mactechnews.html", "r") as f:
            fixture_html = f.read()

        mock_fetch.return_value = fixture_html

        article = {
            "name": "Kurztest Dan Clark Audio Noire XO",
            "identifier": "https://www.mactechnews.de/news/article/Kurztest-Dan-Clark-Audio-Noire-XO-186238.html",
            "content": "",
        }

        # Test content extraction
        enriched = self.aggregator.enrich_articles([article])
        content = enriched[0]["content"]

        # Verify content from .MtnArticle is present
        self.assertIn("Gleicher Klang für weniger Geld?", content)

        # Verify noise is removed
        self.assertNotIn("NewsPictureMobile", content)
        self.assertNotIn("google-analytics.com", content)

    def test_extract_content_keeps_both_pages_of_a_combined_multipage_article(self):
        """fetch_all_pages joins pages into sibling .MtnArticle containers (see
        multipage_handler.fetch_all_pages), so extract_content must union all
        matches instead of keeping only the first -- otherwise pages 2..N are
        fetched over the network and then thrown away."""
        combined_html = (
            '<article class="MtnArticle"><p>Page 1 content here</p></article>'
            "\n\n"
            '<article class="MtnArticle"><p>Page 2 content here</p></article>'
        )

        result = self.aggregator.extract_content(combined_html, {"name": "T", "identifier": "u"})

        self.assertIn("Page 1 content here", result)
        self.assertIn("Page 2 content here", result)


class TestMactechnewsPagination(unittest.TestCase):
    def test_detect_pagination_no_pages(self):
        """HTML without pagination links returns only page 1."""
        html = "<html><body><article class='MtnArticle'><p>Content</p></article></body></html>"
        logger = MagicMock()
        result = detect_pagination(html, logger)
        self.assertEqual(result, {1})

    def test_detect_pagination_multiple_pages(self):
        """HTML with page links returns all page numbers."""
        html = """
        <html><body>
        <article class="MtnArticle">
            <p>Content</p>
            <div>Seiten:
                <strong>1</strong>
                <a href="?page=2">2</a>
                <a href="?page=3">3</a>
            </div>
        </article>
        </body></html>
        """
        logger = MagicMock()
        result = detect_pagination(html, logger)
        self.assertEqual(result, {1, 2, 3})

    def test_detect_pagination_current_page_not_first(self):
        """Detects pages even when viewing page 2."""
        html = """
        <html><body>
        <div>
            <a href="?page=1">1</a>
            <strong>2</strong>
            <a href="?page=3">3</a>
        </div>
        </body></html>
        """
        logger = MagicMock()
        result = detect_pagination(html, logger)
        self.assertEqual(result, {1, 2, 3})

    def test_detect_pagination_with_full_urls(self):
        """Handles full URLs in pagination links."""
        html = """
        <html><body>
        <a href="https://www.mactechnews.de/news/article/Test-12345.html?page=2">2</a>
        </body></html>
        """
        logger = MagicMock()
        result = detect_pagination(html, logger)
        self.assertEqual(result, {1, 2})

    def test_detect_pagination_from_fixture(self):
        """Detects pagination from multipage fixture."""
        with open("core/tests/fixtures/mactechnews_multipage.html", "r") as f:
            html = f.read()
        logger = MagicMock()
        result = detect_pagination(html, logger)
        self.assertEqual(result, {1, 2, 3})

    def test_build_page_url(self):
        """Constructs page URLs with query parameters."""
        base = "https://www.mactechnews.de/news/article/Test-12345.html"
        self.assertIn("page=2", _build_page_url(base, 2))
        self.assertIn("page=3", _build_page_url(base, 3))

    def test_build_page_url_preserves_existing_params(self):
        """Preserves existing query parameters when adding page."""
        base = "https://www.mactechnews.de/news/article/Test-12345.html?foo=bar"
        result = _build_page_url(base, 2)
        self.assertIn("page=2", result)
        self.assertIn("foo=bar", result)

    def test_fetch_all_pages_combines_content(self):
        """Combines content from multiple pages."""
        logger = MagicMock()

        page2_html = """
        <html><body>
        <article class="MtnArticle"><p>Page 2 content here</p></article>
        </body></html>
        """
        page1_html = """
        <html><body>
        <article class="MtnArticle"><p>Page 1 content here</p></article>
        </body></html>
        """

        fetched_urls = []

        def mock_fetcher(url):
            fetched_urls.append(url)
            return page2_html

        result = fetch_all_pages(
            base_url="https://example.com/article.html",
            page_numbers={1, 2},
            content_selectors=[".MtnArticle"],
            fetcher=mock_fetcher,
            logger=logger,
            first_page_html=page1_html,
        )

        self.assertIn("Page 1 content here", result)
        self.assertIn("Page 2 content here", result)
        # Page 1 should use first_page_html, so fetcher only called for page 2
        self.assertEqual(len(fetched_urls), 1)
        self.assertIn("page=2", fetched_urls[0])

    def test_fetch_all_pages_query_param_construction(self):
        """Verifies page URLs use ?page=N query parameters."""
        logger = MagicMock()
        fetched_urls = []

        def mock_fetcher(url):
            fetched_urls.append(url)
            return '<article class="MtnArticle"><p>Content</p></article>'

        fetch_all_pages(
            base_url="https://example.com/article.html",
            page_numbers={1, 2, 3},
            content_selectors=[".MtnArticle"],
            fetcher=mock_fetcher,
            logger=logger,
            first_page_html='<article class="MtnArticle"><p>Page 1</p></article>',
        )

        # Pages 2 and 3 should be fetched with ?page=N
        self.assertEqual(len(fetched_urls), 2)
        self.assertIn("page=2", fetched_urls[0])
        self.assertIn("page=3", fetched_urls[1])

    def test_fetch_article_content_single_page(self):
        """Single-page articles don't trigger additional fetches."""
        feed = MagicMock()
        feed.identifier = "https://www.mactechnews.de/Rss/News.x"
        feed.daily_limit = 5
        feed.options = {}
        aggregator = MactechnewsAggregator(feed)

        single_page_html = "<html><body><p>Simple article</p></body></html>"

        with patch.object(
            type(aggregator).__bases__[0],
            "fetch_article_content",
            return_value=single_page_html,
        ):
            result = aggregator.fetch_article_content("https://example.com/article.html")

        self.assertEqual(result, single_page_html)

    def test_fetch_article_content_multipage_disabled(self):
        """With combine_pages=False, only first page is returned."""
        feed = MagicMock()
        feed.identifier = "https://www.mactechnews.de/Rss/News.x"
        feed.daily_limit = 5
        feed.options = {"combine_pages": False}
        aggregator = MactechnewsAggregator(feed)

        with open("core/tests/fixtures/mactechnews_multipage.html", "r") as f:
            multipage_html = f.read()

        with patch.object(
            type(aggregator).__bases__[0],
            "fetch_article_content",
            return_value=multipage_html,
        ):
            result = aggregator.fetch_article_content("https://example.com/article.html")

        self.assertEqual(result, multipage_html)


class TestMactechnewsComments(unittest.TestCase):
    def setUp(self):
        with open("core/tests/fixtures/mactechnews.html", "r") as f:
            self.fixture_html = f.read()
        with open("core/tests/fixtures/mactechnews_multipage.html", "r") as f:
            self.multipage_html = f.read()

    def test_extract_comments_from_fixture(self):
        """Extracts comments from the main fixture HTML."""
        logger = MagicMock()
        result = extract_comments(
            self.fixture_html,
            "https://www.mactechnews.de/news/article/Test-186238.html",
            max_comments=5,
            logger=logger,
        )
        self.assertIsNotNone(result)
        self.assertIn("Nebula", result)
        self.assertIn("<blockquote>", result)
        self.assertIn("newscomment1636159", result)

    def test_extract_comments_from_multipage_fixture(self):
        """Extracts comments from the multipage fixture."""
        logger = MagicMock()
        result = extract_comments(
            self.multipage_html,
            "https://example.com/article.html",
            max_comments=5,
            logger=logger,
        )
        self.assertIsNotNone(result)
        self.assertIn("TestUser", result)
        self.assertIn("AnotherUser", result)
        self.assertIn("test comment on page 1", result)
        self.assertIn("Second comment here", result)

    def test_extract_comments_excludes_slogan(self):
        """Comment slogans are not included in comment text."""
        logger = MagicMock()
        result = extract_comments(
            self.multipage_html,
            "https://example.com/article.html",
            max_comments=5,
            logger=logger,
        )
        self.assertIsNotNone(result)
        self.assertNotIn("My cool slogan", result)

    def test_extract_comments_excludes_vote_functions(self):
        """Vote buttons are not included in comment output."""
        logger = MagicMock()
        result = extract_comments(
            self.multipage_html,
            "https://example.com/article.html",
            max_comments=5,
            logger=logger,
        )
        self.assertIsNotNone(result)
        self.assertNotIn("Vote buttons here", result)
        self.assertNotIn("MtnCommentVote", result)

    def test_extract_comments_max_zero_returns_none(self):
        """max_comments=0 returns None."""
        result = extract_comments(
            self.fixture_html,
            "https://example.com/article.html",
            max_comments=0,
        )
        self.assertIsNone(result)

    def test_extract_comments_max_limit(self):
        """Only extracts up to max_comments."""
        logger = MagicMock()
        result = extract_comments(
            self.multipage_html,
            "https://example.com/article.html",
            max_comments=1,
            logger=logger,
        )
        self.assertIsNotNone(result)
        self.assertIn("TestUser", result)
        # Second comment should NOT be present
        self.assertNotIn("AnotherUser", result)

    def test_extract_comments_no_comments_section(self):
        """HTML without comments returns None."""
        html = "<html><body><p>No comments here</p></body></html>"
        result = extract_comments(html, "https://example.com/article.html", max_comments=5)
        self.assertIsNone(result)

    def test_extract_comments_includes_timestamp(self):
        """Comments include formatted timestamps."""
        logger = MagicMock()
        result = extract_comments(
            self.multipage_html,
            "https://example.com/article.html",
            max_comments=5,
            logger=logger,
        )
        self.assertIsNotNone(result)
        self.assertIn("01.01.26", result)
        self.assertIn("10:00", result)

    def test_extract_comments_header_link(self):
        """Comments section has a header linking to #comments."""
        logger = MagicMock()
        result = extract_comments(
            self.multipage_html,
            "https://example.com/article.html",
            max_comments=5,
            logger=logger,
        )
        self.assertIsNotNone(result)
        self.assertIn("https://example.com/article.html#comments", result)
        self.assertIn("<h3>", result)

    @patch("core.aggregators.website.FullWebsiteAggregator.extract_header_element")
    @patch("core.aggregators.website.fetch_html")
    def test_process_content_includes_comments(self, mock_fetch, mock_header):
        """Integration: process_content includes comments when enabled."""
        mock_header.return_value = None

        with open("core/tests/fixtures/mactechnews.html", "r") as f:
            fixture_html = f.read()

        mock_fetch.return_value = fixture_html

        feed = MagicMock()
        feed.identifier = "https://www.mactechnews.de/Rss/News.x"
        feed.daily_limit = 5
        feed.options = {"include_comments": True, "max_comments": 5}
        aggregator = MactechnewsAggregator(feed)

        article = {
            "name": "Test Article",
            "identifier": "https://www.mactechnews.de/news/article/Test-186238.html",
            "content": "",
        }

        enriched = aggregator.enrich_articles([article])
        content = enriched[0]["content"]

        self.assertIn("article-comments", content)
        self.assertIn("Nebula", content)

    @patch("core.aggregators.website.FullWebsiteAggregator.extract_header_element")
    @patch("core.aggregators.website.fetch_html")
    def test_process_content_excludes_comments_when_disabled(self, mock_fetch, mock_header):
        """Integration: process_content excludes comments when disabled."""
        mock_header.return_value = None

        with open("core/tests/fixtures/mactechnews.html", "r") as f:
            fixture_html = f.read()

        mock_fetch.return_value = fixture_html

        feed = MagicMock()
        feed.identifier = "https://www.mactechnews.de/Rss/News.x"
        feed.daily_limit = 5
        feed.options = {"include_comments": False}
        aggregator = MactechnewsAggregator(feed)

        article = {
            "name": "Test Article",
            "identifier": "https://www.mactechnews.de/news/article/Test-186238.html",
            "content": "",
        }

        enriched = aggregator.enrich_articles([article])
        content = enriched[0]["content"]

        self.assertNotIn("article-comments", content)


@pytest.mark.django_db
class TestMactechnewsTechTickerFilter:
    @pytest.fixture
    def mtn_agg(self, rss_feed):
        rss_feed.aggregator = "mactechnews"
        rss_feed.identifier = "https://www.mactechnews.de/Rss/News.x"
        return MactechnewsAggregator(rss_feed)

    def test_techticker_roundups_are_skipped(self, mtn_agg):
        articles = [
            {"name": "Apple releases iOS 26.2", "date": None},
            {"name": "TechTicker: Kurz notiert am Freitag", "date": None},
        ]

        filtered = mtn_agg.filter_articles(articles)

        assert [a["name"] for a in filtered] == ["Apple releases iOS 26.2"]

    def test_the_word_mid_title_is_kept(self, mtn_agg):
        """Prefix match, not substring: a real article merely mentioning the
        word must survive."""
        articles = [{"name": "Warum der TechTicker beliebt ist", "date": None}]

        filtered = mtn_agg.filter_articles(articles)

        assert len(filtered) == 1

    def test_the_match_is_case_sensitive(self, mtn_agg):
        """Mirrors iOS's hasPrefix. Heise's skip-list is case-INsensitive
        because its terms appear mid-title with varying case (commit 338e62a);
        TechTicker is a generated prefix with a fixed form. Do not unify."""
        articles = [{"name": "techticker: lowercase variant", "date": None}]

        filtered = mtn_agg.filter_articles(articles)

        assert len(filtered) == 1

    def test_missing_title_does_not_raise(self, mtn_agg):
        filtered = mtn_agg.filter_articles([{"date": None}])

        assert len(filtered) == 1


if __name__ == "__main__":
    unittest.main()
