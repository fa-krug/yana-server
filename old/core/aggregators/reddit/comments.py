"""Reddit comment fetching and formatting utilities."""

import logging
from typing import List

import prawcore.exceptions

from ..exceptions import ArticleSkipError
from .auth import get_praw_instance
from .markdown import convert_reddit_markdown, escape_html, safe_link_html
from .types import RedditComment

logger = logging.getLogger(__name__)


def format_comment_html(comment: RedditComment) -> str:
    """
    Format a single comment as HTML with link.

    Args:
        comment: RedditComment instance

    Returns:
        HTML string
    """
    author = comment.author or "[deleted]"
    # convert_reddit_markdown() sanitizes its own output (raw <script>,
    # on*=, javascript:/data: links) before returning, so `body` is already
    # safe to splice in below.
    body = convert_reddit_markdown(comment.body or "")
    # comment.permalink is attacker-reachable (sourced from the Reddit API for
    # a post/comment an arbitrary user authored), so the link is built through
    # safe_link_html rather than interpolated raw into the href attribute.
    comment_url = f"https://reddit.com{comment.permalink}"

    return f"""
<blockquote>
<p><strong>{escape_html(author)}</strong> | {safe_link_html(comment_url, "source")}</p>
<div>{body}</div>
</blockquote>
"""


def _is_bot_account(author: str) -> bool:
    """
    Check if an author name belongs to a known bot account.

    Args:
        author: Reddit username

    Returns:
        True if the account is likely a bot
    """
    author_lower = author.lower()
    return (
        author_lower.endswith("_bot")
        or author_lower.endswith("-bot")
        or author_lower == "automoderator"
    )


def _is_valid_comment(comment: RedditComment) -> bool:
    """
    Check if a comment should be included (not deleted/removed and not a bot).

    Args:
        comment: RedditComment instance

    Returns:
        True if comment should be included
    """
    # Skip deleted or removed comments
    if not comment.body or comment.body in ("[deleted]", "[removed]"):
        return False

    # Skip bot accounts
    return bool(comment.author) and not _is_bot_account(comment.author)


def fetch_post_comments(
    subreddit: str, post_id: str, comment_limit: int, user_id: int
) -> List[RedditComment]:
    """
    Fetch comments for a Reddit post using PRAW.

    Uses PRAW to fetch top-level comments from a submission, filters out bots
    and deleted/removed comments, sorts by score, and returns up to comment_limit.

    Args:
        subreddit: Subreddit name (unused with PRAW but kept for API compatibility)
        post_id: Post ID
        comment_limit: Maximum number of comments to return
        user_id: User ID for authentication

    Returns:
        List of RedditComment instances

    Raises:
        ArticleSkipError: On Forbidden (403) or NotFound (404) errors
    """
    try:
        reddit = get_praw_instance(user_id)
        submission = reddit.submission(id=post_id)
        submission.comment_sort = "best"
        submission.comments.replace_more(limit=0)  # Skip "load more" links

        # Get top-level comments only (iterating CommentForest directly, not .list()
        # which would flatten the entire tree including nested replies)
        raw_comments = list(submission.comments)
        comments = [RedditComment.from_praw(c) for c in raw_comments]

        # Filter out deleted/removed comments and bots
        filtered = [c for c in comments if _is_valid_comment(c)]

        # Sort by score descending
        filtered.sort(key=lambda c: c.score or 0, reverse=True)

        return filtered[:comment_limit]

    except prawcore.exceptions.Forbidden as e:
        logger.warning(f"Access forbidden to post {post_id}")
        raise ArticleSkipError(
            "Post is private or removed",
            status_code=403,
            original_error=e,
        ) from e
    except prawcore.exceptions.NotFound as e:
        logger.warning(f"Post {post_id} not found")
        raise ArticleSkipError(
            "Post not found",
            status_code=404,
            original_error=e,
        ) from e
    except ArticleSkipError:
        raise
    except Exception as e:
        logger.warning(f"Error fetching comments for post {post_id}: {e}")
        return []  # Graceful degradation - article without comments
