from unittest.mock import patch

import pytest

from core.aggregators.merkur.aggregator import MerkurAggregator


@pytest.mark.django_db
class TestMerkurAggregator:
    @pytest.fixture
    def merkur_agg(self, rss_feed):
        rss_feed.aggregator = "merkur"
        rss_feed.identifier = "https://www.merkur.de/rssfeed.rdf"
        return MerkurAggregator(rss_feed)

    def test_default_identifier(self, rss_feed):
        rss_feed.identifier = ""
        agg = MerkurAggregator(rss_feed)
        assert agg.identifier == "https://www.merkur.de/rssfeed.rdf"

    @patch("core.aggregators.merkur.aggregator.extract_main_content")
    def test_extract_content_uses_story_selector(self, mock_extract, merkur_agg):
        mock_extract.return_value = "content"
        html = "<html><body><div class='idjs-Story'>Story</div></body></html>"

        extracted = merkur_agg.extract_content(html, {"name": "Test"})

        assert extracted == "content"
        mock_extract.assert_called()
        # Verify it uses the right selector
        args, kwargs = mock_extract.call_args
        assert kwargs["content_selectors"] == [".idjs-Story"]

    def test_process_content_removes_sanitized_attributes(self, merkur_agg):
        # Merkur specific: sanitize_html_attributes followed by remove_sanitized_attributes
        html = '<div class="foo" id="bar" style="color:red">Content</div>'

        # We need to mock super().process_content to see what it sends
        with patch(
            "core.aggregators.website.FullWebsiteAggregator.process_content",
            side_effect=lambda x, y: x,
        ):
            processed = merkur_agg.process_content(html, {"name": "Test", "identifier": "url"})

        # After Merkur's custom processing, all those attributes should be GONE
        # because sanitize_html_attributes moves them to data-sanitized-*,
        # and remove_sanitized_attributes removes those.
        assert 'class="foo"' not in processed
        assert 'id="bar"' not in processed
        assert 'style="color:red"' not in processed
        assert "data-sanitized" not in processed
        assert "<div>Content</div>" in processed

    def test_process_content_removes_empty_elements(self, merkur_agg):
        html = "<div><p>Text</p><p></p><span></span></div>"

        with patch(
            "core.aggregators.website.FullWebsiteAggregator.process_content",
            side_effect=lambda x, y: x,
        ):
            processed = merkur_agg.process_content(html, {"name": "Test", "identifier": "url"})

        assert "<p></p>" not in processed
        assert "<span></span>" not in processed
        assert "<p>Text</p>" in processed
