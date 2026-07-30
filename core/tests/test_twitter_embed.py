"""Tests for Twitter/X embed functionality."""

from unittest.mock import patch

from bs4 import BeautifulSoup

from core.aggregators.utils.twitter import (
    _escape,
    _format_count,
    _format_tweet_date,
    build_tweet_embed_html,
)


class TestBuildTweetEmbedHtml:
    """Tests for build_tweet_embed_html()."""

    SAMPLE_TWEET_DATA = {
        "tweet": {
            "text": "This is a test tweet with some content.",
            "author": {
                "name": "Test User",
                "screen_name": "testuser",
            },
            "likes": 1234,
            "retweets": 567,
            "created_at": "Wed Jan 15 12:34:56 +0000 2026",
            "media": {
                "photos": [
                    {"url": "https://pbs.twimg.com/media/test1.jpg"},
                    {"url": "https://pbs.twimg.com/media/test2.jpg"},
                ],
            },
        },
    }

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_full_embed(self, mock_fetch):
        mock_fetch.return_value = self.SAMPLE_TWEET_DATA

        result = build_tweet_embed_html("https://x.com/testuser/status/123456")

        assert result is not None
        assert "<blockquote" in result
        assert "@testuser" in result
        assert "This is a test tweet" in result
        assert "View on X" in result
        assert "https://x.com/testuser/status/123456" in result
        assert "https://pbs.twimg.com/media/test1.jpg" in result
        assert "https://pbs.twimg.com/media/test2.jpg" in result
        assert "1.2K" in result  # likes
        assert "567" in result  # retweets
        assert "Jan 15, 2026" in result

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_embed_no_images(self, mock_fetch):
        data = {
            "tweet": {
                "text": "Text only tweet.",
                "author": {"name": "User", "screen_name": "user"},
                "likes": 0,
                "retweets": 0,
                "created_at": "",
                "media": {},
            },
        }
        mock_fetch.return_value = data

        result = build_tweet_embed_html("https://x.com/user/status/999")

        assert result is not None
        assert "Text only tweet." in result
        assert "<img" not in result

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_embed_no_engagement_stats(self, mock_fetch):
        data = {
            "tweet": {
                "text": "A tweet.",
                "author": {"name": "User", "screen_name": "user"},
                "likes": 0,
                "retweets": 0,
                "created_at": "",
                "media": {},
            },
        }
        mock_fetch.return_value = data

        result = build_tweet_embed_html("https://x.com/user/status/999")

        assert result is not None
        # No stats line when all zeros and no date
        assert "color: #536471" not in result

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_embed_strips_tracking_params(self, mock_fetch):
        mock_fetch.return_value = self.SAMPLE_TWEET_DATA

        result = build_tweet_embed_html("https://x.com/testuser/status/123456?s=20&t=abc")

        assert result is not None
        assert "?s=20" not in result
        assert "https://x.com/testuser/status/123456" in result

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_embed_escapes_html(self, mock_fetch):
        data = {
            "tweet": {
                "text": "Test <script>alert('xss')</script> & more",
                "author": {"name": "User", "screen_name": "user<bad>"},
                "likes": 0,
                "retweets": 0,
                "created_at": "",
                "media": {},
            },
        }
        mock_fetch.return_value = data

        result = build_tweet_embed_html("https://x.com/user/status/999")

        assert result is not None
        assert "<script>" not in result
        assert "&lt;script&gt;" in result
        assert "&amp; more" in result

    def test_embed_invalid_url(self):
        result = build_tweet_embed_html("https://example.com/not-a-tweet")
        assert result is None

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_embed_api_failure(self, mock_fetch):
        mock_fetch.return_value = None

        result = build_tweet_embed_html("https://x.com/user/status/123")
        assert result is None

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_embed_empty_tweet(self, mock_fetch):
        mock_fetch.return_value = {"tweet": {}}

        result = build_tweet_embed_html("https://x.com/user/status/123")

        # Empty dict is falsy, so returns None
        assert result is None

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_embed_minimal_tweet(self, mock_fetch):
        mock_fetch.return_value = {
            "tweet": {
                "text": "Hello",
                "author": {"screen_name": "user"},
            },
        }

        result = build_tweet_embed_html("https://x.com/user/status/123")

        assert result is not None
        assert "<blockquote" in result
        assert "Hello" in result

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_embed_twitter_com_url(self, mock_fetch):
        mock_fetch.return_value = self.SAMPLE_TWEET_DATA

        result = build_tweet_embed_html("https://twitter.com/testuser/status/123456")

        assert result is not None
        assert "https://twitter.com/testuser/status/123456" in result


class TestBuildTweetEmbedHtmlSecurity:
    """HTML-injection regression tests for build_tweet_embed_html().

    These assert on the PARSED structure (BeautifulSoup element counts and
    attribute values), not just substring absence, so they prove the markup
    stays well-formed rather than merely pattern-matching escaped text.
    """

    def _tweet_data(self, **overrides):
        data = {
            "text": "Just a normal tweet.",
            "author": {"name": "Test User", "screen_name": "testuser"},
            "likes": 10,
            "retweets": 2,
            "created_at": "",
            "media": {},
        }
        data.update(overrides)
        return {"tweet": data}

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_tweet_url_with_quote_is_escaped_in_href(self, mock_fetch):
        mock_fetch.return_value = self._tweet_data()
        # A tweet URL containing a literal double quote (e.g. reached via a
        # malformed/attacker-influenced source URL upstream).
        url = 'https://x.com/user/status/123456"><script>alert(1)</script>'

        result = build_tweet_embed_html(url)

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        # No injected <script> element -- the quote must not have terminated
        # the href attribute early.
        assert soup.find_all("script") == []
        anchors = soup.find_all("a")
        assert len(anchors) == 1
        assert anchors[0]["href"] == url.split("?")[0]

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_image_url_with_quote_and_markup_injects_nothing(self, mock_fetch):
        mock_fetch.return_value = self._tweet_data(
            media={
                "photos": [
                    {"url": 'https://pbs.twimg.com/media/x.jpg"><script>alert(1)</script>'},
                ],
            },
        )

        result = build_tweet_embed_html("https://x.com/user/status/123456")

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []
        imgs = soup.find_all("img")
        assert len(imgs) == 1

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_javascript_tweet_url_is_not_rendered_as_href(self, mock_fetch):
        mock_fetch.return_value = self._tweet_data()

        result = build_tweet_embed_html("javascript:alert(1)//status/123")

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        for a in soup.find_all("a"):
            assert not a.get("href", "").lower().startswith("javascript:")

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_javascript_image_url_is_skipped(self, mock_fetch):
        mock_fetch.return_value = self._tweet_data(
            media={"photos": [{"url": "javascript:alert(1)"}]},
        )

        result = build_tweet_embed_html("https://x.com/user/status/123456")

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("img") == []

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_data_image_url_is_skipped(self, mock_fetch):
        mock_fetch.return_value = self._tweet_data(
            media={"photos": [{"url": "data:text/html,<script>alert(1)</script>"}]},
        )

        result = build_tweet_embed_html("https://x.com/user/status/123456")

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("img") == []

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_author_and_text_with_apostrophe_and_script_are_escaped(self, mock_fetch):
        mock_fetch.return_value = self._tweet_data(
            text="It's a <script>alert(1)</script> tweet",
            author={"name": "User", "screen_name": "o'brien"},
        )

        result = build_tweet_embed_html("https://x.com/user/status/123456")

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []
        assert "o'brien" not in result  # raw apostrophe must not survive unescaped
        assert "@o&#x27;brien" in result
        text_p = soup.find_all("p")[1]
        assert text_p.get_text() == "It's a <script>alert(1)</script> tweet"

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_normal_tweet_regression(self, mock_fetch):
        mock_fetch.return_value = self._tweet_data()

        result = build_tweet_embed_html("https://x.com/user/status/123456")

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert len(soup.find_all("blockquote")) == 1
        anchors = soup.find_all("a")
        assert len(anchors) == 1
        assert anchors[0]["href"] == "https://x.com/user/status/123456"
        assert anchors[0].get_text() == "View on X"


class TestHelperFunctions:
    """Tests for helper functions."""

    def test_escape(self):
        assert _escape("<b>bold</b>") == "&lt;b&gt;bold&lt;/b&gt;"
        assert _escape('a "quote"') == "a &quot;quote&quot;"
        assert _escape("a & b") == "a &amp; b"
        assert _escape("normal text") == "normal text"

    def test_format_count(self):
        assert _format_count(0) == "0"
        assert _format_count(999) == "999"
        assert _format_count(1000) == "1.0K"
        assert _format_count(1234) == "1.2K"
        assert _format_count(999999) == "1000.0K"
        assert _format_count(1000000) == "1.0M"
        assert _format_count(1500000) == "1.5M"

    def test_format_tweet_date_valid(self):
        result = _format_tweet_date("Wed Jan 15 12:34:56 +0000 2026")
        assert result == "Jan 15, 2026"

    def test_format_tweet_date_invalid(self):
        assert _format_tweet_date("invalid date") is None
        assert _format_tweet_date("") is None
        assert _format_tweet_date(None) is None


class TestRedditContentTwitterIntegration:
    """Tests for Twitter/X handling in Reddit content building."""

    def test_process_link_media_twitter(self):
        """Twitter/X links are consumed but not added to body (embed is in header)."""
        from core.aggregators.reddit.content import _process_link_media
        from core.aggregators.reddit.types import RedditPostData

        post = RedditPostData(
            {
                "id": "test123",
                "title": "Check this tweet",
                "url": "https://x.com/user/status/123",
                "selftext": "",
                "author": "testuser",
                "permalink": "/r/test/comments/test123/check_this_tweet/",
                "created_utc": 1700000000,
                "num_comments": 5,
            }
        )

        content_parts = []
        result = _process_link_media(post, "https://x.com/user/status/123", content_parts)

        assert result is True
        assert len(content_parts) == 0  # Embed handled by header, not body

    def test_process_link_media_twitter_dot_com(self):
        """twitter.com links are also consumed for header embedding."""
        from core.aggregators.reddit.content import _process_link_media
        from core.aggregators.reddit.types import RedditPostData

        post = RedditPostData(
            {
                "id": "test123",
                "title": "Check this tweet",
                "url": "https://twitter.com/user/status/123",
                "selftext": "",
                "author": "testuser",
                "permalink": "/r/test/comments/test123/check_this_tweet/",
                "created_utc": 1700000000,
                "num_comments": 5,
            }
        )

        content_parts = []
        result = _process_link_media(post, "https://twitter.com/user/status/123", content_parts)

        assert result is True
        assert len(content_parts) == 0  # Embed handled by header, not body


class TestTwitterUrlInSelftext:
    """Tests for Twitter/X URLs found in selftext being used for header embeds."""

    def test_selftext_twitter_url_returns_twitter_url_for_header(self):
        """When a self post contains a Twitter/X URL in selftext,
        extract_header_image_url should return the Twitter URL directly
        so it can be embedded as a tweet, not treated as an image source."""
        from core.aggregators.reddit.images import extract_header_image_url
        from core.aggregators.reddit.types import RedditPostData

        post = RedditPostData(
            {
                "id": "1rfwhe3",
                "title": "Did anyone's usage just get reset?",
                "selftext": (
                    "Just logged in after heavy usage, then saw the week just reset\n\n"
                    "anyone know why or how?\n\n"
                    "REASON: https://x.com/trq212/status/2027232172810416493"
                ),
                "url": "https://reddit.com/r/ClaudeCode/comments/1rfwhe3/did_anyones_usage_just_get_reset/",
                "author": "testuser",
                "permalink": "/r/ClaudeCode/comments/1rfwhe3/did_anyones_usage_just_get_reset/",
                "created_utc": 1700000000,
                "num_comments": 10,
                "is_self": True,
            }
        )

        result = extract_header_image_url(post)

        assert result == "https://x.com/trq212/status/2027232172810416493"

    def test_selftext_twitter_url_not_used_for_image_extraction(self):
        """Twitter/X URLs in selftext should not be passed to ImageExtractor
        for image extraction (which would return wrong placeholder images)."""
        from core.aggregators.reddit.images import _extract_image_url_from_selftext
        from core.aggregators.reddit.types import RedditPostData

        post = RedditPostData(
            {
                "id": "test123",
                "title": "Test post",
                "selftext": "Check this: https://x.com/user/status/123456",
                "url": "https://reddit.com/r/test/comments/test123/test_post/",
                "author": "testuser",
                "permalink": "/r/test/comments/test123/test_post/",
                "created_utc": 1700000000,
                "num_comments": 5,
                "is_self": True,
            }
        )

        # _extract_image_url_from_selftext should NOT return anything from a
        # Twitter URL because it would get a wrong image. Twitter URLs are
        # handled by the header embed flow instead.
        result = _extract_image_url_from_selftext(post)

        # Should be None because we don't extract images from Twitter URLs
        assert result is None

    def test_selftext_twitter_url_with_other_image(self):
        """When selftext has both a Twitter URL and a direct image URL,
        the image URL should be used for image extraction (not the Twitter URL)."""
        from core.aggregators.reddit.images import _extract_image_url_from_selftext
        from core.aggregators.reddit.types import RedditPostData

        post = RedditPostData(
            {
                "id": "test456",
                "title": "Test post with image and tweet",
                "selftext": (
                    "Look at this: https://x.com/user/status/123456\n\n"
                    "And this image: https://i.redd.it/abc123.jpg"
                ),
                "url": "https://reddit.com/r/test/comments/test456/test_post/",
                "author": "testuser",
                "permalink": "/r/test/comments/test456/test_post/",
                "created_utc": 1700000000,
                "num_comments": 5,
                "is_self": True,
            }
        )

        result = _extract_image_url_from_selftext(post)

        # Should return the direct image, not the Twitter URL
        assert result == "https://i.redd.it/abc123.jpg"

    def test_selftext_twitter_com_url_returns_twitter_url(self):
        """twitter.com URLs in selftext should also be returned for embedding."""
        from core.aggregators.reddit.images import extract_header_image_url
        from core.aggregators.reddit.types import RedditPostData

        post = RedditPostData(
            {
                "id": "test789",
                "title": "Test post",
                "selftext": "See: https://twitter.com/user/status/999888777",
                "url": "https://reddit.com/r/test/comments/test789/test_post/",
                "author": "testuser",
                "permalink": "/r/test/comments/test789/test_post/",
                "created_utc": 1700000000,
                "num_comments": 5,
                "is_self": True,
            }
        )

        result = extract_header_image_url(post)

        assert result == "https://twitter.com/user/status/999888777"

    @patch("core.aggregators.utils.twitter.fetch_tweet_data")
    def test_content_formatter_embeds_twitter_from_selftext(self, mock_fetch):
        """End-to-end: Twitter URL from selftext should produce a tweet embed
        in the header, not a regular image."""
        from core.aggregators.utils.content_formatter import format_article_content

        mock_fetch.return_value = {
            "tweet": {
                "text": "Usage limits have been reset!",
                "author": {"name": "Test User", "screen_name": "testuser"},
                "likes": 100,
                "retweets": 50,
                "created_at": "Wed Jan 15 12:34:56 +0000 2026",
                "media": {},
            },
        }

        result = format_article_content(
            content="<p>Some content</p>",
            title="Test Post",
            url="https://reddit.com/r/test/comments/test/",
            header_image_url="https://x.com/testuser/status/123456",
        )

        # Should contain tweet embed blockquote, NOT a regular <img> tag
        assert "<blockquote" in result
        assert "Usage limits have been reset!" in result
        assert 'alt="Test Post"' not in result  # Should NOT be a regular image header
