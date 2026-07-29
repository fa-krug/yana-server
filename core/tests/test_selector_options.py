"""Tests for selector option resolution and the removal of use_full_content."""

import pytest

from core.aggregators.form_fields import SelectorListField
from core.aggregators.utils.content_extractor import (
    DEFAULT_CONTENT_SELECTORS,
    DEFAULT_IGNORE_SELECTORS,
    IFRAME_SANITIZE_SELECTOR,
)
from core.aggregators.website import FullWebsiteAggregator


@pytest.mark.django_db
class TestSelectorOptionResolution:
    def test_defaults_apply_when_key_absent(self, rss_feed):
        rss_feed.options = {}
        agg = FullWebsiteAggregator(rss_feed)

        assert agg.get_content_selectors() == DEFAULT_CONTENT_SELECTORS

    def test_option_overrides_class_default(self, rss_feed):
        rss_feed.options = {"content_selectors": ["div.body", ".extra"]}
        agg = FullWebsiteAggregator(rss_feed)

        assert agg.get_content_selectors() == ["div.body", ".extra"]

    def test_explicit_empty_list_is_preserved_not_defaulted(self, rss_feed):
        rss_feed.options = {"content_selectors": []}
        agg = FullWebsiteAggregator(rss_feed)

        assert agg.get_content_selectors() == []

    def test_option_entries_are_stripped_and_emptied_entries_dropped(self, rss_feed):
        rss_feed.options = {"content_selectors": [" article ", "", "  "]}
        agg = FullWebsiteAggregator(rss_feed)

        assert agg.get_content_selectors() == ["article"]

    def test_ignore_defaults_apply_when_key_absent(self, rss_feed):
        rss_feed.options = {}
        agg = FullWebsiteAggregator(rss_feed)

        # The class ignore list (the iframe policy) is always applied on top of
        # the shared defaults -- see test_ignore_option_replaces_defaults_and_
        # keeps_class_selectors below, which asserts the same "class list first"
        # composition when an option is present.
        assert agg.get_ignore_selectors() == [IFRAME_SANITIZE_SELECTOR] + DEFAULT_IGNORE_SELECTORS

    def test_ignore_option_replaces_defaults_and_keeps_class_selectors(self, rss_feed):
        rss_feed.options = {"ignore_selectors": [".sidebar"]}
        agg = FullWebsiteAggregator(rss_feed)
        agg.selectors_to_remove = [".site-chrome"]

        assert agg.get_ignore_selectors() == [".site-chrome", ".sidebar"]


@pytest.mark.django_db
class TestUseFullContentRemoved:
    def test_option_field_is_gone(self):
        assert "use_full_content" not in FullWebsiteAggregator.get_configuration_fields()

    def test_new_selector_fields_are_offered(self):
        fields = FullWebsiteAggregator.get_configuration_fields()

        assert set(fields) == {"content_selectors", "ignore_selectors"}

    def test_full_content_is_fetched_even_when_the_stale_option_is_false(
        self, rss_feed, monkeypatch
    ):
        rss_feed.options = {"use_full_content": False}
        agg = FullWebsiteAggregator(rss_feed)
        monkeypatch.setattr(
            agg, "fetch_article_content", lambda url: "<article><p>fetched</p></article>"
        )
        monkeypatch.setattr(agg, "extract_header_element", lambda article: None)

        enriched = agg.enrich_articles(
            [{"name": "T", "identifier": "https://example.com/a", "content": "rss summary"}]
        )

        assert "fetched" in enriched[0]["content"]


@pytest.mark.django_db
class TestFirstMatchOptOut:
    def test_generic_full_website_unions_matches(self, rss_feed):
        agg = FullWebsiteAggregator(rss_feed)
        html = "<body><article><p>one</p></article><article><p>two</p></article></body>"

        result = agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "one" in result
        assert "two" in result

    def test_scrapers_with_a_dedicated_container_opt_out(self):
        from core.aggregators.caschys_blog.aggregator import CaschysBlogAggregator
        from core.aggregators.heise import HeiseAggregator
        from core.aggregators.merkur import MerkurAggregator

        assert FullWebsiteAggregator.uses_first_content_match is False
        for agg_class in (HeiseAggregator, MerkurAggregator, CaschysBlogAggregator):
            assert agg_class.uses_first_content_match is True

    def test_first_match_flag_is_honored_by_extract_content(self, rss_feed):
        agg = FullWebsiteAggregator(rss_feed)
        agg.uses_first_content_match = True
        html = "<body><article><p>one</p></article><article><p>two</p></article></body>"

        result = agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "one" in result
        assert "two" not in result


class TestSelectorListField:
    def test_blank_cleans_to_none_so_defaults_survive(self):
        assert SelectorListField(required=False).clean("") is None

    def test_comma_string_cleans_to_list(self):
        assert SelectorListField(required=False).clean("article, .body") == ["article", ".body"]

    def test_stray_whitespace_and_empty_segments_are_dropped(self):
        assert SelectorListField(required=False).clean(" article , , .body ,") == [
            "article",
            ".body",
        ]

    def test_prepare_value_renders_a_stored_list(self):
        assert SelectorListField(required=False).prepare_value(["article", ".body"]) == (
            "article, .body"
        )


@pytest.mark.django_db
class TestSaveOptionsDropsNone:
    def test_blank_selector_field_removes_the_key(self, rss_feed):
        rss_feed.options = {"content_selectors": ["article"]}
        agg = FullWebsiteAggregator(rss_feed)

        agg.save_options({"content_selectors": None, "ignore_selectors": None})

        assert "content_selectors" not in agg.feed.options
        assert "ignore_selectors" not in agg.feed.options


@pytest.mark.django_db
class TestGenericContentFallback:
    def test_returns_extracted_content_above_the_floor(self, rss_feed):
        agg = FullWebsiteAggregator(rss_feed)
        body = (
            "This is a real article body with clearly more than eighty characters of prose in it."
        )
        html = f"<html><body><main><p>{body}</p></main></body></html>"

        result = agg.generic_content_if_present(html, {"identifier": "https://example.com/a"})

        assert result is not None
        assert body in result

    def test_returns_none_below_the_floor(self, rss_feed):
        agg = FullWebsiteAggregator(rss_feed)
        html = "<html><body><main><p>By Jane Doe</p></main></body></html>"

        result = agg.generic_content_if_present(html, {"identifier": "https://example.com/a"})

        assert result is None

    def test_returns_none_when_no_generic_container_matches(self, rss_feed):
        agg = FullWebsiteAggregator(rss_feed)
        html = "<html><body><div class='mystery'>site navigation</div></body></html>"

        result = agg.generic_content_if_present(html, {"identifier": "https://example.com/a"})

        assert result is None

    def test_uses_generic_defaults_not_the_scrapers_dedicated_container(self, rss_feed):
        """The point of the hook: syndicated pages carry none of the scraper's markup."""
        agg = FullWebsiteAggregator(rss_feed)
        agg.content_selectors = [".tagesschau-only"]
        body = (
            "Foreign broadcaster template with a long enough body to clear the eighty char floor."
        )
        html = f"<html><body><article><p>{body}</p></article></body></html>"

        result = agg.generic_content_if_present(html, {"identifier": "https://mdr.de/a"})

        assert result is not None
        assert body in result

    def test_floor_is_exactly_eighty_characters(self):
        from core.aggregators.website import GENERIC_CONTENT_MIN_TEXT_LENGTH

        assert GENERIC_CONTENT_MIN_TEXT_LENGTH == 80
