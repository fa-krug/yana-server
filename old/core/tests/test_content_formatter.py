"""format_article_content: sections in, no source-link footer out."""

from bs4 import BeautifulSoup

from core.aggregators.utils import build_header_html, format_article_content


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


IMG_URL = "https://example.com/photo.jpg"


class TestBuildHeaderHtmlEscapesTitle:
    """A title can legitimately contain '"', '<', '&' etc. after HTML-entity
    unescaping (see core/tests/test_feed_entity_unescaping.py). build_header_html
    interpolates the title into an ``alt`` attribute, so it must escape it at
    that point -- the header HTML is assembled after clean_html() has already
    run, so nothing downstream will sanitize it.
    """

    def test_a_quote_in_the_title_does_not_terminate_the_attribute(self):
        title = 'Company "X" sues rival'
        header = build_header_html(IMG_URL, title=title)

        soup = BeautifulSoup(header, "html.parser")
        imgs = soup.find_all("img")
        assert len(imgs) == 1
        assert imgs[0]["alt"] == title
        assert "&quot;" in header or "&#34;" in header

    def test_a_markup_payload_in_the_title_does_not_create_a_new_element(self):
        title = "Breaking: <img src=x onerror=alert(1)>"
        header = build_header_html(IMG_URL, title=title)

        soup = BeautifulSoup(header, "html.parser")
        imgs = soup.find_all("img")
        # Only the legitimate header image -- the payload must not parse as
        # a second <img> element.
        assert len(imgs) == 1
        assert imgs[0]["alt"] == title
        assert "onerror" not in [attr for tag in soup.find_all() for attr in tag.attrs]

    def test_an_ampersand_in_the_title_round_trips_to_a_single_ampersand(self):
        title = "Rock & Roll Hall of Fame announces inductees"
        header = build_header_html(IMG_URL, title=title)

        soup = BeautifulSoup(header, "html.parser")
        imgs = soup.find_all("img")
        assert len(imgs) == 1
        assert imgs[0]["alt"] == title
        assert "&amp;" in header
        # A raw, un-escaped ampersand must not appear in the markup.
        assert " & " not in header

    def test_a_plain_ascii_title_is_unaffected(self):
        title = "Samsung's Galaxy Watch 9 is $40 off"
        header = build_header_html(IMG_URL, title=title)

        soup = BeautifulSoup(header, "html.parser")
        imgs = soup.find_all("img")
        assert len(imgs) == 1
        assert imgs[0]["alt"] == title
