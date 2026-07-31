import unittest
from unittest.mock import MagicMock, patch

from core.aggregators.explosm.aggregator import ExplosmAggregator


class TestExplosmAggregator(unittest.TestCase):
    def setUp(self):
        self.feed = MagicMock()
        self.feed.identifier = "https://explosm.net/rss.xml"
        self.feed.daily_limit = 5
        self.feed.options = {}
        self.aggregator = ExplosmAggregator(self.feed)

    @patch("core.aggregators.website.FullWebsiteAggregator.extract_header_element")
    @patch("core.aggregators.website.fetch_html")
    def test_extract_content_explosm(self, mock_fetch, mock_header):
        # Mock header extraction
        mock_header.return_value = None

        # Read fixture
        with open("core/tests/fixtures/explosm.html", "r") as f:
            fixture_html = f.read()

        mock_fetch.return_value = fixture_html

        article = {
            "name": "Test Comic",
            "identifier": "https://explosm.net/comics/test",
            "author": "Rob DenBleyker",
            "content": "",
        }

        # Test content extraction
        # FullWebsiteAggregator.enrich_articles calls extract_content
        enriched = self.aggregator.enrich_articles([article])
        content = enriched[0]["content"]

        # Verify comic image is present
        self.assertIn("https://static.explosm.net/2025/12/12113205/bygones.png", content)
        # Verify noise is removed (e.g. navigation arrows)
        self.assertNotIn("ComicSelector__Container", content)
        self.assertNotIn("ComicShare__Container", content)


if __name__ == "__main__":
    unittest.main()
