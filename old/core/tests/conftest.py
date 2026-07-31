"""Pytest fixtures for core app tests."""

from datetime import timedelta

from django.contrib.auth.models import User
from django.utils import timezone

import pytest

from core.models import Article, Feed, FeedGroup, UserSettings


@pytest.fixture
def user(db):
    return User.objects.create_user(
        username="testuser", email="test@example.com", password="password"
    )


@pytest.fixture
def user_with_settings(user):
    UserSettings.objects.create(
        user=user,
        reddit_enabled=True,
        reddit_client_id="test_client_id",
        reddit_client_secret="test_client_secret",
        youtube_enabled=True,
        youtube_api_key="test_youtube_key",
    )
    return user


@pytest.fixture
def feed_group(user):
    return FeedGroup.objects.create(name="Test Group", user=user)


@pytest.fixture
def rss_feed(user, feed_group):
    return Feed.objects.create(
        name="RSS Feed",
        aggregator="rss",
        identifier="https://example.com/rss",
        user=user,
        group=feed_group,
    )


@pytest.fixture
def reddit_feed(user, feed_group):
    return Feed.objects.create(
        name="Reddit Feed", aggregator="reddit", identifier="python", user=user, group=feed_group
    )


@pytest.fixture
def youtube_feed(user, feed_group):
    return Feed.objects.create(
        name="YouTube Feed",
        aggregator="youtube",
        identifier="UC_x5XG1OV2P6uZZ5FSM9Ttw",
        user=user,
        group=feed_group,
    )


@pytest.fixture
def article(rss_feed):
    return Article.objects.create(
        name="Test Article",
        identifier="https://example.com/article/1",
        raw_content="<html><body><p>Raw content</p></body></html>",
        content="Clean content",
        feed=rss_feed,
        date=timezone.now(),
    )


@pytest.fixture
def articles_batch(rss_feed):
    articles = []
    now = timezone.now()
    for i in range(50):
        articles.append(
            Article.objects.create(
                name=f"Article {i}",
                identifier=f"https://example.com/article/{i}",
                raw_content=f"<html><body><p>Raw content {i}</p></body></html>",
                content=f"Clean content {i}",
                feed=rss_feed,
                date=now - timedelta(minutes=i),
            )
        )
    return articles


@pytest.fixture
def mock_rss_xml():
    return """<?xml version="1.0" encoding="UTF-8" ?>
    <rss version="2.0">
    <channel>
        <title>Test RSS</title>
        <link>https://example.com</link>
        <description>Test description</description>
        <item>
            <title>Article 1</title>
            <link>https://example.com/1</link>
            <description>Description 1</description>
            <pubDate>Mon, 01 Jan 2024 12:00:00 +0000</pubDate>
            <guid>https://example.com/1</guid>
        </item>
    </channel>
    </rss>"""


@pytest.fixture
def mock_html_content():
    return """
    <html>
        <head><title>Test Article</title></head>
        <body>
            <div class="content">
                <h1>Article Title</h1>
                <p>This is the article content.</p>
                <img src="https://example.com/image.jpg" />
                <script>alert('xss');</script>
                <style>.ads { display: none; }</style>
            </div>
        </body>
    </html>
    """


@pytest.fixture
def mock_reddit_response():
    return {
        "data": {
            "children": [
                {
                    "data": {
                        "id": "post1",
                        "title": "Reddit Post 1",
                        "url": "https://reddit.com/post1",
                        "selftext": "Post content",
                        "author": "user1",
                        "created_utc": 1704024000,
                        "num_comments": 10,
                        "score": 100,
                        "is_self": True,
                        "over_18": False,
                        "permalink": "/r/python/post1",
                    }
                }
            ],
            "after": "next_page",
        }
    }
