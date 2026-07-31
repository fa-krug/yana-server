"""Reddit type definitions."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict

if TYPE_CHECKING:
    from praw.models import Comment, Submission


class RedditPostData:
    """Reddit post data structure from API."""

    def __init__(self, data: Dict[str, Any]):
        self.id = data.get("id", "")
        self.title = data.get("title", "")
        self.selftext = data.get("selftext", "")
        self.selftext_html = data.get("selftext_html")
        self.url = data.get("url", "")
        self.permalink = data.get("permalink", "")
        self.created_utc = data.get("created_utc", 0)
        self.author = data.get("author", "")
        self.score = data.get("score", 0)
        self.num_comments = data.get("num_comments", 0)
        self.thumbnail = data.get("thumbnail", "")
        self.preview = data.get("preview")
        self.media_metadata = data.get("media_metadata")
        self.gallery_data = data.get("gallery_data")
        self.is_gallery = data.get("is_gallery", False)
        self.is_self = data.get("is_self", False)
        self.is_video = data.get("is_video", False)
        self.media = data.get("media")
        self.crosspost_parent_list = data.get("crosspost_parent_list")

    @classmethod
    def from_praw(cls, submission: Submission) -> RedditPostData:
        """Convert PRAW Submission to RedditPostData.

        Args:
            submission: A PRAW Submission object.

        Returns:
            A RedditPostData instance with data from the submission.
        """
        # Handle deleted authors - submission.author is None for deleted posts
        author = "[deleted]"
        if submission.author is not None:
            author = submission.author.name

        return cls(
            {
                "id": submission.id,
                "title": submission.title,
                "author": author,
                "selftext": submission.selftext,
                "selftext_html": submission.selftext_html,
                "url": submission.url,
                "permalink": submission.permalink,
                "created_utc": submission.created_utc,
                "score": submission.score,
                "num_comments": submission.num_comments,
                "is_self": submission.is_self,
                "is_video": submission.is_video,
                "is_gallery": getattr(submission, "is_gallery", False),
                "thumbnail": submission.thumbnail,
                "preview": getattr(submission, "preview", None),
                "media": submission.media,
                "media_metadata": getattr(submission, "media_metadata", None),
                "gallery_data": getattr(submission, "gallery_data", None),
                "crosspost_parent_list": getattr(submission, "crosspost_parent_list", None),
            }
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "id": self.id,
            "title": self.title,
            "selftext": self.selftext,
            "selftext_html": self.selftext_html,
            "url": self.url,
            "permalink": self.permalink,
            "created_utc": self.created_utc,
            "author": self.author,
            "score": self.score,
            "num_comments": self.num_comments,
            "thumbnail": self.thumbnail,
            "preview": self.preview,
            "media_metadata": self.media_metadata,
            "gallery_data": self.gallery_data,
            "is_gallery": self.is_gallery,
            "is_self": self.is_self,
            "is_video": self.is_video,
            "media": self.media,
            "crosspost_parent_list": self.crosspost_parent_list,
        }


class RedditPost:
    """Reddit API response wrapper for posts."""

    def __init__(self, data: Dict[str, Any]):
        self.data = RedditPostData(data.get("data", {}))


class RedditComment:
    """Reddit comment structure."""

    def __init__(self, data: Dict[str, Any]):
        self.id = data.get("id", "")
        self.body = data.get("body", "")
        self.body_html = data.get("body_html")
        self.author = data.get("author", "")
        self.score = data.get("score", 0)
        self.permalink = data.get("permalink", "")
        self.created_utc = data.get("created_utc", 0)
        self.replies = data.get("replies")

    @classmethod
    def from_praw(cls, comment: Comment) -> RedditComment:
        """Convert PRAW Comment to RedditComment.

        Args:
            comment: A PRAW Comment object.

        Returns:
            A RedditComment instance with data from the comment.
        """
        # Handle deleted authors - comment.author is None for deleted comments
        author = "[deleted]"
        if comment.author is not None:
            author = comment.author.name

        return cls(
            {
                "id": comment.id,
                "body": comment.body,
                "body_html": comment.body_html,
                "author": author,
                "score": comment.score,
                "permalink": comment.permalink,
                "created_utc": comment.created_utc,
                # PRAW comments have a replies attribute that is a CommentForest
                # We store None here since replies are handled separately
                "replies": None,
            }
        )
