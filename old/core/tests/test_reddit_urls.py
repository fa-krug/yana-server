"""Tests for Reddit URL utilities, specifically fetch_subreddit_info() with PRAW."""

from unittest.mock import MagicMock, patch

import prawcore.exceptions
import pytest

from core.aggregators.reddit.urls import fetch_subreddit_info


@pytest.mark.django_db
class TestFetchSubredditInfo:
    """Tests for fetch_subreddit_info() using PRAW."""

    @patch("core.aggregators.reddit.urls.get_praw_instance")
    def test_returns_icon_url_from_icon_img(self, mock_get_praw, user_with_settings):
        """Test that icon_img is returned when available."""
        mock_reddit = MagicMock()
        mock_sub = MagicMock()
        mock_sub.icon_img = "https://styles.redditmedia.com/icon.png"
        mock_sub.community_icon = ""
        mock_reddit.subreddit.return_value = mock_sub
        mock_get_praw.return_value = mock_reddit

        result = fetch_subreddit_info("python", user_with_settings.id)

        assert result == {"iconUrl": "https://styles.redditmedia.com/icon.png"}
        mock_reddit.subreddit.assert_called_once_with("python")

    @patch("core.aggregators.reddit.urls.get_praw_instance")
    def test_falls_back_to_community_icon(self, mock_get_praw, user_with_settings):
        """Test that community_icon is used when icon_img is empty."""
        mock_reddit = MagicMock()
        mock_sub = MagicMock()
        mock_sub.icon_img = ""
        mock_sub.community_icon = "https://styles.redditmedia.com/community.png"
        mock_reddit.subreddit.return_value = mock_sub
        mock_get_praw.return_value = mock_reddit

        result = fetch_subreddit_info("gaming", user_with_settings.id)

        assert result == {"iconUrl": "https://styles.redditmedia.com/community.png"}

    @patch("core.aggregators.reddit.urls.get_praw_instance")
    def test_falls_back_to_header_img(self, mock_get_praw, user_with_settings):
        """Test that header_img is used when icon_img and community_icon are empty."""
        mock_reddit = MagicMock()
        mock_sub = MagicMock()
        mock_sub.icon_img = ""
        mock_sub.community_icon = ""
        mock_sub.header_img = "https://styles.redditmedia.com/header.png"
        mock_reddit.subreddit.return_value = mock_sub
        mock_get_praw.return_value = mock_reddit

        result = fetch_subreddit_info("test", user_with_settings.id)

        assert result == {"iconUrl": "https://styles.redditmedia.com/header.png"}

    @patch("core.aggregators.reddit.urls.get_praw_instance")
    def test_returns_none_when_no_icon(self, mock_get_praw, user_with_settings):
        """Test that iconUrl is None when subreddit has no icon."""
        mock_reddit = MagicMock()
        mock_sub = MagicMock()
        mock_sub.icon_img = ""
        mock_sub.community_icon = ""
        mock_sub.header_img = None
        mock_reddit.subreddit.return_value = mock_sub
        mock_get_praw.return_value = mock_reddit

        result = fetch_subreddit_info("noicon", user_with_settings.id)

        assert result == {"iconUrl": None}

    @patch("core.aggregators.reddit.urls.get_praw_instance")
    def test_fixes_html_entities_in_icon_url(self, mock_get_praw, user_with_settings):
        """Test that fix_reddit_media_url is applied to icon URLs with HTML entities."""
        mock_reddit = MagicMock()
        mock_sub = MagicMock()
        mock_sub.icon_img = "https://styles.redditmedia.com/icon.png?width=256&amp;s=abc123"
        mock_sub.community_icon = ""
        mock_reddit.subreddit.return_value = mock_sub
        mock_get_praw.return_value = mock_reddit

        result = fetch_subreddit_info("python", user_with_settings.id)

        # fix_reddit_media_url should decode &amp; to &
        assert result["iconUrl"] == "https://styles.redditmedia.com/icon.png?width=256&s=abc123"

    @patch("core.aggregators.reddit.urls.get_praw_instance")
    def test_fixes_double_escaped_entities(self, mock_get_praw, user_with_settings):
        """Test that double-escaped HTML entities are properly decoded."""
        mock_reddit = MagicMock()
        mock_sub = MagicMock()
        mock_sub.icon_img = "https://styles.redditmedia.com/icon.png?width=256&amp;amp;s=abc123"
        mock_sub.community_icon = ""
        mock_reddit.subreddit.return_value = mock_sub
        mock_get_praw.return_value = mock_reddit

        result = fetch_subreddit_info("python", user_with_settings.id)

        assert result["iconUrl"] == "https://styles.redditmedia.com/icon.png?width=256&s=abc123"

    @patch("core.aggregators.reddit.urls.get_praw_instance")
    def test_handles_not_found_exception(self, mock_get_praw, user_with_settings):
        """Test graceful handling of prawcore.exceptions.NotFound."""
        mock_reddit = MagicMock()
        mock_sub = MagicMock()
        mock_sub.icon_img = property(
            lambda self: (_ for _ in ()).throw(prawcore.exceptions.NotFound(MagicMock()))
        )
        # Simulate NotFound when accessing subreddit attributes
        type(mock_sub).icon_img = property(
            lambda self: (_ for _ in ()).throw(prawcore.exceptions.NotFound(MagicMock()))
        )
        mock_reddit.subreddit.return_value = mock_sub
        mock_get_praw.return_value = mock_reddit

        result = fetch_subreddit_info("nonexistent", user_with_settings.id)

        assert result == {"iconUrl": None}

    @patch("core.aggregators.reddit.urls.get_praw_instance")
    def test_handles_forbidden_exception(self, mock_get_praw, user_with_settings):
        """Test graceful handling of prawcore.exceptions.Forbidden."""
        mock_reddit = MagicMock()
        mock_sub = MagicMock()
        type(mock_sub).icon_img = property(
            lambda self: (_ for _ in ()).throw(prawcore.exceptions.Forbidden(MagicMock()))
        )
        mock_reddit.subreddit.return_value = mock_sub
        mock_get_praw.return_value = mock_reddit

        result = fetch_subreddit_info("privateSub", user_with_settings.id)

        assert result == {"iconUrl": None}

    @patch("core.aggregators.reddit.urls.get_praw_instance")
    def test_handles_generic_exception(self, mock_get_praw, user_with_settings):
        """Test graceful handling of unexpected exceptions."""
        mock_get_praw.side_effect = RuntimeError("Connection failed")

        result = fetch_subreddit_info("python", user_with_settings.id)

        assert result == {"iconUrl": None}

    @patch("core.aggregators.reddit.urls.get_praw_instance")
    def test_handles_value_error_from_praw_instance(self, mock_get_praw, user_with_settings):
        """Test graceful handling when get_praw_instance raises ValueError."""
        mock_get_praw.side_effect = ValueError("Reddit is not enabled")

        result = fetch_subreddit_info("python", user_with_settings.id)

        assert result == {"iconUrl": None}

    @patch("core.aggregators.reddit.urls.get_praw_instance")
    def test_icon_img_none_falls_through(self, mock_get_praw, user_with_settings):
        """Test that None icon_img is treated as falsy and falls through."""
        mock_reddit = MagicMock()
        mock_sub = MagicMock()
        mock_sub.icon_img = None
        mock_sub.community_icon = "https://styles.redditmedia.com/community.png"
        mock_reddit.subreddit.return_value = mock_sub
        mock_get_praw.return_value = mock_reddit

        result = fetch_subreddit_info("test", user_with_settings.id)

        assert result == {"iconUrl": "https://styles.redditmedia.com/community.png"}
