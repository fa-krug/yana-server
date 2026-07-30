"""Publisher YouTube iframes become click-through facades, not proxied iframes."""

from bs4 import BeautifulSoup

from core.aggregators.utils.block_parser import blocks_from_html
from core.aggregators.utils.youtube import (
    build_youtube_facade_html,
    create_youtube_embed_html,
    proxy_youtube_embeds,
)

VIDEO_ID = "dQw4w9WgXcQ"
WATCH_URL = f"https://www.youtube.com/watch?v={VIDEO_ID}"


def test_the_facade_carries_the_canonical_watch_url():
    html = build_youtube_facade_html(VIDEO_ID)
    soup = BeautifulSoup(html, "html.parser")
    container = soup.find("div")
    assert "youtube-embed-container" in container["class"]
    assert container["data-embed"] == f"https://www.youtube.com/embed/{VIDEO_ID}"
    assert container.find("a")["href"] == WATCH_URL


def test_the_facade_has_no_iframe_and_no_proxy_url():
    html = build_youtube_facade_html(VIDEO_ID)
    assert "<iframe" not in html
    assert "youtube-proxy" not in html


def test_the_facade_has_visible_text_so_it_survives_empty_element_pruning():
    """remove_empty_elements() drops a div with no text and no img/iframe/video.
    The anchor's text is what keeps the facade alive now that the iframe is gone."""
    soup = BeautifulSoup(build_youtube_facade_html(VIDEO_ID), "html.parser")
    assert soup.get_text(strip=True)


def test_create_youtube_embed_html_appends_a_caption():
    html = create_youtube_embed_html(VIDEO_ID, "<p>Caption</p>")
    assert "<p>Caption</p>" in html
    assert "<iframe" not in html


def test_a_publisher_iframe_is_replaced_by_a_facade():
    html = f'<iframe src="https://www.youtube.com/embed/{VIDEO_ID}"></iframe>'
    soup = BeautifulSoup(html, "html.parser")
    proxy_youtube_embeds(soup)
    assert soup.find("iframe") is None
    assert soup.find("a")["href"] == WATCH_URL


def test_a_youtu_be_iframe_is_replaced_by_a_facade():
    soup = BeautifulSoup(f'<iframe src="https://youtu.be/{VIDEO_ID}"></iframe>', "html.parser")
    proxy_youtube_embeds(soup)
    assert soup.find("iframe") is None
    assert soup.find("a")["href"] == WATCH_URL


def test_a_non_youtube_iframe_is_left_alone():
    soup = BeautifulSoup('<iframe src="https://vimeo.com/123456"></iframe>', "html.parser")
    proxy_youtube_embeds(soup)
    assert soup.find("iframe")["src"] == "https://vimeo.com/123456"


def test_an_unparseable_youtube_url_is_left_alone():
    soup = BeautifulSoup('<iframe src="https://www.youtube.com/invalid"></iframe>', "html.parser")
    proxy_youtube_embeds(soup)
    assert soup.find("iframe")["src"] == "https://www.youtube.com/invalid"


def test_several_iframes_are_each_handled():
    soup = BeautifulSoup(
        '<div><iframe src="https://www.youtube.com/embed/video111111"></iframe>'
        '<iframe src="https://other.com/embed"></iframe>'
        '<iframe src="https://www.youtube.com/embed/video222222"></iframe></div>',
        "html.parser",
    )
    proxy_youtube_embeds(soup)
    hrefs = {a["href"] for a in soup.find_all("a")}
    assert hrefs == {
        "https://www.youtube.com/watch?v=video111111",
        "https://www.youtube.com/watch?v=video222222",
    }
    assert [f["src"] for f in soup.find_all("iframe")] == ["https://other.com/embed"]


def test_the_facade_parses_into_a_youtube_embed_block():
    """The end-to-end point of the whole change: what the producer emits is what
    the parser turns into the block the client renders."""
    blocks = blocks_from_html(build_youtube_facade_html(VIDEO_ID))
    assert len(blocks) == 1
    assert blocks[0].provider == "youtube"
    assert blocks[0].external_url == WATCH_URL
