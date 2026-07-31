"""Reddit authentication utilities using PRAW."""

import logging
from typing import Any, Dict

import praw

logger = logging.getLogger(__name__)


def get_reddit_user_settings(user_id: int) -> Dict[str, Any]:
    """
    Get Reddit user settings for a user.

    Fetches settings from UserSettings model, creating default settings if they don't exist.

    Args:
        user_id: User ID

    Returns:
        Dict with reddit_enabled, reddit_client_id, reddit_client_secret, reddit_user_agent
    """
    from django.contrib.auth import get_user_model

    from core.models import UserSettings

    User = get_user_model()
    try:
        user = User.objects.get(id=user_id)
    except User.DoesNotExist as e:
        raise ValueError(f"User with id {user_id} does not exist") from e

    # Get or create user settings
    settings, created = UserSettings.objects.get_or_create(
        user=user,
        defaults={
            "reddit_enabled": False,
            "reddit_client_id": "",
            "reddit_client_secret": "",
            "reddit_user_agent": "Yana/1.0",
        },
    )

    return {
        "reddit_enabled": settings.reddit_enabled,
        "reddit_client_id": settings.reddit_client_id or "",
        "reddit_client_secret": settings.reddit_client_secret or "",
        "reddit_user_agent": settings.reddit_user_agent or "Yana/1.0",
    }


def get_praw_instance(user_id: int) -> praw.Reddit:
    """
    Create a read-only PRAW instance for the user.

    Creates a new PRAW Reddit instance configured with the user's API credentials.
    The instance is set up for read-only access using client credentials.

    Note: PRAW instances are not thread-safe, so a fresh instance should be
    created for each request/task. PRAW handles rate limiting automatically.

    Args:
        user_id: User ID whose credentials to use

    Returns:
        Configured praw.Reddit instance

    Raises:
        ValueError: If Reddit is not enabled or credentials are missing
    """
    settings = get_reddit_user_settings(user_id)

    if not settings.get("reddit_enabled"):
        raise ValueError("Reddit is not enabled")

    client_id = settings.get("reddit_client_id", "")
    client_secret = settings.get("reddit_client_secret", "")

    if not client_id or not client_secret:
        raise ValueError("Reddit API credentials not configured")

    return praw.Reddit(
        client_id=client_id,
        client_secret=client_secret,
        user_agent=settings.get("reddit_user_agent", "Yana/1.0"),
    )
