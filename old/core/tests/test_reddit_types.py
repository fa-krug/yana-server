"""Tests for Reddit type conversion methods."""

from unittest.mock import MagicMock

import pytest

from core.aggregators.reddit.types import RedditComment, RedditPostData


def _make_mock_submission(
    post_id="abc123",
    title="Test Post Title",
    author_name="test_user",
    selftext="This is the post body",
    selftext_html="<p>This is the post body</p>",
    url="https://reddit.com/r/test/comments/abc123/",
    permalink="/r/test/comments/abc123/test_post/",
    created_utc=1704024000.0,
    score=150,
    num_comments=42,
    is_self=True,
    is_video=False,
    is_gallery=False,
    thumbnail="self",
    preview=None,
    media=None,
    media_metadata=None,
    gallery_data=None,
    crosspost_parent_list=None,
    use_spec=False,
):
    """Create a mock PRAW Submission.

    Args:
        use_spec: If True, restrict mock to only standard attributes (no optional ones).
    """
    if use_spec:
        mock = MagicMock(
            spec=[
                "id",
                "title",
                "author",
                "selftext",
                "selftext_html",
                "url",
                "permalink",
                "created_utc",
                "score",
                "num_comments",
                "is_self",
                "is_video",
                "thumbnail",
                "media",
            ]
        )
    else:
        mock = MagicMock()
        mock.is_gallery = is_gallery
        mock.preview = preview
        mock.media_metadata = media_metadata
        mock.gallery_data = gallery_data
        mock.crosspost_parent_list = crosspost_parent_list

    mock.id = post_id
    mock.title = title
    if author_name is None:
        mock.author = None
    else:
        mock.author = MagicMock()
        mock.author.name = author_name
    mock.selftext = selftext
    mock.selftext_html = selftext_html
    mock.url = url
    mock.permalink = permalink
    mock.created_utc = created_utc
    mock.score = score
    mock.num_comments = num_comments
    mock.is_self = is_self
    mock.is_video = is_video
    mock.thumbnail = thumbnail
    mock.media = media
    return mock


class TestRedditPostDataFromPraw:
    """Test RedditPostData.from_praw() conversion."""

    def test_basic_submission_conversion(self):
        """Test converting a basic PRAW submission with all fields."""
        mock_submission = _make_mock_submission()

        result = RedditPostData.from_praw(mock_submission)

        assert result.id == "abc123"
        assert result.title == "Test Post Title"
        assert result.author == "test_user"
        assert result.selftext == "This is the post body"
        assert result.selftext_html == "<p>This is the post body</p>"
        assert result.url == "https://reddit.com/r/test/comments/abc123/"
        assert result.permalink == "/r/test/comments/abc123/test_post/"
        assert result.created_utc == 1704024000.0
        assert result.score == 150
        assert result.num_comments == 42
        assert result.is_self is True
        assert result.is_video is False
        assert result.is_gallery is False
        assert result.thumbnail == "self"
        assert result.preview is None
        assert result.media is None

    def test_deleted_author_handling(self):
        """Test that deleted posts (author=None) are handled with '[deleted]'."""
        result = RedditPostData.from_praw(_make_mock_submission(author_name=None))
        assert result.author == "[deleted]"

    def test_link_post_conversion(self):
        """Test converting a link post (not self-post)."""
        result = RedditPostData.from_praw(
            _make_mock_submission(
                selftext="",
                selftext_html=None,
                is_self=False,
                url="https://example.com/article",
            )
        )
        assert result.is_self is False
        assert result.url == "https://example.com/article"
        assert result.selftext == ""

    def test_video_post_conversion(self):
        """Test converting a video post with media data."""
        media = {"reddit_video": {"fallback_url": "https://v.redd.it/video123/DASH_720.mp4"}}
        result = RedditPostData.from_praw(_make_mock_submission(is_video=True, media=media))
        assert result.is_video is True
        assert result.media == media

    def test_gallery_post_conversion(self):
        """Test converting a gallery post with media_metadata and gallery_data."""
        metadata = {
            "img1": {"s": {"u": "https://i.redd.it/img1.jpg"}},
            "img2": {"s": {"u": "https://i.redd.it/img2.jpg"}},
        }
        gallery = {"items": [{"media_id": "img1"}, {"media_id": "img2"}]}
        result = RedditPostData.from_praw(
            _make_mock_submission(is_gallery=True, media_metadata=metadata, gallery_data=gallery)
        )
        assert result.is_gallery is True
        assert result.media_metadata is not None
        assert "img1" in result.media_metadata
        assert len(result.gallery_data["items"]) == 2

    def test_crosspost_conversion(self):
        """Test converting a crosspost with crosspost_parent_list."""
        crosspost_list = [{"id": "original_post", "title": "Original Title"}]
        result = RedditPostData.from_praw(
            _make_mock_submission(crosspost_parent_list=crosspost_list)
        )
        assert result.crosspost_parent_list is not None
        assert result.crosspost_parent_list[0]["id"] == "original_post"

    def test_preview_images(self):
        """Test that preview images are preserved."""
        preview = {"images": [{"source": {"url": "https://i.redd.it/full.jpg"}}]}
        result = RedditPostData.from_praw(_make_mock_submission(preview=preview))
        assert result.preview is not None
        assert "images" in result.preview

    def test_missing_optional_attributes(self):
        """Test handling when optional attributes don't exist on submission."""
        result = RedditPostData.from_praw(_make_mock_submission(use_spec=True))

        assert result.is_gallery is False
        assert result.preview is None
        assert result.media_metadata is None
        assert result.gallery_data is None
        assert result.crosspost_parent_list is None

    def test_to_dict_roundtrip(self):
        """Verify to_dict() works after from_praw() conversion."""
        result = RedditPostData.from_praw(_make_mock_submission())
        result_dict = result.to_dict()

        assert result_dict["id"] == "abc123"
        assert result_dict["title"] == "Test Post Title"
        assert result_dict["author"] == "test_user"


class TestRedditCommentFromPraw:
    """Test RedditComment.from_praw() conversion."""

    def _make_mock_comment(self, **overrides):
        defaults = {
            "comment_id": "comment123",
            "body": "This is a comment",
            "body_html": "<p>This is a comment</p>",
            "author_name": "commenter",
            "score": 42,
            "permalink": "/r/test/comments/post/title/comment123/",
            "created_utc": 1704025000.0,
        }
        defaults.update(overrides)
        mock = MagicMock()
        mock.id = defaults["comment_id"]
        mock.body = defaults["body"]
        mock.body_html = defaults["body_html"]
        if defaults["author_name"] is None:
            mock.author = None
        else:
            mock.author = MagicMock()
            mock.author.name = defaults["author_name"]
        mock.score = defaults["score"]
        mock.permalink = defaults["permalink"]
        mock.created_utc = defaults["created_utc"]
        return mock

    def test_basic_comment_conversion(self):
        """Test converting a basic PRAW comment with all fields."""
        result = RedditComment.from_praw(self._make_mock_comment())

        assert result.id == "comment123"
        assert result.body == "This is a comment"
        assert result.body_html == "<p>This is a comment</p>"
        assert result.author == "commenter"
        assert result.score == 42
        assert result.permalink == "/r/test/comments/post/title/comment123/"
        assert result.created_utc == 1704025000.0
        assert result.replies is None

    def test_deleted_comment_author(self):
        """Test that deleted comments (author=None) are handled with '[deleted]'."""
        result = RedditComment.from_praw(self._make_mock_comment(author_name=None))
        assert result.author == "[deleted]"

    def test_negative_score_preserved(self):
        """Test that negative scores are preserved."""
        result = RedditComment.from_praw(self._make_mock_comment(score=-50))
        assert result.score == -50

    def test_markdown_formatting_preserved(self):
        """Test comment with markdown formatting."""
        result = RedditComment.from_praw(
            self._make_mock_comment(
                body="**bold** and *italic*",
                body_html="<p><strong>bold</strong> and <em>italic</em></p>",
            )
        )
        assert "**bold**" in result.body
        assert "<strong>bold</strong>" in result.body_html


class TestDictConstructors:
    """Verify the original dict-based constructors still work."""

    @pytest.mark.parametrize(
        "cls,data,checks",
        [
            (
                RedditPostData,
                {"id": "t1", "title": "T", "author": "a", "score": 100},
                {"id": "t1", "title": "T", "author": "a", "score": 100},
            ),
            (
                RedditPostData,
                {"id": "minimal"},
                {
                    "id": "minimal",
                    "title": "",
                    "author": "",
                    "score": 0,
                    "is_self": False,
                    "is_gallery": False,
                },
            ),
            (
                RedditComment,
                {"id": "c1", "body": "text", "author": "u", "score": 25},
                {"id": "c1", "body": "text", "author": "u", "score": 25},
            ),
            (
                RedditComment,
                {"id": "minimal"},
                {"id": "minimal", "body": "", "author": "", "score": 0},
            ),
        ],
    )
    def test_dict_constructor(self, cls, data, checks):
        result = cls(data)
        for key, expected in checks.items():
            assert getattr(result, key) == expected
