"""Tests for Bluesky embed functionality."""

from unittest.mock import patch

from bs4 import BeautifulSoup

from core.aggregators.utils.bluesky import (
    _escape,
    _format_count,
    _format_post_date,
    build_bluesky_embed_html,
    extract_bluesky_post_info,
    extract_image_urls_from_post,
    is_bluesky_url,
)


class TestUrlHelpers:
    """Tests for URL detection and parsing helpers."""

    def test_is_bluesky_url(self):
        assert is_bluesky_url("https://bsky.app/profile/user.bsky.social/post/abc123")
        assert is_bluesky_url("https://staging.bsky.app/profile/user/post/abc")
        assert not is_bluesky_url("https://x.com/user/status/123")
        assert not is_bluesky_url("https://example.com")
        assert not is_bluesky_url("")

    def test_extract_bluesky_post_info(self):
        result = extract_bluesky_post_info(
            "https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27"
        )
        assert result == ("stirpicus.bsky.social", "3mngsbu7t2s27")

    def test_extract_bluesky_post_info_with_did(self):
        result = extract_bluesky_post_info(
            "https://bsky.app/profile/did:plc:abc123/post/3mngsbu7t2s27"
        )
        assert result == ("did:plc:abc123", "3mngsbu7t2s27")

    def test_extract_bluesky_post_info_strips_query(self):
        result = extract_bluesky_post_info(
            "https://bsky.app/profile/user.bsky.social/post/abc123?foo=bar"
        )
        assert result == ("user.bsky.social", "abc123")

    def test_extract_bluesky_post_info_invalid(self):
        assert extract_bluesky_post_info("https://bsky.app/profile/user.bsky.social") is None
        assert extract_bluesky_post_info("https://example.com/not-a-post") is None
        assert extract_bluesky_post_info("") is None


class TestExtractImages:
    """Tests for extract_image_urls_from_post()."""

    def test_images_view(self):
        post = {
            "embed": {
                "$type": "app.bsky.embed.images#view",
                "images": [
                    {"fullsize": "https://cdn.bsky.app/img/1.jpg", "thumb": "t1"},
                    {"fullsize": "https://cdn.bsky.app/img/2.jpg", "thumb": "t2"},
                ],
            }
        }
        assert extract_image_urls_from_post(post) == [
            "https://cdn.bsky.app/img/1.jpg",
            "https://cdn.bsky.app/img/2.jpg",
        ]

    def test_record_with_media(self):
        post = {
            "embed": {
                "$type": "app.bsky.embed.recordWithMedia#view",
                "media": {
                    "$type": "app.bsky.embed.images#view",
                    "images": [{"fullsize": "https://cdn.bsky.app/img/1.jpg"}],
                },
            }
        }
        assert extract_image_urls_from_post(post) == ["https://cdn.bsky.app/img/1.jpg"]

    def test_thumb_fallback(self):
        post = {
            "embed": {
                "$type": "app.bsky.embed.images#view",
                "images": [{"thumb": "https://cdn.bsky.app/img/thumb.jpg"}],
            }
        }
        assert extract_image_urls_from_post(post) == ["https://cdn.bsky.app/img/thumb.jpg"]

    def test_no_images(self):
        assert (
            extract_image_urls_from_post({"embed": {"$type": "app.bsky.embed.external#view"}}) == []
        )
        assert extract_image_urls_from_post({}) == []


class TestBuildBlueskyEmbedHtml:
    """Tests for build_bluesky_embed_html()."""

    SAMPLE_POST = {
        "author": {
            "handle": "stirpicus.bsky.social",
            "displayName": "eric stirpe",
        },
        "record": {
            "text": "This is a test post.",
            "createdAt": "2026-06-04T04:34:34.364Z",
        },
        "likeCount": 3275,
        "repostCount": 868,
        "replyCount": 20,
        "embed": {
            "$type": "app.bsky.embed.images#view",
            "images": [{"fullsize": "https://cdn.bsky.app/img/1.jpg"}],
        },
    }

    @patch("core.aggregators.utils.bluesky.fetch_bluesky_post")
    def test_full_embed(self, mock_fetch):
        mock_fetch.return_value = self.SAMPLE_POST

        result = build_bluesky_embed_html(
            "https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27"
        )

        assert result is not None
        assert "<blockquote" in result
        assert "eric stirpe" in result
        assert "@stirpicus.bsky.social" in result
        assert "This is a test post." in result
        assert "View on Bluesky" in result
        assert "https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27" in result
        assert "https://cdn.bsky.app/img/1.jpg" in result
        assert "3.3K" in result  # likes
        assert "868" in result  # reposts
        assert "Jun 04, 2026" in result

    @patch("core.aggregators.utils.bluesky.fetch_bluesky_post")
    def test_embed_no_images(self, mock_fetch):
        mock_fetch.return_value = {
            "author": {"handle": "user.bsky.social", "displayName": ""},
            "record": {"text": "Text only post.", "createdAt": ""},
            "likeCount": 0,
            "repostCount": 0,
            "replyCount": 0,
            "embed": {},
        }

        result = build_bluesky_embed_html("https://bsky.app/profile/user.bsky.social/post/abc")

        assert result is not None
        assert "Text only post." in result
        assert "<img" not in result

    @patch("core.aggregators.utils.bluesky.fetch_bluesky_post")
    def test_embed_strips_tracking_params(self, mock_fetch):
        mock_fetch.return_value = self.SAMPLE_POST

        result = build_bluesky_embed_html(
            "https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27?foo=bar"
        )

        assert result is not None
        assert "?foo=bar" not in result
        assert "https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27" in result

    @patch("core.aggregators.utils.bluesky.fetch_bluesky_post")
    def test_embed_escapes_html(self, mock_fetch):
        mock_fetch.return_value = {
            "author": {"handle": "user.bsky.social", "displayName": "User <bad>"},
            "record": {"text": "Test <script>alert('xss')</script> & more", "createdAt": ""},
            "likeCount": 0,
            "repostCount": 0,
            "replyCount": 0,
            "embed": {},
        }

        result = build_bluesky_embed_html("https://bsky.app/profile/user.bsky.social/post/abc")

        assert result is not None
        assert "<script>" not in result
        assert "&lt;script&gt;" in result
        assert "&amp; more" in result

    def test_embed_invalid_url(self):
        assert build_bluesky_embed_html("https://example.com/not-a-post") is None

    @patch("core.aggregators.utils.bluesky.fetch_bluesky_post")
    def test_embed_api_failure(self, mock_fetch):
        mock_fetch.return_value = None

        result = build_bluesky_embed_html("https://bsky.app/profile/user.bsky.social/post/abc")
        assert result is None


class TestBuildBlueskyEmbedHtmlSecurity:
    """HTML-injection regression tests for build_bluesky_embed_html().

    Mirrors TestBuildTweetEmbedHtmlSecurity in test_twitter_embed.py -- asserts
    on the PARSED structure (BeautifulSoup element counts and attribute
    values), not just substring absence, so these prove the markup stays
    well-formed rather than merely pattern-matching escaped text.
    """

    def _post_data(self, **overrides):
        data = {
            "author": {"handle": "user.bsky.social", "displayName": "Test User"},
            "record": {"text": "Just a normal post.", "createdAt": ""},
            "likeCount": 10,
            "repostCount": 2,
            "replyCount": 0,
            "embed": {},
        }
        data.update(overrides)
        return data

    @patch("core.aggregators.utils.bluesky.fetch_bluesky_post")
    def test_post_url_with_quote_is_escaped_in_href(self, mock_fetch):
        mock_fetch.return_value = self._post_data()
        url = 'https://bsky.app/profile/user/post/abc"><script>alert(1)</script>'

        result = build_bluesky_embed_html(url)

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []
        anchors = soup.find_all("a")
        assert len(anchors) == 1
        assert anchors[0]["href"] == url.split("?")[0]

    @patch("core.aggregators.utils.bluesky.fetch_bluesky_post")
    def test_image_url_with_quote_and_markup_injects_nothing(self, mock_fetch):
        mock_fetch.return_value = self._post_data(
            embed={
                "$type": "app.bsky.embed.images#view",
                "images": [
                    {"fullsize": 'https://cdn.bsky.app/img/1.jpg"><script>alert(1)</script>'},
                ],
            },
        )

        result = build_bluesky_embed_html("https://bsky.app/profile/user/post/abc")

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []
        assert len(soup.find_all("img")) == 1

    @patch("core.aggregators.utils.bluesky.fetch_bluesky_post")
    def test_javascript_post_url_is_not_rendered_as_href(self, mock_fetch):
        mock_fetch.return_value = self._post_data()

        result = build_bluesky_embed_html("javascript:alert(1)//profile/user/post/abc")

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        for a in soup.find_all("a"):
            assert not a.get("href", "").lower().startswith("javascript:")

    @patch("core.aggregators.utils.bluesky.fetch_bluesky_post")
    def test_javascript_image_url_is_skipped(self, mock_fetch):
        mock_fetch.return_value = self._post_data(
            embed={
                "$type": "app.bsky.embed.images#view",
                "images": [{"fullsize": "javascript:alert(1)"}],
            },
        )

        result = build_bluesky_embed_html("https://bsky.app/profile/user/post/abc")

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("img") == []

    @patch("core.aggregators.utils.bluesky.fetch_bluesky_post")
    def test_data_image_url_is_skipped(self, mock_fetch):
        mock_fetch.return_value = self._post_data(
            embed={
                "$type": "app.bsky.embed.images#view",
                "images": [{"fullsize": "data:text/html,<script>alert(1)</script>"}],
            },
        )

        result = build_bluesky_embed_html("https://bsky.app/profile/user/post/abc")

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("img") == []

    @patch("core.aggregators.utils.bluesky.fetch_bluesky_post")
    def test_author_and_text_with_apostrophe_and_script_are_escaped(self, mock_fetch):
        mock_fetch.return_value = self._post_data(
            author={"handle": "o'brien.bsky.social", "displayName": ""},
            record={"text": "It's a <script>alert(1)</script> post", "createdAt": ""},
        )

        result = build_bluesky_embed_html("https://bsky.app/profile/user/post/abc")

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []
        assert "o'brien" not in result  # raw apostrophe must not survive unescaped
        assert "@o&#x27;brien.bsky.social" in result
        text_p = soup.find_all("p")[1]
        assert text_p.get_text() == "It's a <script>alert(1)</script> post"

    @patch("core.aggregators.utils.bluesky.fetch_bluesky_post")
    def test_normal_post_regression(self, mock_fetch):
        mock_fetch.return_value = self._post_data()

        result = build_bluesky_embed_html("https://bsky.app/profile/user/post/abc")

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert len(soup.find_all("blockquote")) == 1
        anchors = soup.find_all("a")
        assert len(anchors) == 1
        assert anchors[0]["href"] == "https://bsky.app/profile/user/post/abc"
        assert anchors[0].get_text() == "View on Bluesky"


class TestHelperFunctions:
    """Tests for helper functions."""

    def test_escape(self):
        assert _escape("<b>bold</b>") == "&lt;b&gt;bold&lt;/b&gt;"
        assert _escape('a "quote"') == "a &quot;quote&quot;"
        assert _escape("a & b") == "a &amp; b"

    def test_format_count(self):
        assert _format_count(0) == "0"
        assert _format_count(999) == "999"
        assert _format_count(1234) == "1.2K"
        assert _format_count(1500000) == "1.5M"

    def test_format_post_date_valid(self):
        assert _format_post_date("2026-06-04T04:34:34.364Z") == "Jun 04, 2026"

    def test_format_post_date_invalid(self):
        assert _format_post_date("not a date") is None
        assert _format_post_date("") is None
        assert _format_post_date(None) is None


class TestBlueskyEmbedProcessor:
    """Tests for the mein_mmo BlueskyEmbedProcessor."""

    def test_can_handle_bluesky_figure(self):
        from core.aggregators.mein_mmo.embed_processors import BlueskyEmbedProcessor

        figure = BeautifulSoup(
            '<figure><a href="https://bsky.app/profile/user.bsky.social/post/abc">link</a></figure>',
            "html.parser",
        ).figure
        assert BlueskyEmbedProcessor().can_handle(figure) is True

    def test_can_handle_non_bluesky_figure(self):
        from core.aggregators.mein_mmo.embed_processors import BlueskyEmbedProcessor

        figure = BeautifulSoup(
            '<figure><a href="https://x.com/user/status/123">link</a></figure>',
            "html.parser",
        ).figure
        assert BlueskyEmbedProcessor().can_handle(figure) is False

    @patch("core.aggregators.mein_mmo.embed_processors.build_bluesky_embed_html")
    def test_process_replaces_figure(self, mock_build):
        import logging

        from core.aggregators.mein_mmo.embed_processors import process_embeds

        mock_build.return_value = "<blockquote><p>Bluesky post text</p></blockquote>"

        soup = BeautifulSoup(
            '<div><figure class="wp-block-embed">'
            '<a href="https://bsky.app/profile/user.bsky.social/post/abc">link</a>'
            "</figure></div>",
            "html.parser",
        )
        content = soup.div

        process_embeds(content, logging.getLogger("test"))

        assert content.find("figure") is None
        assert "Bluesky post text" in str(content)
        assert content.find("div", attrs={"data-sanitized-class": "bluesky-embed"}) is not None

    @patch("core.aggregators.mein_mmo.embed_processors.build_bluesky_embed_html")
    def test_process_removes_figure_when_embed_fails(self, mock_build):
        import logging

        from core.aggregators.mein_mmo.embed_processors import process_embeds

        mock_build.return_value = None

        soup = BeautifulSoup(
            '<div><figure class="wp-block-embed">'
            '<a href="https://bsky.app/profile/user.bsky.social/post/abc">link</a>'
            "</figure></div>",
            "html.parser",
        )
        content = soup.div

        process_embeds(content, logging.getLogger("test"))

        # Figure is removed when no embed could be built
        assert content.find("figure") is None
