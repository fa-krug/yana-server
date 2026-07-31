"""Tests for Reddit content building -- HTML injection and sanitization.

These assert on the PARSED structure (BeautifulSoup element counts and
attribute values), not just substring absence, so they prove the markup stays
well-formed rather than merely pattern-matching escaped text.
"""

from unittest.mock import patch

from bs4 import BeautifulSoup

from core.aggregators.reddit.content import (
    _add_comments_section,
    _add_link_media,
    _process_gallery_item,
    _process_link_media,
)
from core.aggregators.reddit.types import RedditPostData


def _make_post(**overrides):
    data = {
        "id": "abc123",
        "title": "Test post",
        "selftext": "",
        "url": "",
        "permalink": "/r/test/comments/abc123/test/",
        "created_utc": 1704024000,
        "author": "user1",
        "is_self": True,
        "is_gallery": False,
    }
    data.update(overrides)
    return RedditPostData(data)


class TestGalleryItemSecurity:
    def test_caption_with_quote_and_markup_does_not_break_attribute(self):
        post = _make_post(
            is_gallery=True,
            media_metadata={"img1": {"e": "Image", "s": {"u": "https://i.redd.it/x.jpg"}}},
            gallery_data={
                "items": [
                    {"media_id": "img1", "caption": '"><script>alert(1)</script>'},
                ]
            },
        )
        item = post.gallery_data["items"][0]

        html = _process_gallery_item(item, post)

        assert html is not None
        soup = BeautifulSoup(html, "html.parser")
        assert soup.find_all("script") == []
        imgs = soup.find_all("img")
        assert len(imgs) == 1
        assert imgs[0]["alt"] == '"><script>alert(1)</script>'
        figcaptions = soup.find_all("figcaption")
        assert len(figcaptions) == 1
        assert figcaptions[0].get_text() == '"><script>alert(1)</script>'

    def test_media_url_with_quote_is_escaped(self):
        post = _make_post(
            is_gallery=True,
            media_metadata={
                "img1": {
                    "e": "Image",
                    "s": {"u": 'https://i.redd.it/x.jpg"onload="alert(1)'},
                }
            },
            gallery_data={"items": [{"media_id": "img1"}]},
        )
        item = post.gallery_data["items"][0]

        html = _process_gallery_item(item, post)

        assert html is not None
        soup = BeautifulSoup(html, "html.parser")
        imgs = soup.find_all("img")
        assert len(imgs) == 1
        assert "onload" not in imgs[0].attrs
        assert imgs[0]["src"] == 'https://i.redd.it/x.jpg"onload="alert(1)'

    def test_javascript_media_url_is_skipped(self):
        post = _make_post(
            is_gallery=True,
            media_metadata={"img1": {"e": "Image", "s": {"u": "javascript:alert(1)"}}},
            gallery_data={"items": [{"media_id": "img1"}]},
        )
        item = post.gallery_data["items"][0]

        assert _process_gallery_item(item, post) is None

    def test_data_media_url_is_skipped(self):
        post = _make_post(
            is_gallery=True,
            media_metadata={
                "img1": {
                    "e": "Image",
                    "s": {"u": "data:text/html,<script>alert(1)</script>"},
                }
            },
            gallery_data={"items": [{"media_id": "img1"}]},
        )
        item = post.gallery_data["items"][0]

        assert _process_gallery_item(item, post) is None

    def test_normal_gallery_item_regression(self):
        post = _make_post(
            is_gallery=True,
            media_metadata={"img1": {"e": "Image", "s": {"u": "https://i.redd.it/x.jpg"}}},
            gallery_data={"items": [{"media_id": "img1", "caption": "A nice photo"}]},
        )
        item = post.gallery_data["items"][0]

        html = _process_gallery_item(item, post)

        assert html is not None
        soup = BeautifulSoup(html, "html.parser")
        imgs = soup.find_all("img")
        assert len(imgs) == 1
        assert imgs[0]["src"] == "https://i.redd.it/x.jpg"
        assert imgs[0]["alt"] == "A nice photo"


class TestLinkMediaSecurity:
    def test_direct_image_url_with_quote_is_escaped(self):
        post = _make_post(url='https://i.redd.it/x.jpg"><script>alert(1)</script>', is_self=False)
        parts: list[str] = []

        _add_link_media(post, parts, is_cross_post=False)

        html = "".join(parts)
        soup = BeautifulSoup(html, "html.parser")
        assert soup.find_all("script") == []
        anchors = soup.find_all("a")
        assert len(anchors) == 1
        assert anchors[0]["href"] == post.url

    def test_youtube_url_with_javascript_scheme_is_not_rendered_as_href(self):
        post = _make_post(url="javascript:alert(1)//youtube.com/watch?v=x", is_self=False)
        parts: list[str] = []

        _add_link_media(post, parts, is_cross_post=False)

        html = "".join(parts)
        soup = BeautifulSoup(html, "html.parser")
        assert soup.find_all("a") == []
        assert "View Video on YouTube" in html

    def test_fallback_link_with_quote_is_escaped(self):
        post = _make_post(url='https://example.com/x"><script>alert(1)</script>', is_self=False)
        parts: list[str] = []

        _add_link_media(post, parts, is_cross_post=False)

        html = "".join(parts)
        soup = BeautifulSoup(html, "html.parser")
        assert soup.find_all("script") == []
        anchors = soup.find_all("a")
        assert len(anchors) == 1

    def test_gif_url_with_quote_is_escaped(self):
        post = _make_post(url='https://i.redd.it/x"onload="alert(1).gif', is_self=False)
        parts: list[str] = []

        handled = _process_link_media(post, post.url, parts)
        assert handled is True

        rendered = "".join(parts)
        soup = BeautifulSoup(rendered, "html.parser")
        imgs = soup.find_all("img")
        assert len(imgs) == 1
        assert "onload" not in imgs[0].attrs

    def test_normal_direct_image_link_regression(self):
        post = _make_post(url="https://i.redd.it/cool.jpg", is_self=False)
        parts: list[str] = []

        _add_link_media(post, parts, is_cross_post=False)

        html = "".join(parts)
        soup = BeautifulSoup(html, "html.parser")
        anchors = soup.find_all("a")
        assert len(anchors) == 1
        assert anchors[0]["href"] == "https://i.redd.it/cool.jpg"


class TestCommentsSectionHeaderLink:
    @patch("core.aggregators.reddit.content.fetch_post_comments", return_value=[])
    def test_permalink_with_quote_and_script_does_not_break_markup(self, mock_fetch):
        post = _make_post(permalink='/r/test/comments/abc"><script>alert(1)</script>/x/')
        content_parts: list[str] = []

        _add_comments_section(post, 5, "test", 1, content_parts)

        html = "".join(content_parts)
        soup = BeautifulSoup(html, "html.parser")
        assert soup.find_all("script") == []
        anchors = soup.find_all("a")
        assert len(anchors) == 1
        assert anchors[0]["href"] == (
            'https://reddit.com/r/test/comments/abc"><script>alert(1)</script>/x/'
        )
        assert anchors[0].get_text() == "Comments"

    @patch("core.aggregators.reddit.content.fetch_post_comments", return_value=[])
    def test_normal_permalink_regression(self, mock_fetch):
        post = _make_post(permalink="/r/test/comments/abc123/title/")
        content_parts: list[str] = []

        _add_comments_section(post, 5, "test", 1, content_parts)

        html = "".join(content_parts)
        soup = BeautifulSoup(html, "html.parser")
        anchors = soup.find_all("a")
        assert len(anchors) == 1
        assert anchors[0]["href"] == "https://reddit.com/r/test/comments/abc123/title/"
