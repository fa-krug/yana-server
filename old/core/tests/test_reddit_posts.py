"""Tests for Reddit post fetching via PRAW."""

from unittest.mock import MagicMock, patch

import prawcore.exceptions
import pytest

from core.aggregators.reddit.posts import fetch_reddit_post
from core.aggregators.reddit.types import RedditPostData


def _make_mock_submission(**overrides):
    """Create a mock PRAW Submission with standard attributes."""
    defaults = {
        "id": "abc123",
        "title": "Test Post Title",
        "author_name": "test_user",
        "selftext": "This is the post body",
        "selftext_html": "<p>This is the post body</p>",
        "url": "https://reddit.com/r/python/comments/abc123/",
        "permalink": "/r/python/comments/abc123/test_post/",
        "created_utc": 1704024000.0,
        "score": 150,
        "num_comments": 42,
        "is_self": True,
        "is_video": False,
        "is_gallery": False,
        "thumbnail": "self",
        "preview": None,
        "media": None,
        "media_metadata": None,
        "gallery_data": None,
        "crosspost_parent_list": None,
    }
    defaults.update(overrides)

    mock = MagicMock()
    mock.id = defaults["id"]
    mock.title = defaults["title"]
    if defaults["author_name"] is None:
        mock.author = None
    else:
        mock.author = MagicMock()
        mock.author.name = defaults["author_name"]
    for attr in [
        "selftext",
        "selftext_html",
        "url",
        "permalink",
        "created_utc",
        "score",
        "num_comments",
        "is_self",
        "is_video",
        "is_gallery",
        "thumbnail",
        "preview",
        "media",
        "media_metadata",
        "gallery_data",
        "crosspost_parent_list",
    ]:
        setattr(mock, attr, defaults[attr])
    return mock


def _make_mock_submission_raising(exception):
    """Create a mock PRAW Submission that raises on .title access."""

    class RaisingSubmission(MagicMock):
        @property
        def title(self):
            raise exception

    return RaisingSubmission()


def _setup_praw(mock_get_praw, mock_submission):
    """Wire up mock PRAW instance. Returns the mock reddit instance."""
    mock_reddit = MagicMock()
    mock_reddit.submission.return_value = mock_submission
    mock_get_praw.return_value = mock_reddit
    return mock_reddit


class TestFetchRedditPost:
    """Test fetch_reddit_post() function."""

    @patch("core.aggregators.reddit.posts.get_praw_instance")
    def test_successful_fetch(self, mock_get_praw):
        """Test successful post fetch returns RedditPostData."""
        _setup_praw(mock_get_praw, _make_mock_submission())

        result = fetch_reddit_post("python", "abc123", user_id=1)

        assert isinstance(result, RedditPostData)
        assert result.id == "abc123"
        assert result.title == "Test Post Title"
        assert result.author == "test_user"
        assert result.score == 150
        assert result.is_self is True

    @patch("core.aggregators.reddit.posts.get_praw_instance")
    def test_calls_praw_with_post_id(self, mock_get_praw):
        """Test that PRAW is called with post ID, not subreddit."""
        mock_reddit = _setup_praw(mock_get_praw, _make_mock_submission())

        fetch_reddit_post("differentsubreddit", "abc123", user_id=1)

        mock_get_praw.assert_called_once_with(1)
        mock_reddit.submission.assert_called_once_with(id="abc123")

    @patch("core.aggregators.reddit.posts.get_praw_instance")
    def test_deleted_author(self, mock_get_praw):
        """Test fetching a post where the author has been deleted."""
        _setup_praw(mock_get_praw, _make_mock_submission(author_name=None))

        result = fetch_reddit_post("python", "abc123", user_id=1)

        assert result is not None
        assert result.author == "[deleted]"

    @patch("core.aggregators.reddit.posts.get_praw_instance")
    def test_gallery_post(self, mock_get_praw):
        """Test fetching a gallery post preserves gallery data."""
        _setup_praw(
            mock_get_praw,
            _make_mock_submission(
                is_self=False,
                is_gallery=True,
                media_metadata={"img1": {"s": {"u": "https://i.redd.it/img1.jpg"}}},
                gallery_data={"items": [{"media_id": "img1"}]},
            ),
        )

        result = fetch_reddit_post("python", "gallery123", user_id=1)

        assert result.is_gallery is True
        assert result.media_metadata is not None

    @patch("core.aggregators.reddit.posts.get_praw_instance")
    def test_video_post(self, mock_get_praw):
        """Test fetching a video post preserves media data."""
        _setup_praw(
            mock_get_praw,
            _make_mock_submission(
                is_self=False,
                is_video=True,
                media={"reddit_video": {"fallback_url": "https://v.redd.it/DASH_720.mp4"}},
            ),
        )

        result = fetch_reddit_post("python", "video123", user_id=1)

        assert result.is_video is True
        assert "reddit_video" in result.media

    @patch("core.aggregators.reddit.posts.get_praw_instance")
    def test_not_found_returns_none(self, mock_get_praw):
        """Test that NotFound exception returns None."""
        _setup_praw(
            mock_get_praw,
            _make_mock_submission_raising(prawcore.exceptions.NotFound(MagicMock(status_code=404))),
        )
        assert fetch_reddit_post("python", "nonexistent", user_id=1) is None

    @patch("core.aggregators.reddit.posts.get_praw_instance")
    def test_forbidden_returns_none(self, mock_get_praw):
        """Test that Forbidden exception returns None."""
        _setup_praw(
            mock_get_praw,
            _make_mock_submission_raising(
                prawcore.exceptions.Forbidden(MagicMock(status_code=403))
            ),
        )
        assert fetch_reddit_post("private_sub", "secret_post", user_id=1) is None

    @patch("core.aggregators.reddit.posts.get_praw_instance")
    def test_auth_failure_raises_value_error(self, mock_get_praw):
        """Test that 401 ResponseException raises ValueError."""
        mock_response = MagicMock()
        mock_response.status_code = 401
        _setup_praw(
            mock_get_praw,
            _make_mock_submission_raising(prawcore.exceptions.ResponseException(mock_response)),
        )

        with pytest.raises(ValueError, match="Reddit authentication failed"):
            fetch_reddit_post("python", "abc123", user_id=1)

    @patch("core.aggregators.reddit.posts.get_praw_instance")
    def test_other_response_exception_returns_none(self, mock_get_praw):
        """Test that non-401 ResponseException returns None."""
        _setup_praw(
            mock_get_praw,
            _make_mock_submission_raising(
                prawcore.exceptions.ResponseException(MagicMock(status_code=500))
            ),
        )
        assert fetch_reddit_post("python", "abc123", user_id=1) is None

    @patch("core.aggregators.reddit.posts.get_praw_instance")
    def test_unexpected_exception_returns_none(self, mock_get_praw):
        """Test that unexpected exceptions return None."""
        _setup_praw(mock_get_praw, _make_mock_submission_raising(RuntimeError("Network error")))
        assert fetch_reddit_post("python", "abc123", user_id=1) is None

    @patch("core.aggregators.reddit.posts.get_praw_instance")
    def test_praw_instance_credentials_error_raises(self, mock_get_praw):
        """Test that ValueError from get_praw_instance is re-raised."""
        mock_get_praw.side_effect = ValueError("Reddit API credentials not configured")

        with pytest.raises(ValueError, match="Reddit API credentials not configured"):
            fetch_reddit_post("python", "abc123", user_id=1)
