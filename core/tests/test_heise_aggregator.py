from unittest.mock import patch

import pytest

from core.aggregators.heise.aggregator import HeiseAggregator


@pytest.mark.django_db
class TestHeiseAggregator:
    @pytest.fixture
    def heise_agg(self, rss_feed):
        rss_feed.aggregator = "heise"
        rss_feed.identifier = "https://www.heise.de/rss/heise.rdf"
        return HeiseAggregator(rss_feed)

    def test_default_identifier(self, rss_feed):
        rss_feed.identifier = ""
        agg = HeiseAggregator(rss_feed)
        assert agg.identifier == "https://www.heise.de/rss/heise.rdf"

    @patch("core.aggregators.heise.aggregator.FullWebsiteAggregator.fetch_article_content")
    def test_fetch_article_content_converts_url(self, mock_fetch, heise_agg):
        mock_fetch.return_value = "<html></html>"
        url = "https://www.heise.de/news/article-123.html"

        heise_agg.fetch_article_content(url)

        mock_fetch.assert_called_with("https://www.heise.de/news/article-123.html?seite=all")

    def test_filter_articles_skips_terms(self, heise_agg):
        articles = [
            {"name": "Normal News", "date": None},
            {"name": "heise+ : Something", "date": None},
            {"name": "Produktwerker", "date": None},
        ]
        # Mock parent filter to return all (no age skip)
        with patch(
            "core.aggregators.website.FullWebsiteAggregator.filter_articles",
            side_effect=lambda x: x,
        ):
            filtered = heise_agg.filter_articles(articles)

        assert len(filtered) == 1
        assert filtered[0]["name"] == "Normal News"

    def test_filter_articles_skips_bilder_der_woche(self, heise_agg):
        articles = [
            {"name": "Normal News", "date": None},
            {"name": "Die Bilder der Woche (KW 15)", "date": None},
            {"name": "die Bilder der Woche in der Übersicht", "date": None},
        ]
        with patch(
            "core.aggregators.website.FullWebsiteAggregator.filter_articles",
            side_effect=lambda x: x,
        ):
            filtered = heise_agg.filter_articles(articles)

        assert len(filtered) == 1
        assert filtered[0]["name"] == "Normal News"

    def test_enrich_articles_skips_event_sourcing(self, heise_agg):
        articles = [
            {"name": "A", "content": "normal content"},
            {"name": "B", "content": "This mentions event sourcing logic"},
        ]
        with patch(
            "core.aggregators.website.FullWebsiteAggregator.enrich_articles",
            side_effect=lambda x: x,
        ):
            enriched = heise_agg.enrich_articles(articles)

        assert len(enriched) == 1
        assert enriched[0]["name"] == "A"

    def test_extract_content_removes_empty_elements(self, heise_agg):
        html = """
        <div id="meldung">
            <p>Content</p>
            <p></p>
            <div><span></span></div>
            <div><img src="img.jpg"></div>
        </div>
        """
        extracted = heise_agg.extract_content(html, {"name": "Test"})

        assert "<p>Content</p>" in extracted
        assert "<p></p>" not in extracted
        assert "<span></span>" not in extracted
        assert '<img src="img.jpg"/>' in extracted

    def test_extract_content_keeps_only_the_story_container(self, heise_agg):
        """Heise pages carry sibling <article> teaser cards; the union must not
        splice them into the body."""
        html = (
            "<html><body>"
            "<nav>Startseite Newsticker Themen</nav>"
            '<article id="meldung"><p>The real story body.</p></article>'
            "<article><p>Teaser one</p></article>"
            "<article><p>Teaser two</p></article>"
            "<article><p>Teaser three</p></article>"
            "</body></html>"
        )

        result = heise_agg.extract_content(
            html, {"name": "T", "identifier": "u", "content": "<p>rss summary</p>"}
        )

        assert "The real story body." in result
        assert "Teaser one" not in result
        assert "Startseite Newsticker Themen" not in result

    def test_extract_content_falls_back_to_the_rss_summary(self, heise_agg):
        """Magazine/paywall gate pages have a different DOM. Dumping <body>
        surfaced the whole site chrome as the article, so degrade to RSS."""
        html = (
            "<html><body>"
            "<nav>Startseite Newsticker Themen</nav>"
            '<div class="paywall">Jetzt heise+ lesen</div>'
            "</body></html>"
        )

        result = heise_agg.extract_content(
            html, {"name": "T", "identifier": "u", "content": "<p>rss summary</p>"}
        )

        assert result == "<p>rss summary</p>"
        assert "Startseite Newsticker Themen" not in result
        assert "Jetzt heise+ lesen" not in result

    def test_extract_content_falls_back_to_empty_when_there_is_no_rss_summary(self, heise_agg):
        result = heise_agg.extract_content(
            "<html><body><nav>chrome</nav></body></html>", {"name": "T"}
        )

        assert result == ""

    @patch("core.aggregators.heise.aggregator.fetch_html")
    def test_extract_comments(self, mock_fetch_html, heise_agg):
        article_html = """
        <html>
            <script type="application/ld+json">
            {
                "@context": "http://schema.org",
                "discussionUrl": "https://www.heise.de/forum/news/123/comments"
            }
            </script>
        </html>
        """
        forum_html = """
        <div id="posting_1">
            <span class="pseudonym">User1</span>
            <div class="text"><p>Great article!</p></div>
        </div>
        """
        mock_fetch_html.return_value = forum_html

        comments = heise_agg.extract_comments("https://example.com/art", article_html)

        assert comments is not None
        assert "Comments" in comments
        assert "User1" in comments
        assert "Great article!" in comments
