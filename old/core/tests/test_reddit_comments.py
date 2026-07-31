"""Tests for Reddit comment fetching via PRAW."""

from unittest.mock import MagicMock, patch

import prawcore.exceptions
import pytest
from bs4 import BeautifulSoup

from core.aggregators.exceptions import ArticleSkipError
from core.aggregators.reddit.comments import (
    _is_bot_account,
    _is_valid_comment,
    fetch_post_comments,
    format_comment_html,
)
from core.aggregators.reddit.types import RedditComment


def _make_mock_comment(
    comment_id="c1",
    body="A regular comment",
    body_html="<p>A regular comment</p>",
    author_name="real_user",
    score=10,
    permalink="/r/python/comments/abc/title/c1/",
    created_utc=1704025000.0,
):
    """Create a mock PRAW Comment with standard attributes."""
    mock = MagicMock()
    mock.id = comment_id
    mock.body = body
    mock.body_html = body_html
    if author_name is None:
        mock.author = None
    else:
        mock.author = MagicMock()
        mock.author.name = author_name
    mock.score = score
    mock.permalink = permalink
    mock.created_utc = created_utc
    return mock


def _make_mock_submission_with_comments(comments):
    """Create a mock PRAW Submission with a comment forest."""
    mock_submission = MagicMock()
    mock_submission.id = "abc123"
    mock_submission.comment_sort = "best"
    mock_submission.comments.replace_more.return_value = []
    mock_submission.comments.__iter__ = MagicMock(return_value=iter(comments))
    return mock_submission


def _setup_praw_with_comments(mock_get_praw, comments):
    """Wire up mock PRAW instance with comments. Returns the mock submission."""
    mock_submission = _make_mock_submission_with_comments(comments)
    mock_reddit = MagicMock()
    mock_reddit.submission.return_value = mock_submission
    mock_get_praw.return_value = mock_reddit
    return mock_submission


class TestIsBotAccount:
    """Test _is_bot_account() helper."""

    @pytest.mark.parametrize(
        "username,expected",
        [
            ("real_user", False),
            ("robotics_fan", False),
            ("some_bot", True),
            ("some-bot", True),
            ("Some_Bot", True),
            ("Some-Bot", True),
            ("AutoModerator", True),
            ("automoderator", True),
        ],
    )
    def test_bot_detection(self, username, expected):
        assert _is_bot_account(username) is expected


class TestIsValidComment:
    """Test _is_valid_comment() helper."""

    @pytest.mark.parametrize(
        "body,author,expected",
        [
            ("Good comment", "user", True),
            ("[deleted]", "user", False),
            ("[removed]", "user", False),
            ("", "user", False),
            ("I am a bot", "helpful_bot", False),
            ("I am a bot", "helpful-bot", False),
            ("Moderated post", "AutoModerator", False),
            ("Some text", "", False),
        ],
    )
    def test_validation(self, body, author, expected):
        comment = RedditComment({"id": "c1", "body": body, "author": author, "score": 5})
        assert _is_valid_comment(comment) is expected


class TestFetchPostComments:
    """Test fetch_post_comments() function."""

    @patch("core.aggregators.reddit.comments.get_praw_instance")
    def test_successful_fetch_returns_comments(self, mock_get_praw):
        """Test that comments are fetched and returned as RedditComment instances."""
        comments = [
            _make_mock_comment(comment_id="c1", body="First comment", score=50),
            _make_mock_comment(comment_id="c2", body="Second comment", score=30),
        ]
        _setup_praw_with_comments(mock_get_praw, comments)

        result = fetch_post_comments("python", "abc123", comment_limit=10, user_id=1)

        assert len(result) == 2
        assert all(isinstance(c, RedditComment) for c in result)

    @patch("core.aggregators.reddit.comments.get_praw_instance")
    def test_calls_praw_correctly(self, mock_get_praw):
        """Test that PRAW is called with the correct parameters."""
        mock_submission = _setup_praw_with_comments(mock_get_praw, [])

        fetch_post_comments("python", "abc123", comment_limit=5, user_id=1)

        mock_get_praw.assert_called_once_with(1)
        mock_get_praw.return_value.submission.assert_called_once_with(id="abc123")
        assert mock_submission.comment_sort == "best"
        mock_submission.comments.replace_more.assert_called_once_with(limit=0)

    @patch("core.aggregators.reddit.comments.get_praw_instance")
    def test_iterates_top_level_comments_not_list(self, mock_get_praw):
        """Test that submission.comments is iterated directly, not .list()."""
        comments = [_make_mock_comment(comment_id="c1", body="Top-level", score=10)]
        mock_submission = _setup_praw_with_comments(mock_get_praw, comments)

        fetch_post_comments("python", "abc123", comment_limit=10, user_id=1)

        mock_submission.comments.__iter__.assert_called_once()
        mock_submission.comments.list.assert_not_called()

    @patch("core.aggregators.reddit.comments.get_praw_instance")
    def test_filters_invalid_comments(self, mock_get_praw):
        """Test that deleted/removed/bot comments are filtered out."""
        comments = [
            _make_mock_comment(comment_id="c1", body="Good comment", score=50),
            _make_mock_comment(comment_id="c2", body="[deleted]", score=30),
            _make_mock_comment(comment_id="c3", body="[removed]", score=20),
            _make_mock_comment(comment_id="c4", body="Bot msg", author_name="auto_bot"),
        ]
        _setup_praw_with_comments(mock_get_praw, comments)

        result = fetch_post_comments("python", "abc123", comment_limit=10, user_id=1)

        assert len(result) == 1
        assert result[0].body == "Good comment"

    @patch("core.aggregators.reddit.comments.get_praw_instance")
    def test_sorts_by_score_descending(self, mock_get_praw):
        """Test that comments are sorted by score in descending order."""
        comments = [
            _make_mock_comment(comment_id="c1", body="Low", score=5),
            _make_mock_comment(comment_id="c2", body="High", score=100),
            _make_mock_comment(comment_id="c3", body="Mid", score=50),
        ]
        _setup_praw_with_comments(mock_get_praw, comments)

        result = fetch_post_comments("python", "abc123", comment_limit=10, user_id=1)

        assert [c.score for c in result] == [100, 50, 5]

    @patch("core.aggregators.reddit.comments.get_praw_instance")
    def test_respects_comment_limit(self, mock_get_praw):
        """Test that the result is limited to comment_limit."""
        comments = [
            _make_mock_comment(comment_id=f"c{i}", body=f"Comment {i}", score=100 - i)
            for i in range(10)
        ]
        _setup_praw_with_comments(mock_get_praw, comments)

        result = fetch_post_comments("python", "abc123", comment_limit=3, user_id=1)

        assert len(result) == 3

    @patch("core.aggregators.reddit.comments.get_praw_instance")
    def test_combined_filtering_sorting_and_limit(self, mock_get_praw):
        """Test full pipeline: filter bots + deleted + sort + limit."""
        comments = [
            _make_mock_comment(comment_id="c1", body="Low human", author_name="user1", score=5),
            _make_mock_comment(comment_id="c2", body="Bot msg", author_name="auto_bot", score=1000),
            _make_mock_comment(comment_id="c3", body="[deleted]", author_name="user2", score=50),
            _make_mock_comment(comment_id="c4", body="High human", author_name="user3", score=200),
            _make_mock_comment(comment_id="c5", body="Mid human", author_name="user4", score=100),
            _make_mock_comment(
                comment_id="c6", body="Mod msg", author_name="AutoModerator", score=500
            ),
        ]
        _setup_praw_with_comments(mock_get_praw, comments)

        result = fetch_post_comments("python", "abc123", comment_limit=2, user_id=1)

        assert len(result) == 2
        assert result[0].score == 200
        assert result[1].score == 100

    @patch("core.aggregators.reddit.comments.get_praw_instance")
    def test_forbidden_raises_article_skip_error(self, mock_get_praw):
        """Test that Forbidden exception raises ArticleSkipError."""
        mock_reddit = MagicMock()
        mock_submission = MagicMock()
        mock_submission.comment_sort = "best"
        mock_submission.comments.replace_more.side_effect = prawcore.exceptions.Forbidden(
            MagicMock(status_code=403)
        )
        mock_reddit.submission.return_value = mock_submission
        mock_get_praw.return_value = mock_reddit

        with pytest.raises(ArticleSkipError) as exc_info:
            fetch_post_comments("private_sub", "secret_post", comment_limit=5, user_id=1)
        assert exc_info.value.status_code == 403

    @patch("core.aggregators.reddit.comments.get_praw_instance")
    def test_not_found_raises_article_skip_error(self, mock_get_praw):
        """Test that NotFound exception raises ArticleSkipError."""
        mock_reddit = MagicMock()
        mock_submission = MagicMock()
        mock_submission.comment_sort = "best"
        mock_submission.comments.replace_more.side_effect = prawcore.exceptions.NotFound(
            MagicMock(status_code=404)
        )
        mock_reddit.submission.return_value = mock_submission
        mock_get_praw.return_value = mock_reddit

        with pytest.raises(ArticleSkipError) as exc_info:
            fetch_post_comments("python", "nonexistent", comment_limit=5, user_id=1)
        assert exc_info.value.status_code == 404

    @patch("core.aggregators.reddit.comments.get_praw_instance")
    def test_unexpected_exception_returns_empty_list(self, mock_get_praw):
        """Test that unexpected exceptions return empty list."""
        mock_reddit = MagicMock()
        mock_reddit.submission.side_effect = RuntimeError("Network error")
        mock_get_praw.return_value = mock_reddit

        assert fetch_post_comments("python", "abc123", comment_limit=5, user_id=1) == []

    @patch("core.aggregators.reddit.comments.get_praw_instance")
    def test_praw_instance_error_returns_empty_list(self, mock_get_praw):
        """Test that errors from get_praw_instance return empty list."""
        mock_get_praw.side_effect = ValueError("Reddit not enabled")

        assert fetch_post_comments("python", "abc123", comment_limit=5, user_id=1) == []

    @patch("core.aggregators.reddit.comments.get_praw_instance")
    def test_article_skip_error_is_reraised(self, mock_get_praw):
        """Test that ArticleSkipError is re-raised, not swallowed."""
        mock_get_praw.side_effect = ArticleSkipError("Some skip reason", status_code=410)

        with pytest.raises(ArticleSkipError):
            fetch_post_comments("python", "abc123", comment_limit=5, user_id=1)


class TestFormatCommentHtml:
    """Test format_comment_html() is unchanged and still works."""

    def test_basic_formatting(self):
        comment = RedditComment(
            {
                "id": "c1",
                "body": "Hello world",
                "author": "test_user",
                "score": 10,
                "permalink": "/r/python/comments/abc/title/c1/",
            }
        )
        result = format_comment_html(comment)

        assert "<blockquote>" in result
        assert "test_user" in result
        assert "source</a>" in result

    def test_deleted_author_fallback(self):
        comment = RedditComment(
            {
                "id": "c1",
                "body": "Some text",
                "author": "",
                "permalink": "/r/test/comments/abc/title/c1/",
            }
        )
        assert "[deleted]" in format_comment_html(comment)

    def test_html_escaping(self):
        comment = RedditComment(
            {
                "id": "c1",
                "body": "text",
                "author": "<script>alert(1)</script>",
                "permalink": "/r/test/comments/abc/title/c1/",
            }
        )
        result = format_comment_html(comment)

        assert "<script>" not in result
        assert "&lt;script&gt;" in result


class TestFormatCommentHtmlSecurity:
    """HTML-injection regression tests for format_comment_html().

    These assert on the PARSED structure (BeautifulSoup element counts and
    attribute values), not just substring absence, so they prove the markup
    stays well-formed rather than merely pattern-matching escaped text.
    """

    def test_author_with_script_and_apostrophe_is_escaped(self):
        comment = RedditComment(
            {
                "id": "c1",
                "body": "hello",
                "author": "o'brien<script>alert(1)</script>",
                "permalink": "/r/test/comments/abc/title/c1/",
            }
        )

        result = format_comment_html(comment)

        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []
        assert "o'brien<script>alert(1)</script>" not in result

    def test_permalink_with_quote_does_not_break_href_attribute(self):
        comment = RedditComment(
            {
                "id": "c1",
                "body": "hello",
                "author": "user1",
                "permalink": '/r/test/comments/abc"><script>alert(1)</script>/c1/',
            }
        )

        result = format_comment_html(comment)

        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []
        anchors = soup.find_all("a")
        assert len(anchors) == 1
        assert anchors[0]["href"] == (
            'https://reddit.com/r/test/comments/abc"><script>alert(1)</script>/c1/'
        )
        assert anchors[0].get_text() == "source"

    def test_body_with_raw_script_is_sanitized(self):
        comment = RedditComment(
            {
                "id": "c1",
                "body": "hi <script>alert(1)</script> there",
                "author": "user1",
                "permalink": "/r/test/comments/abc/title/c1/",
            }
        )

        result = format_comment_html(comment)

        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []

    def test_body_with_onerror_attribute_is_sanitized(self):
        comment = RedditComment(
            {
                "id": "c1",
                "body": "<img src=x onerror=alert(1)>",
                "author": "user1",
                "permalink": "/r/test/comments/abc/title/c1/",
            }
        )

        result = format_comment_html(comment)

        soup = BeautifulSoup(result, "html.parser")
        for img in soup.find_all("img"):
            assert "onerror" not in img.attrs

    def test_body_with_javascript_link_is_not_rendered_as_href(self):
        comment = RedditComment(
            {
                "id": "c1",
                "body": "[click me](javascript:alert(1))",
                "author": "user1",
                "permalink": "/r/test/comments/abc/title/c1/",
            }
        )

        result = format_comment_html(comment)

        soup = BeautifulSoup(result, "html.parser")
        for a in soup.find_all("a"):
            assert not (a.get("href") or "").lower().startswith("javascript:")

    def test_normal_comment_regression(self):
        comment = RedditComment(
            {
                "id": "c1",
                "body": "This is a **great** point.",
                "author": "user1",
                "permalink": "/r/test/comments/abc/title/c1/",
            }
        )

        result = format_comment_html(comment)

        soup = BeautifulSoup(result, "html.parser")
        assert len(soup.find_all("blockquote")) == 1
        # First <strong> is the escaped author; the body's own **great**
        # markdown produces the second.
        strongs = soup.find_all("strong")
        assert strongs[0].get_text() == "user1"
        assert strongs[1].get_text() == "great"
        source_links = [a for a in soup.find_all("a") if a.get_text() == "source"]
        assert len(source_links) == 1
        assert source_links[0]["href"] == "https://reddit.com/r/test/comments/abc/title/c1/"
