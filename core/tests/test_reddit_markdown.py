"""Tests for Reddit markdown conversion -- HTML injection and sanitization.

Reddit markdown can carry raw HTML and arbitrary link targets, and the
markdown library passes both straight through unmodified. These tests assert
on the PARSED structure (BeautifulSoup element counts and attribute values),
not just substring absence, so they prove the markup stays well-formed rather
than merely pattern-matching escaped text.
"""

from bs4 import BeautifulSoup

from core.aggregators.reddit.markdown import (
    convert_reddit_markdown,
    safe_img_html,
    safe_link_html,
)


class TestSafeLinkHtml:
    def test_quote_in_url_is_escaped_not_breaking_attribute(self):
        result = safe_link_html('https://example.com/x"><script>alert(1)</script>', "text")
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []
        anchors = soup.find_all("a")
        assert len(anchors) == 1
        assert anchors[0]["href"] == 'https://example.com/x"><script>alert(1)</script>'

    def test_javascript_url_renders_as_bare_text(self):
        result = safe_link_html("javascript:alert(1)", "click me")
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("a") == []
        assert soup.get_text() == "click me"

    def test_data_url_renders_as_bare_text(self):
        result = safe_link_html("data:text/html,<script>alert(1)</script>", "click me")
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("a") == []
        assert soup.find_all("script") == []

    def test_none_url_renders_as_bare_text(self):
        result = safe_link_html(None, "text")
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("a") == []
        assert soup.get_text() == "text"

    def test_text_with_script_and_apostrophe_is_escaped(self):
        result = safe_link_html("https://example.com", "It's a <script>alert(1)</script>")
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []
        assert soup.find("a").get_text() == "It's a <script>alert(1)</script>"


class TestSafeImgHtml:
    def test_quote_in_url_is_escaped_not_breaking_attribute(self):
        result = safe_img_html('https://example.com/x.jpg"onload="alert(1)', "alt text")
        soup = BeautifulSoup(result, "html.parser")
        imgs = soup.find_all("img")
        assert len(imgs) == 1
        assert "onload" not in imgs[0].attrs
        assert imgs[0]["src"] == 'https://example.com/x.jpg"onload="alert(1)'

    def test_javascript_url_is_skipped(self):
        assert safe_img_html("javascript:alert(1)", "alt") == ""

    def test_data_url_is_skipped(self):
        assert safe_img_html("data:text/html,<script>alert(1)</script>", "alt") == ""

    def test_none_url_is_skipped(self):
        assert safe_img_html(None, "alt") == ""

    def test_alt_with_quote_and_markup_is_escaped(self):
        result = safe_img_html("https://example.com/x.jpg", '"><script>alert(1)</script>')
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []
        imgs = soup.find_all("img")
        assert len(imgs) == 1
        assert imgs[0]["alt"] == '"><script>alert(1)</script>'


class TestConvertRedditMarkdownSecurity:
    """Attacks embedded directly in selftext/comment markdown."""

    def test_raw_script_tag_does_not_survive(self):
        result = convert_reddit_markdown("Hello <script>alert(1)</script> world")
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []

    def test_onerror_attribute_does_not_survive(self):
        result = convert_reddit_markdown("<img src=x onerror=alert(1)>")
        soup = BeautifulSoup(result, "html.parser")
        for img in soup.find_all("img"):
            assert "onerror" not in img.attrs

    def test_javascript_link_target_is_not_rendered_as_href(self):
        result = convert_reddit_markdown("[click me](javascript:alert(1))")
        soup = BeautifulSoup(result, "html.parser")
        for a in soup.find_all("a"):
            assert not (a.get("href") or "").lower().startswith("javascript:")

    def test_data_scheme_link_is_not_rendered_as_href(self):
        result = convert_reddit_markdown("[click me](data:text/html,<script>alert(1)</script>)")
        soup = BeautifulSoup(result, "html.parser")
        for a in soup.find_all("a"):
            assert not (a.get("href") or "").lower().startswith("data:")
        assert soup.find_all("script") == []

    def test_preview_image_url_with_quote_is_escaped(self):
        result = convert_reddit_markdown('https://preview.redd.it/x.jpg"onload="alert(1)')
        soup = BeautifulSoup(result, "html.parser")
        imgs = soup.find_all("img")
        assert len(imgs) == 1
        assert "onload" not in imgs[0].attrs


class TestConvertRedditMarkdownLegitimateRoundTrip:
    """Ordinary markdown must survive the sanitize boundary unscathed and not
    be double-escaped."""

    def test_bold_and_italic(self):
        result = convert_reddit_markdown("**bold** and *italic*")
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find("strong").get_text() == "bold"
        assert soup.find("em").get_text() == "italic"

    def test_bulleted_list(self):
        result = convert_reddit_markdown("- item one\n- item two")
        soup = BeautifulSoup(result, "html.parser")
        items = soup.find_all("li")
        assert [li.get_text() for li in items] == ["item one", "item two"]

    def test_blockquote(self):
        result = convert_reddit_markdown("> quoted text")
        soup = BeautifulSoup(result, "html.parser")
        blockquote = soup.find("blockquote")
        assert blockquote is not None
        assert "quoted text" in blockquote.get_text()

    def test_inline_code(self):
        result = convert_reddit_markdown("some `inline code` here")
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find("code").get_text() == "inline code"

    def test_fenced_code_block_not_double_escaped(self):
        result = convert_reddit_markdown('```python\nprint("hi & bye")\n```')
        soup = BeautifulSoup(result, "html.parser")
        code = soup.find("code")
        assert code is not None
        assert code.get_text().strip() == 'print("hi & bye")'
        # A single, correct escape of '&' is expected (as &amp; in the raw
        # HTML); a double-escape would show up as a literal '&amp;amp;'.
        assert "&amp;amp;" not in result

    def test_https_link(self):
        result = convert_reddit_markdown("check out [my site](https://example.com/page)")
        soup = BeautifulSoup(result, "html.parser")
        anchors = soup.find_all("a")
        assert len(anchors) == 1
        assert anchors[0]["href"] == "https://example.com/page"
        assert anchors[0].get_text() == "my site"
        assert anchors[0]["target"] == "_blank"

    def test_normal_paragraph_regression(self):
        result = convert_reddit_markdown("Just a normal paragraph of text.")
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find("p").get_text() == "Just a normal paragraph of text."
