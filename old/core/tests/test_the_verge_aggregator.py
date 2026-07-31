import pytest

from core.aggregators.the_verge.aggregator import TheVergeAggregator

BODY_SELECTOR = "duet--article--article-body-component"


@pytest.mark.django_db
class TestTheVergeAggregator:
    @pytest.fixture
    def verge_agg(self, rss_feed):
        rss_feed.aggregator = "the_verge"
        rss_feed.identifier = "https://www.theverge.com/rss/index.xml"
        return TheVergeAggregator(rss_feed)

    def test_default_identifier(self, rss_feed):
        rss_feed.identifier = ""
        agg = TheVergeAggregator(rss_feed)

        assert agg.identifier == "https://www.theverge.com/rss/index.xml"

    def test_identifier_choices_has_only_the_main_feed(self):
        """Section feeds under /<cat>/rss/index.xml return 404."""
        choices = TheVergeAggregator.get_identifier_choices()

        assert choices == [("https://www.theverge.com/rss/index.xml", "Main Feed")]

    def test_source_url(self, verge_agg):
        assert verge_agg.get_source_url() == "https://www.theverge.com"

    def test_extracts_the_article_body(self, verge_agg):
        html = (
            "<html><body>"
            '<div class="duet--layout--entry-body">'
            f'<div class="{BODY_SELECTOR}"><p>The real story.</p></div>'
            "</div>"
            "</body></html>"
        )

        result = verge_agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "The real story." in result

    def test_unions_all_body_components_within_the_entry_body(self, verge_agg):
        """Vox's Duet CMS emits one body component per paragraph-group, not per article."""
        html = (
            "<html><body>"
            '<div class="duet--layout--entry-body">'
            f'<div class="{BODY_SELECTOR}"><p>First paragraph group.</p></div>'
            f'<div class="{BODY_SELECTOR}"><p>Second paragraph group.</p></div>'
            f'<div class="{BODY_SELECTOR}"><p>Third paragraph group.</p></div>'
            "</div>"
            "</body></html>"
        )

        result = verge_agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "First paragraph group." in result
        assert "Second paragraph group." in result
        assert "Third paragraph group." in result
        # Document order must be preserved.
        assert (
            result.index("First paragraph group.")
            < result.index("Second paragraph group.")
            < result.index("Third paragraph group.")
        )

    def test_excludes_body_components_outside_the_entry_body_scope(self, verge_agg):
        """Related/"stream" stories elsewhere on the page must not be unioned in."""
        html = (
            "<html><body>"
            '<div class="duet--layout--entry-body">'
            f'<div class="{BODY_SELECTOR}"><p>Main article paragraph.</p></div>'
            "</div>"
            '<div class="duet--layout--related-stream">'
            f'<div class="{BODY_SELECTOR}"><p>Related story body.</p></div>'
            "</div>"
            "</body></html>"
        )

        result = verge_agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "Main article paragraph." in result
        assert "Related story body." not in result

    def test_strips_noise_containers(self, verge_agg):
        html = (
            '<div class="duet--layout--entry-body">'
            f'<div class="{BODY_SELECTOR}">'
            "<p>Body text.</p>"
            '<div class="duet--ad--slot">Advertisement</div>'
            '<div class="duet--recirculation--related-list">Read more</div>'
            '<div class="newsletter-signup">Subscribe</div>'
            "<aside>Sidebar</aside>"
            "</div>"
            "</div>"
        )

        result = verge_agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "Body text." in result
        assert "Advertisement" not in result
        assert "Read more" not in result
        assert "Subscribe" not in result
        assert "Sidebar" not in result

    def test_extract_content_falls_back_to_the_rss_summary(self, verge_agg):
        """A class-name rename on theverge.com must not surface the whole page
        (nav, related-story rail, etc.) as the article body."""
        html = (
            "<html><body>"
            "<nav>The Verge Tech Reviews Science</nav>"
            '<div class="unrelated-container">Some other page markup</div>'
            "</body></html>"
        )

        result = verge_agg.extract_content(
            html, {"name": "T", "identifier": "u", "content": "<p>rss summary</p>"}
        )

        assert result == "<p>rss summary</p>"
        assert "The Verge Tech Reviews Science" not in result
        assert "Some other page markup" not in result

    def test_registry_resolves_the_type(self):
        from core.aggregators.registry import AggregatorRegistry

        assert AggregatorRegistry.get("the_verge") is TheVergeAggregator

    def test_choice_is_offered(self):
        from core.choices import AGGREGATOR_CHOICES

        assert dict(AGGREGATOR_CHOICES)["the_verge"] == "The Verge"
