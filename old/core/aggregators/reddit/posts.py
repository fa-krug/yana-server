"""Reddit post fetching utilities using PRAW."""

import logging

import prawcore.exceptions

from .auth import get_praw_instance
from .types import RedditPostData

logger = logging.getLogger(__name__)


def fetch_reddit_post(subreddit: str, post_id: str, user_id: int) -> RedditPostData | None:
    """
    Fetch a single Reddit post by ID using PRAW.

    The subreddit parameter is kept for backward compatibility but is not used
    by PRAW, which can fetch submissions directly by ID.

    Args:
        subreddit: Subreddit name (kept for backward compatibility, not used by PRAW)
        post_id: Post ID
        user_id: User ID for authentication

    Returns:
        RedditPostData instance or None if not found
    """
    try:
        reddit = get_praw_instance(user_id)
        submission = reddit.submission(id=post_id)
        _ = submission.title  # Trigger lazy fetch
        return RedditPostData.from_praw(submission)

    except prawcore.exceptions.NotFound:
        logger.warning(f"Reddit post {post_id} not found")
        return None
    except prawcore.exceptions.Forbidden:
        logger.warning(f"Reddit post {post_id} is private/removed")
        return None
    except prawcore.exceptions.ResponseException as e:
        if e.response is not None and e.response.status_code == 401:
            logger.error("Reddit authentication failed while fetching post")
            raise ValueError(
                "Reddit authentication failed. Please check your API credentials."
            ) from None
        logger.warning(f"Error fetching Reddit post {post_id}: {e}")
        return None
    except ValueError:
        # Re-raise ValueError from get_praw_instance (credentials not configured)
        raise
    except Exception as e:
        logger.warning(f"Unexpected error fetching Reddit post {post_id}: {e}")
        return None
