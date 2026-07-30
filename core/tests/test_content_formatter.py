"""format_article_content: sections in, no source-link footer out."""

from core.aggregators.utils import format_article_content


def test_no_footer_is_emitted():
    html = format_article_content("<p>body</p>", title="T", url="https://example.com/a")
    assert "<footer" not in html
    assert "Source:" not in html


def test_the_article_url_does_not_leak_into_the_body():
    url = "https://example.com/very-specific-path"
    assert url not in format_article_content("<p>body</p>", title="T", url=url)


def test_the_content_section_survives():
    html = format_article_content("<p>body</p>", title="T", url="https://example.com/a")
    assert '<section data-sanitized-class="article-content"><p>body</p></section>' in html


def test_a_header_still_renders_before_the_content():
    html = format_article_content(
        "<p>body</p>",
        title="T",
        url="https://example.com/a",
        header_image_url="yana-img://" + "a" * 64,
    )
    assert html.index("<header") < html.index("article-content")


def test_comments_still_render_after_the_content():
    html = format_article_content(
        "<p>body</p>", title="T", url="https://example.com/a", comments_content="<p>c</p>"
    )
    assert html.index("article-content") < html.index("article-comments")


def test_a_prebuilt_header_is_used_verbatim():
    html = format_article_content(
        "<p>body</p>", title="T", url="https://example.com/a", header_html="<header>HI</header>"
    )
    assert "<header>HI</header>" in html
