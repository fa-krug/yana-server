import unittest
from unittest.mock import MagicMock, patch

from django.utils import timezone

from bs4 import BeautifulSoup

from core.aggregators.youtube.aggregator import YouTubeAggregator


class TestYouTubeAggregator(unittest.TestCase):
    def setUp(self):
        self.feed = MagicMock()
        self.feed.identifier = "@mkbhd"
        self.feed.daily_limit = 5
        self.feed.user.id = 1
        self.aggregator = YouTubeAggregator(self.feed)

    @patch("core.models.UserSettings.objects.get")
    def test_get_client_success(self, mock_get_settings):
        mock_settings = MagicMock()
        mock_settings.youtube_enabled = True
        mock_settings.youtube_api_key = "valid_key"
        mock_get_settings.return_value = mock_settings

        client = self.aggregator._get_client()
        self.assertIsNotNone(client)
        self.assertEqual(client.api_key, "valid_key")

    def test_parse_to_raw_articles(self):
        source_data = {
            "channel_id": "UC123",
            "channel_title": "Test Channel",
            "videos": [
                {
                    "id": "vid1",
                    "snippet": {
                        "title": "Video 1",
                        "description": "Description 1",
                        "publishedAt": "2023-01-01T12:00:00Z",
                        "thumbnails": {"high": {"url": "https://thumb.url"}},
                    },
                }
            ],
        }

        articles = self.aggregator.parse_to_raw_articles(source_data)

        self.assertEqual(len(articles), 1)
        self.assertEqual(articles[0]["name"], "Video 1")
        self.assertEqual(articles[0]["_youtube_video_id"], "vid1")
        self.assertEqual(articles[0]["author"], "Test Channel")

    def test_build_content_html(self):
        description = "This is a video description.\nNew line."
        comments = [
            {
                "id": "comm1",
                "snippet": {
                    "topLevelComment": {
                        "snippet": {"authorDisplayName": "User1", "textDisplay": "Nice!"}
                    }
                },
            }
        ]

        html = self.aggregator._build_content_html(description, comments, "vid1")

        self.assertIn("This is a video description.<br>New line.", html)
        self.assertIn("User1", html)
        self.assertIn("https://www.youtube.com/watch?v=vid1&lc=comm1", html)
        self.assertIn("<h3>Comments</h3>", html)
        # Verify text is in HTML (textDisplay)
        self.assertIn("Nice!", html)

    @patch("core.models.UserSettings.objects.get")
    @patch("core.aggregators.youtube.aggregator.create_youtube_embed_html")
    @patch("core.aggregators.youtube.aggregator.format_article_content")
    def test_finalize_articles(self, mock_format, mock_embed, mock_get_settings):
        # Mock settings to raise DoesNotExist so AI processing is skipped
        # and we test the standard formatting logic
        from core.models import UserSettings

        mock_get_settings.side_effect = UserSettings.DoesNotExist

        mock_embed.return_value = "<iframe></iframe>"
        mock_format.return_value = "<html>Content</html>"

        articles = [
            {
                "name": "Video 1",
                "identifier": "https://youtube.com/watch?v=vid1",
                "content": "Description",
                "date": timezone.now(),
                "author": "Channel",
                "_youtube_video_id": "vid1",
            }
        ]

        finalized = self.aggregator.finalize_articles(articles)

        self.assertEqual(len(finalized), 1)
        self.assertEqual(finalized[0]["content"], "<iframe></iframe><html>Content</html>")
        mock_embed.assert_called_with("vid1")

    @patch("core.models.UserSettings.objects.get")
    @patch("core.aggregators.youtube.aggregator.YouTubeAggregator.search_channels")
    def test_get_identifier_choices(self, mock_search, mock_get_settings):
        # Mock settings
        mock_settings = MagicMock()
        mock_settings.youtube_enabled = True
        mock_settings.youtube_api_key = "valid_key"
        mock_get_settings.return_value = mock_settings

        # Mock search results
        mock_search.return_value = [
            {
                "channel_id": "UC_MKBHD",
                "title": "MKBHD",
                "custom_url": "@mkbhd",
            }
        ]

        user = MagicMock()
        user.is_authenticated = True

        choices = YouTubeAggregator.get_identifier_choices(query="mkbhd", user=user)

        self.assertEqual(len(choices), 1)
        self.assertEqual(choices[0][0], "UC_MKBHD")
        self.assertEqual(choices[0][1], "MKBHD (@mkbhd)")


def _make_comment(
    comment_id="comm1",
    author="User1",
    text="Nice!",
    channel_url=None,
    avatar_url=None,
):
    """Build a YouTube commentThreads API item shape for _build_content_html."""
    snippet = {"authorDisplayName": author, "textDisplay": text}
    if channel_url is not None:
        snippet["authorChannelUrl"] = channel_url
    if avatar_url is not None:
        snippet["authorProfileImageUrl"] = avatar_url
    return {
        "id": comment_id,
        "snippet": {"topLevelComment": {"snippet": snippet}},
    }


class TestYouTubeCommentSanitization(unittest.TestCase):
    """textDisplay is API-supplied HTML (YouTube renders links/line breaks
    into it via textFormat=html) that gets spliced straight into stored
    article content. These tests guard the sanitization pipeline that
    replaces the previous no-op passthrough."""

    def setUp(self):
        self.feed = MagicMock()
        self.feed.identifier = "@mkbhd"
        self.feed.daily_limit = 5
        self.feed.user.id = 1
        self.aggregator = YouTubeAggregator(self.feed)

    def test_comment_script_tag_is_removed(self):
        comments = [_make_comment(text="Great vid <script>alert(1)</script> thanks")]

        html = self.aggregator._build_content_html("desc", comments, "vid1")

        soup = BeautifulSoup(html, "html.parser")
        self.assertEqual(soup.find_all("script"), [])
        self.assertNotIn("alert(1)", html)

    def test_comment_img_onerror_is_stripped(self):
        comments = [_make_comment(text='Look <img src="x.jpg" onerror="alert(1)"> at this')]

        html = self.aggregator._build_content_html("desc", comments, "vid1")

        soup = BeautifulSoup(html, "html.parser")
        self.assertTrue(all("onerror" not in tag.attrs for tag in soup.find_all(True)))
        self.assertNotIn("alert(1)", html)

    def test_comment_javascript_href_not_rendered_live(self):
        comments = [_make_comment(text='Click <a href="javascript:alert(1)">here</a>')]

        html = self.aggregator._build_content_html("desc", comments, "vid1")

        soup = BeautifulSoup(html, "html.parser")
        for a in soup.find_all("a"):
            href = a.get("href")
            self.assertFalse(href and href.lower().startswith("javascript:"))

    def test_legitimate_comment_markup_survives_unescaped(self):
        comments = [
            _make_comment(
                text=(
                    'Line one<br>Line two <a href="https://example.com/x">link</a> '
                    "<b>bold</b> <i>italic</i>"
                )
            )
        ]

        html = self.aggregator._build_content_html("desc", comments, "vid1")

        soup = BeautifulSoup(html, "html.parser")
        self.assertTrue(soup.find_all("br"))
        link = soup.find("a", href="https://example.com/x")
        self.assertIsNotNone(link)
        self.assertEqual(link.get_text(), "link")
        self.assertEqual(soup.find_all("b")[-1].get_text(), "bold")
        self.assertEqual(soup.find_all("i")[-1].get_text(), "italic")
        # Never visibly escaped into entities.
        self.assertNotIn("&lt;br&gt;", html)
        self.assertNotIn("&lt;b&gt;", html)

    def test_author_display_name_is_escaped_not_injected(self):
        comments = [
            _make_comment(author="""<script>alert(1)</script>'"""),
        ]

        html = self.aggregator._build_content_html("desc", comments, "vid1")

        soup = BeautifulSoup(html, "html.parser")
        self.assertEqual(soup.find_all("script"), [])
        strong = soup.find("strong")
        self.assertIsNotNone(strong)
        self.assertEqual(strong.get_text(), "<script>alert(1)</script>'")

    def test_unsafe_channel_url_renders_author_as_bare_text(self):
        comments = [_make_comment(channel_url="javascript:alert(1)")]

        html = self.aggregator._build_content_html("desc", comments, "vid1")

        soup = BeautifulSoup(html, "html.parser")
        strong = soup.find("strong")
        self.assertIsNotNone(strong)
        # No anchor wraps the author name when the channel URL is unsafe.
        self.assertIsNone(strong.find("a"))
        self.assertEqual(strong.get_text(), "User1")

    def test_safe_channel_url_links_author_name(self):
        comments = [_make_comment(channel_url="https://www.youtube.com/channel/UC123")]

        html = self.aggregator._build_content_html("desc", comments, "vid1")

        soup = BeautifulSoup(html, "html.parser")
        link = soup.find("a", href="https://www.youtube.com/channel/UC123")
        self.assertIsNotNone(link)
        self.assertEqual(link.get_text(), "User1")

    def test_unsafe_avatar_url_is_skipped(self):
        comments = [_make_comment(avatar_url="data:text/html,<script>alert(1)</script>")]

        html = self.aggregator._build_content_html("desc", comments, "vid1")

        soup = BeautifulSoup(html, "html.parser")
        self.assertEqual(soup.find_all("img"), [])

    def test_safe_avatar_url_renders_image(self):
        comments = [_make_comment(avatar_url="https://yt3.googleusercontent.com/avatar.jpg")]

        html = self.aggregator._build_content_html("desc", comments, "vid1")

        soup = BeautifulSoup(html, "html.parser")
        img = soup.find("img", src="https://yt3.googleusercontent.com/avatar.jpg")
        self.assertIsNotNone(img)

    def test_normal_comment_regression(self):
        comments = [_make_comment(comment_id="comm1", author="User1", text="Nice!")]

        html = self.aggregator._build_content_html(
            "This is a video description.\nNew line.", comments, "vid1"
        )

        self.assertIn("This is a video description.<br>New line.", html)
        self.assertIn("User1", html)
        self.assertIn("Nice!", html)
        self.assertIn("<h3>Comments</h3>", html)
        soup = BeautifulSoup(html, "html.parser")
        self.assertEqual(len(soup.find_all("blockquote")), 1)
        source_link = soup.find("a", string="source")
        self.assertIsNotNone(source_link)
        self.assertEqual(source_link.get("href"), "https://www.youtube.com/watch?v=vid1&lc=comm1")
