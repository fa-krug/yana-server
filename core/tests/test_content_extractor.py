"""Tests for the shared content extraction core."""

from core.aggregators.utils.content_extractor import (
    DEFAULT_CONTENT_SELECTORS,
    DEFAULT_IGNORE_SELECTORS,
    IFRAME_SANITIZE_SELECTOR,
    extract_main_content,
    extract_main_content_if_present,
    select_content_elements,
)


class TestSelectorUnion:
    def test_sibling_containers_both_captured(self):
        """The truncation this change fixes: two sibling matches, both kept."""
        html = """
        <html><body>
          <article><p>first half</p></article>
          <article><p>second half</p></article>
        </body></html>
        """

        result = extract_main_content(html, content_selectors=["article"])

        assert "first half" in result
        assert "second half" in result

    def test_nested_match_dropped_outermost_wins(self):
        html = "<html><body><main><article><p>body text</p></article></main></body></html>"

        result = extract_main_content(html, content_selectors=["main", "article"])

        assert result.count("body text") == 1
        assert result.strip().startswith("<main")

    def test_element_matched_by_two_selectors_appears_once(self):
        html = '<html><body><article class="entry-content"><p>once</p></article></body></html>'

        result = extract_main_content(html, content_selectors=["article", ".entry-content"])

        assert result.count("once") == 1

    def test_output_is_document_order_not_selector_order(self):
        html = """
        <html><body>
          <div class="entry-content"><p>alpha</p></div>
          <section class="article-content"><p>beta</p></section>
        </body></html>
        """

        result = extract_main_content(
            html, content_selectors=[".article-content", ".entry-content"]
        )

        assert result.index("alpha") < result.index("beta")

    def test_first_match_only_keeps_first_sibling(self):
        html = """
        <html><body>
          <article><p>keep me</p></article>
          <article><p>teaser card</p></article>
        </body></html>
        """

        result = extract_main_content(html, content_selectors=["article"], first_match_only=True)

        assert "keep me" in result
        assert "teaser card" not in result

    def test_select_content_elements_returns_tags_in_document_order(self):
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(
            "<body><p id='a' class='x'>1</p><p id='b' class='x'>2</p></body>", "html.parser"
        )

        elements = select_content_elements(soup, [".x"])

        assert [element["id"] for element in elements] == ["a", "b"]


class TestRemoveSelectors:
    def test_ignore_selectors_applied_to_every_container(self):
        html = """
        <html><body>
          <article><p>keep one</p><div class="ad">buy</div></article>
          <article><p>keep two</p><div class="ad">buy</div></article>
        </body></html>
        """

        result = extract_main_content(html, content_selectors=["article"], remove_selectors=[".ad"])

        assert "keep one" in result
        assert "keep two" in result
        assert "buy" not in result

    def test_invalid_selector_is_skipped_and_others_still_apply(self):
        html = "<html><body><article><p>survivor</p></article></body></html>"

        result = extract_main_content(html, content_selectors=["!!!nonsense", "article"])

        assert "survivor" in result

    def test_invalid_remove_selector_is_skipped(self):
        html = '<html><body><article><p>text</p><div class="ad">buy</div></article></body></html>'

        result = extract_main_content(
            html, content_selectors=["article"], remove_selectors=["!!!nonsense", ".ad"]
        )

        assert "text" in result
        assert "buy" not in result


class TestFallbackBehavior:
    def test_no_match_falls_back_to_body(self):
        html = "<html><body><div class='mystery'>only content</div></body></html>"

        result = extract_main_content(html, content_selectors=["article"])

        assert "only content" in result

    def test_fallback_still_applies_remove_selectors(self):
        html = """
        <html><body><div class="mystery">only content</div><div class="ad">buy</div></body></html>
        """

        result = extract_main_content(html, content_selectors=["article"], remove_selectors=[".ad"])

        assert "only content" in result
        assert "buy" not in result

    def test_if_present_returns_none_on_no_match(self):
        html = "<html><body><div class='mystery'>site navigation</div></body></html>"

        result = extract_main_content_if_present(html, content_selectors=["article"])

        assert result is None

    def test_if_present_returns_content_on_match(self):
        html = "<html><body><article><p>real body</p></article></body></html>"

        result = extract_main_content_if_present(html, content_selectors=["article"])

        assert result is not None
        assert "real body" in result


class TestMandatorySanitization:
    def test_template_content_is_stripped(self):
        html = "<html><body><template><p>ghost</p></template><p>real</p></body></html>"

        result = extract_main_content(html, content_selectors=["article"])

        assert "ghost" not in result
        assert "real" in result

    def test_template_nested_in_container_is_stripped(self):
        html = """
        <html><body><article><template><p>ghost</p></template><p>real</p></article></body></html>
        """

        result = extract_main_content(html, content_selectors=["article"])

        assert "ghost" not in result
        assert "real" in result

    def test_script_style_and_noscript_are_stripped(self):
        html = """
        <html><body><article>
          <script>evil()</script>
          <style>.x{}</style>
          <noscript>enable js</noscript>
          <p>real</p>
        </article></body></html>
        """

        result = extract_main_content(html, content_selectors=["article"])

        assert "evil()" not in result
        assert ".x{}" not in result
        assert "enable js" not in result
        assert "real" in result

    def test_iframes_are_left_to_the_aggregators_policy(self):
        """Iframe filtering is a per-scraper decision -- see IFRAME_SANITIZE_SELECTOR."""
        html = """
        <html><body><article>
          <iframe src="https://platform.twitter.com/embed/tweet"></iframe>
        </article></body></html>
        """

        result = extract_main_content(html, content_selectors=["article"])

        assert "platform.twitter.com" in result

    def test_iframe_sanitize_selector_drops_foreign_iframes_and_keeps_youtube(self):
        html = """
        <html><body><article>
          <iframe src="https://ads.example.com/x"></iframe>
          <iframe src="https://www.youtube.com/embed/abc"></iframe>
        </article></body></html>
        """

        result = extract_main_content(
            html, content_selectors=["article"], remove_selectors=[IFRAME_SANITIZE_SELECTOR]
        )

        assert "ads.example.com" not in result
        assert "youtube.com/embed/abc" in result

    def test_sanitization_cannot_be_disabled_by_empty_ignore_list(self):
        html = "<html><body><article><script>evil()</script><p>real</p></article></body></html>"

        result = extract_main_content(html, content_selectors=["article"], remove_selectors=[])

        assert "evil()" not in result


class TestSharedDefaults:
    def test_default_content_selectors_match_ios(self):
        assert DEFAULT_CONTENT_SELECTORS == [
            "article",
            ".article-content",
            ".entry-content",
            "main",
        ]

    def test_default_ignore_selectors_match_ios(self):
        assert DEFAULT_IGNORE_SELECTORS == [
            ".advertisement",
            ".ad",
            ".ads",
            "[class*='advert']",
            "[class*='sponsor']",
            ".social-share",
            ".newsletter",
            ".related-articles",
        ]


class TestAggregatorSelectorAttributes:
    """Every FullWebsiteAggregator subclass exposes a selector *list*."""

    def test_all_website_aggregators_use_selector_lists(self):
        from core.aggregators.registry import AggregatorRegistry
        from core.aggregators.website import FullWebsiteAggregator

        for name, agg_class in AggregatorRegistry.get_all().items():
            if not issubclass(agg_class, FullWebsiteAggregator):
                continue
            selectors = agg_class.content_selectors
            assert isinstance(selectors, list), f"{name}: content_selectors must be a list"
            assert all(isinstance(entry, str) for entry in selectors), (
                f"{name}: entries must be str"
            )
            assert not hasattr(agg_class, "content_selector"), (
                f"{name}: legacy singular content_selector still present"
            )
