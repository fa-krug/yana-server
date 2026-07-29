import unittest
from unittest.mock import MagicMock, patch

from core.aggregators.caschys_blog.aggregator import CaschysBlogAggregator


class TestCaschysBlogAggregator(unittest.TestCase):
    def setUp(self):
        self.feed = MagicMock()
        self.feed.identifier = "https://stadt-bremerhaven.de/feed/"
        self.feed.daily_limit = 5
        self.feed.options = {}
        self.aggregator = CaschysBlogAggregator(self.feed)

    @patch("core.aggregators.website.FullWebsiteAggregator.extract_header_element")
    @patch("core.aggregators.website.fetch_html")
    def test_extract_content_caschys_blog(self, mock_fetch, mock_header):
        # Mock header extraction
        mock_header.return_value = None

        # Read fixture
        with open("core/tests/fixtures/caschys_blog.html", "r") as f:
            fixture_html = f.read()

        mock_fetch.return_value = fixture_html

        article = {
            "name": "Google Stadia Controller: Voller Steam-Support kurz vor Ende der Frist",
            "identifier": "https://stadt-bremerhaven.de/google-stadia-controller-voller-steam-support-kurz-vor-ende-der-frist/",
            "content": "",
        }

        # Test content extraction
        enriched = self.aggregator.enrich_articles([article])
        content = enriched[0]["content"]

        # Verify content from .entry-inner is present
        self.assertIn("Google Stadia Controller", content)
        self.assertIn("31. Dezember 2025", content)

        # Verify noise is removed
        self.assertNotIn("wpSEO", content)
        self.assertNotIn("Google Analytics", content)

    def test_filter_articles_anzeige(self):
        articles = [
            {"name": "Normal Article", "identifier": "url1", "date": None},
            {"name": "Sponsered (Anzeige)", "identifier": "url2", "date": None},
        ]

        # We need to mock timezone.now() for filter_articles
        with patch("django.utils.timezone.now") as mock_now:
            from datetime import datetime

            from django.utils import timezone

            mock_now.return_value = datetime(2026, 1, 2, tzinfo=timezone.UTC)

            filtered = self.aggregator.filter_articles(articles)

            self.assertEqual(len(filtered), 1)
            self.assertEqual(filtered[0]["name"], "Normal Article")

    def test_filter_articles_weekly_recap(self):
        articles = [
            {"name": "Normal Article", "identifier": "url1", "date": None},
            {"name": "Immer wieder sonntags KW 1: Rückblick", "identifier": "url2", "date": None},
            {"name": "Immer wieder sonntags KW: Andere Woche", "identifier": "url3", "date": None},
        ]

        # We need to mock timezone.now() for filter_articles
        with patch("django.utils.timezone.now") as mock_now:
            from datetime import datetime

            from django.utils import timezone

            mock_now.return_value = datetime(2026, 1, 2, tzinfo=timezone.UTC)

            filtered = self.aggregator.filter_articles(articles)

            self.assertEqual(len(filtered), 1)
            self.assertEqual(filtered[0]["name"], "Normal Article")

    def test_duplicate_image_removal(self):
        from core.aggregators.services.header_element.context import HeaderElementData
        from core.aggregators.utils import extract_main_content

        html = """
<div class="entry themeform">
    <div class="entry-inner">
        <p><img src="https://example.com/image.jpg" /><br />
        Content starts here.</p>
    </div>
</div>
"""
        content = extract_main_content(html, content_selectors=self.aggregator.content_selectors)

        article = {
            "name": "Test",
            "identifier": "url",
            "header_data": HeaderElementData(
                image_bytes=b"fake",
                content_type="image/jpeg",
                image_url="https://example.com/different-image.jpg",
                base64_data_uri="data:image/jpeg;base64,fake",
            ),
        }

        processed = self.aggregator.process_content(content, article)

        # Image should be removed
        self.assertNotIn("image.jpg", processed)
        self.assertIn("Content starts here", processed)

    def test_duplicate_image_removal_wrapped_in_link(self):
        """Test that images wrapped in links (<p><a><img></a></p>) are also removed."""
        from core.aggregators.services.header_element.context import HeaderElementData
        from core.aggregators.utils import extract_main_content

        # This is the actual structure from Caschy's Blog articles
        html = """
<div class="entry themeform">
    <div class="entry-inner">
        <p><a href="https://stadt-bremerhaven.de/wp-content/uploads/2022/08/Plaion-Logo-scaled.jpg"><img src="https://stadt-bremerhaven.de/wp-content/uploads/2022/08/Plaion-Logo-720x389.jpg" alt="" /></a></p>
        <p>Content starts here after the image.</p>
    </div>
</div>
"""
        content = extract_main_content(html, content_selectors=self.aggregator.content_selectors)

        article = {
            "name": "Test Article",
            "identifier": "https://stadt-bremerhaven.de/test-article/",
            "header_data": HeaderElementData(
                image_bytes=b"fake",
                content_type="image/jpeg",
                image_url="https://stadt-bremerhaven.de/wp-content/uploads/2022/08/Plaion-Logo.jpg",
                base64_data_uri="data:image/jpeg;base64,fake",
            ),
        }

        processed = self.aggregator.process_content(content, article)

        # Image wrapped in link should be removed (the entire <a> containing <img>)
        self.assertNotIn("Plaion-Logo", processed)
        self.assertIn("Content starts here", processed)

    @patch("core.aggregators.website.FullWebsiteAggregator.extract_header_element")
    @patch("core.aggregators.website.fetch_html")
    def test_youtube_embed_preservation(self, mock_fetch, mock_header):
        mock_header.return_value = None

        # HTML with YouTube iframe
        html_content = """
        <div class="entry themeform">
            <div class="entry-inner">
                <p>Some text</p>
                <div class="video-container">
                    <iframe loading="lazy" title="ONE PIECE" width="720" height="405"
                            src="https://www.youtube.com/embed/vplWD2LRECs?feature=oembed"
                            frameborder="0" allowfullscreen></iframe>
                </div>
            </div>
        </div>
        """
        mock_fetch.return_value = html_content

        article = {
            "name": "Test Article",
            "identifier": "https://stadt-bremerhaven.de/test/",
            "content": "",
        }

        enriched = self.aggregator.enrich_articles([article])
        content = enriched[0]["content"]

        self.assertIn("<iframe", content)
        # Check that it was converted to proxy
        self.assertIn("/api/youtube-proxy?v=vplWD2LRECs", content)

    @patch("core.aggregators.website.FullWebsiteAggregator.extract_header_element")
    @patch("core.aggregators.website.fetch_html")
    def test_iframe_filtering(self, mock_fetch, mock_header):
        mock_header.return_value = None

        html_content = """
        <div class="entry themeform">
            <div class="entry-inner">
                <p>Allowed:</p>
                <iframe src="https://www.youtube.com/embed/12345"></iframe>
                <iframe src="https://platform.twitter.com/embed/tweet"></iframe>
                <iframe src="https://x.com/embed/tweet"></iframe>

                <p>Blocked:</p>
                <iframe src="https://vimeo.com/12345"></iframe>
                <iframe src="https://malicious.com/iframe"></iframe>
            </div>
        </div>
        """
        mock_fetch.return_value = html_content

        article = {
            "name": "Test Iframe Filtering",
            "identifier": "https://stadt-bremerhaven.de/iframe-test/",
            "content": "",
        }

        enriched = self.aggregator.enrich_articles([article])
        content = enriched[0]["content"]

        # Assert allowed iframes are present
        # YouTube should be proxied
        self.assertIn("/api/youtube-proxy?v=12345", content)
        self.assertIn('src="https://platform.twitter.com/embed/tweet"', content)
        self.assertIn('src="https://x.com/embed/tweet"', content)

        # Assert blocked iframes are removed
        self.assertNotIn('src="https://vimeo.com/12345"', content)
        self.assertNotIn('src="https://malicious.com/iframe"', content)


if __name__ == "__main__":
    unittest.main()
