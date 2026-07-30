import pytest

from core.aggregators.ars_technica.aggregator import ArsTechnicaAggregator


@pytest.mark.django_db
class TestArsTechnicaAggregator:
    @pytest.fixture
    def ars_agg(self, rss_feed):
        rss_feed.aggregator = "ars_technica"
        rss_feed.identifier = "https://arstechnica.com/feed/"
        return ArsTechnicaAggregator(rss_feed)

    def test_default_identifier(self, rss_feed):
        rss_feed.identifier = ""
        agg = ArsTechnicaAggregator(rss_feed)

        assert agg.identifier == "https://arstechnica.com/feed/"

    def test_identifier_choices(self):
        choices = ArsTechnicaAggregator.get_identifier_choices()

        assert choices == [
            ("https://arstechnica.com/feed/", "Main Feed"),
            ("https://arstechnica.com/gadgets/feed/", "Gadgets"),
            ("https://arstechnica.com/science/feed/", "Science"),
            ("https://arstechnica.com/gaming/feed/", "Gaming"),
        ]

    def test_source_url(self, ars_agg):
        assert ars_agg.get_source_url() == "https://arstechnica.com"

    def test_merges_every_in_page_post_content_block(self, ars_agg):
        """Even single-page articles split into multiple .post-content blocks --
        keeping only the first would truncate the article."""
        html = (
            "<html><body>"
            '<div class="post-content post-content-double"><p>Segment one.</p></div>'
            '<a data-page="2">Page 2</a>'
            '<div class="post-content post-content-double"><p>Segment two.</p></div>'
            "</body></html>"
        )

        result = ars_agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "Segment one." in result
        assert "Segment two." in result

    def test_does_not_deduplicate_repeated_segment_text(self, ars_agg):
        """Blocks are distinct article segments, not repeats."""
        html = (
            '<div class="post-content"><p>Same words.</p></div>'
            '<div class="post-content"><p>Same words.</p></div>'
        )

        result = ars_agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert result.count("Same words.") == 2

    def test_strips_ad_and_share_containers(self, ars_agg):
        html = (
            '<div class="post-content">'
            "<p>Body text.</p>"
            '<div class="ad--mid-content">Advertisement</div>'
            '<div class="ad-wrapper-rail">Rail ad</div>'
            '<div class="social-share">Share this</div>'
            "<aside>Sidebar</aside>"
            "</div>"
        )

        result = ars_agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "Body text." in result
        assert "Advertisement" not in result
        assert "Rail ad" not in result
        assert "Share this" not in result
        assert "Sidebar" not in result

    def test_extract_content_falls_back_to_the_rss_summary(self, ars_agg):
        """A class-name rename on arstechnica.com must not surface the whole
        page (nav, related-story rail, etc.) as the article body."""
        html = (
            "<html><body>"
            "<nav>Ars Technica Gadgets Science Gaming</nav>"
            '<div class="unrelated-container">Some other page markup</div>'
            "</body></html>"
        )

        result = ars_agg.extract_content(
            html, {"name": "T", "identifier": "u", "content": "<p>rss summary</p>"}
        )

        assert result == "<p>rss summary</p>"
        assert "Ars Technica Gadgets Science Gaming" not in result
        assert "Some other page markup" not in result

    def test_unions_matches_by_design(self):
        assert ArsTechnicaAggregator.uses_first_content_match is False

    def test_registry_resolves_the_type(self):
        from core.aggregators.registry import AggregatorRegistry

        assert AggregatorRegistry.get("ars_technica") is ArsTechnicaAggregator

    def test_choice_is_offered(self):
        from core.choices import AGGREGATOR_CHOICES

        assert dict(AGGREGATOR_CHOICES)["ars_technica"] == "Ars Technica"
        assert len(AGGREGATOR_CHOICES) == 16
