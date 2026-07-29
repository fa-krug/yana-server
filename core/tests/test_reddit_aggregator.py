from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import praw.exceptions
import prawcore.exceptions
import pytest

from core.aggregators.reddit.aggregator import RedditAggregator


def _make_mock_submission(
    post_id="post1",
    title="Reddit Post 1",
    author_name="user1",
    selftext="Post content",
    selftext_html=None,
    url="https://reddit.com/post1",
    permalink="/r/python/post1",
    created_utc=1704024000,
    score=100,
    num_comments=10,
    is_self=True,
    is_video=False,
    is_gallery=False,
    thumbnail="",
    preview=None,
    media=None,
    media_metadata=None,
    gallery_data=None,
    crosspost_parent_list=None,
):
    """Create a mock PRAW Submission object."""
    sub = MagicMock()
    sub.id = post_id
    sub.title = title

    if author_name is None:
        sub.author = None
    else:
        sub.author = MagicMock()
        sub.author.name = author_name

    sub.selftext = selftext
    sub.selftext_html = selftext_html
    sub.url = url
    sub.permalink = permalink
    sub.created_utc = created_utc
    sub.score = score
    sub.num_comments = num_comments
    sub.is_self = is_self
    sub.is_video = is_video
    sub.is_gallery = is_gallery
    sub.thumbnail = thumbnail
    sub.preview = preview
    sub.media = media
    sub.media_metadata = media_metadata
    sub.gallery_data = gallery_data
    sub.crosspost_parent_list = crosspost_parent_list
    return sub


def _make_mock_subreddit_search_result(
    display_name="python",
    display_name_prefixed="r/python",
    title="Python Programming",
    subscribers=1234567,
):
    """Create a mock PRAW Subreddit object for search results."""
    sub = MagicMock()
    sub.display_name = display_name
    sub.display_name_prefixed = display_name_prefixed
    sub.title = title
    sub.subscribers = subscribers
    return sub


@pytest.mark.django_db
class TestRedditAggregator:
    @pytest.fixture
    def reddit_agg(self, reddit_feed, user_with_settings):
        return RedditAggregator(reddit_feed)

    def test_validate_success(self, reddit_agg):
        reddit_agg.validate()  # Should not raise

    def test_validate_no_user(self, reddit_feed):
        reddit_feed.user = None
        agg = RedditAggregator(reddit_feed)
        with pytest.raises(ValueError, match="Feed must have a user"):
            agg.validate()

    def test_validate_not_enabled(self, reddit_agg, user_with_settings):
        user_with_settings.user_settings.reddit_enabled = False
        user_with_settings.user_settings.save()
        with pytest.raises(ValueError, match="Reddit is not enabled"):
            reddit_agg.validate()

    @patch("core.aggregators.reddit.aggregator.get_praw_instance")
    @patch("core.aggregators.reddit.aggregator.fetch_subreddit_info")
    def test_fetch_source_data(self, mock_info, mock_praw, reddit_agg):
        """Test fetch_source_data returns posts via PRAW."""
        mock_info.return_value = {"iconUrl": "https://example.com/icon.png"}

        mock_submission = _make_mock_submission()
        mock_reddit = MagicMock()
        mock_subreddit = MagicMock()
        mock_subreddit.hot.return_value = [mock_submission]
        mock_reddit.subreddit.return_value = mock_subreddit
        mock_praw.return_value = mock_reddit

        data = reddit_agg.fetch_source_data(limit=1)

        assert "posts" in data
        assert len(data["posts"]) == 1
        assert data["posts"][0].data.title == "Reddit Post 1"
        assert data["posts"][0].data.author == "user1"
        assert reddit_agg.subreddit_icon_url == "https://example.com/icon.png"
        mock_reddit.subreddit.assert_called_once_with("python")
        mock_subreddit.hot.assert_called_once()

    @patch("core.aggregators.reddit.aggregator.get_praw_instance")
    @patch("core.aggregators.reddit.aggregator.fetch_subreddit_info")
    def test_fetch_source_data_sort_by_new(self, mock_info, mock_praw, reddit_agg):
        """Test fetch_source_data uses configured sort method."""
        mock_info.return_value = {"iconUrl": None}
        reddit_agg.feed.options = {"subreddit_sort": "new"}

        mock_reddit = MagicMock()
        mock_subreddit = MagicMock()
        mock_subreddit.new.return_value = [_make_mock_submission()]
        mock_reddit.subreddit.return_value = mock_subreddit
        mock_praw.return_value = mock_reddit

        reddit_agg.fetch_source_data(limit=1)

        mock_subreddit.new.assert_called_once()

    @patch("core.aggregators.reddit.aggregator.get_praw_instance")
    @patch("core.aggregators.reddit.aggregator.fetch_subreddit_info")
    def test_fetch_source_data_deleted_author(self, mock_info, mock_praw, reddit_agg):
        """Test fetch_source_data handles deleted authors."""
        mock_info.return_value = {"iconUrl": None}

        mock_submission = _make_mock_submission(author_name=None)
        mock_reddit = MagicMock()
        mock_subreddit = MagicMock()
        mock_subreddit.hot.return_value = [mock_submission]
        mock_reddit.subreddit.return_value = mock_subreddit
        mock_praw.return_value = mock_reddit

        data = reddit_agg.fetch_source_data(limit=1)

        assert data["posts"][0].data.author == "[deleted]"

    @patch("core.aggregators.reddit.aggregator.get_praw_instance")
    @patch("core.aggregators.reddit.aggregator.fetch_subreddit_info")
    def test_fetch_source_data_forbidden(self, mock_info, mock_praw, reddit_agg):
        """Test fetch_source_data handles Forbidden (private/banned subreddit)."""
        mock_info.return_value = {"iconUrl": None}

        mock_reddit = MagicMock()
        mock_subreddit = MagicMock()
        mock_subreddit.hot.side_effect = prawcore.exceptions.Forbidden(MagicMock(status_code=403))
        mock_reddit.subreddit.return_value = mock_subreddit
        mock_praw.return_value = mock_reddit

        with pytest.raises(ValueError, match="private or banned"):
            reddit_agg.fetch_source_data()

    @patch("core.aggregators.reddit.aggregator.get_praw_instance")
    @patch("core.aggregators.reddit.aggregator.fetch_subreddit_info")
    def test_fetch_source_data_not_found(self, mock_info, mock_praw, reddit_agg):
        """Test fetch_source_data handles NotFound (nonexistent subreddit)."""
        mock_info.return_value = {"iconUrl": None}

        mock_reddit = MagicMock()
        mock_subreddit = MagicMock()
        mock_subreddit.hot.side_effect = prawcore.exceptions.NotFound(MagicMock(status_code=404))
        mock_reddit.subreddit.return_value = mock_subreddit
        mock_praw.return_value = mock_reddit

        with pytest.raises(ValueError, match="does not exist"):
            reddit_agg.fetch_source_data()

    @patch("core.aggregators.reddit.aggregator.get_praw_instance")
    @patch("core.aggregators.reddit.aggregator.fetch_subreddit_info")
    def test_fetch_source_data_rate_limit(self, mock_info, mock_praw, reddit_agg):
        """Test fetch_source_data handles Reddit rate limit errors."""
        mock_info.return_value = {"iconUrl": None}

        mock_reddit = MagicMock()
        mock_subreddit = MagicMock()
        mock_subreddit.hot.side_effect = praw.exceptions.RedditAPIException(
            ["RATELIMIT", "Too many requests", "ratelimit"]
        )
        mock_reddit.subreddit.return_value = mock_subreddit
        mock_praw.return_value = mock_reddit

        with pytest.raises(ValueError, match="rate limit"):
            reddit_agg.fetch_source_data()

    @patch("core.aggregators.reddit.aggregator.get_praw_instance")
    @patch("core.aggregators.reddit.aggregator.fetch_subreddit_info")
    def test_fetch_source_data_connection_error(self, mock_info, mock_praw, reddit_agg):
        """Test fetch_source_data handles connection failures."""
        mock_info.return_value = {"iconUrl": None}

        mock_reddit = MagicMock()
        mock_subreddit = MagicMock()
        mock_subreddit.hot.side_effect = prawcore.exceptions.RequestException(
            original_exception=Exception("Connection refused"),
            request_args=("GET",),
            request_kwargs={},
        )
        mock_reddit.subreddit.return_value = mock_subreddit
        mock_praw.return_value = mock_reddit

        with pytest.raises(ValueError, match="Failed to connect"):
            reddit_agg.fetch_source_data()

    def test_parse_to_raw_articles(self, reddit_agg, mock_reddit_response):
        from core.aggregators.reddit.types import RedditPost

        posts = [RedditPost(mock_reddit_response["data"]["children"][0])]
        source_data = {"posts": posts, "subreddit": "python"}

        articles = reddit_agg.parse_to_raw_articles(source_data)

        assert len(articles) == 1
        assert articles[0]["name"] == "Reddit Post 1"
        assert articles[0]["author"] == "user1"
        assert "reddit.com/r/python/post1" in articles[0]["identifier"]

    def test_parse_to_raw_articles_with_praw_data(self, reddit_agg):
        """Test parse_to_raw_articles works with SimpleNamespace-wrapped RedditPostData."""
        from core.aggregators.reddit.types import RedditPostData

        post_data = RedditPostData(
            {
                "id": "abc123",
                "title": "PRAW Post",
                "author": "testuser",
                "url": "https://example.com",
                "permalink": "/r/python/comments/abc123/praw_post/",
                "created_utc": 1704024000,
                "num_comments": 20,
                "score": 50,
                "is_self": True,
            }
        )
        posts = [SimpleNamespace(data=post_data)]
        source_data = {"posts": posts, "subreddit": "python"}

        articles = reddit_agg.parse_to_raw_articles(source_data)

        assert len(articles) == 1
        assert articles[0]["name"] == "PRAW Post"
        assert articles[0]["author"] == "testuser"
        assert "reddit.com/r/python/comments/abc123" in articles[0]["identifier"]

    def test_filter_articles(self, reddit_agg):
        from datetime import timedelta

        from django.utils import timezone

        # Use a date older than default min_age_hours (48h) but within 2 months
        good_date = timezone.now() - timedelta(hours=72)

        articles = [
            {"name": "Good", "author": "user1", "date": good_date, "_reddit_num_comments": 10},
            {"name": "AutoMod", "author": "AutoModerator", "date": good_date},
            {"name": "Old", "author": "user2", "date": timezone.now() - timedelta(days=70)},
            {
                "name": "Few comments",
                "author": "user3",
                "date": good_date,
                "_reddit_num_comments": 2,
            },
        ]

        filtered = reddit_agg.filter_articles(articles)

        assert len(filtered) == 1
        assert filtered[0]["name"] == "Good"

    def test_filter_articles_preserves_the_exact_date(self, reddit_agg):
        """Regression guard: filter_articles must not rewrite the real post date."""
        from datetime import timedelta

        from django.utils import timezone

        good_date = timezone.now() - timedelta(hours=72)

        filtered = reddit_agg.filter_articles(
            [{"name": "Good", "author": "user1", "date": good_date, "_reddit_num_comments": 10}]
        )

        assert len(filtered) == 1
        assert filtered[0]["date"] == good_date

    def test_filter_articles_naive_date_becomes_aware_without_shifting_the_instant(
        self, reddit_agg
    ):
        from datetime import datetime, timedelta

        from django.utils import timezone

        # A fixed naive datetime, recent enough to survive the age filters below.
        naive = timezone.now().replace(tzinfo=None, microsecond=0) - timedelta(hours=72)

        filtered = reddit_agg.filter_articles(
            [{"name": "Naive", "author": "user1", "date": naive, "_reddit_num_comments": 10}]
        )

        assert len(filtered) == 1
        assert isinstance(filtered[0]["date"], datetime)
        assert timezone.is_aware(filtered[0]["date"])
        assert filtered[0]["date"] == timezone.make_aware(naive)

    def test_filter_articles_min_age_skips_recent_posts(self, reddit_agg):
        """Posts younger than min_age_hours should be skipped."""
        from datetime import timedelta

        from django.utils import timezone

        # Default min_age_hours is 48
        articles = [
            {
                "name": "Too Recent",
                "author": "user1",
                "date": timezone.now() - timedelta(hours=12),
                "_reddit_num_comments": 10,
            },
            {
                "name": "Old Enough",
                "author": "user2",
                "date": timezone.now() - timedelta(hours=72),
                "_reddit_num_comments": 10,
            },
        ]

        filtered = reddit_agg.filter_articles(articles)

        assert len(filtered) == 1
        assert filtered[0]["name"] == "Old Enough"

    def test_filter_articles_min_age_disabled(self, reddit_agg):
        """Setting min_age_hours=0 disables the age filter."""
        from datetime import timedelta

        from django.utils import timezone

        reddit_agg.feed.options = {"min_comments": 0, "min_age_hours": 0}

        articles = [
            {
                "name": "Brand New",
                "author": "user1",
                "date": timezone.now() - timedelta(minutes=5),
                "_reddit_num_comments": 0,
            },
        ]

        filtered = reddit_agg.filter_articles(articles)

        assert len(filtered) == 1
        assert filtered[0]["name"] == "Brand New"

    def test_filter_articles_custom_min_age(self, reddit_agg):
        """Custom min_age_hours value is respected."""
        from datetime import timedelta

        from django.utils import timezone

        reddit_agg.feed.options = {"min_comments": 0, "min_age_hours": 6}

        articles = [
            {
                "name": "Too Fresh",
                "author": "user1",
                "date": timezone.now() - timedelta(hours=3),
                "_reddit_num_comments": 0,
            },
            {
                "name": "Aged Enough",
                "author": "user2",
                "date": timezone.now() - timedelta(hours=8),
                "_reddit_num_comments": 0,
            },
        ]

        filtered = reddit_agg.filter_articles(articles)

        assert len(filtered) == 1
        assert filtered[0]["name"] == "Aged Enough"

    @patch("core.aggregators.reddit.aggregator.build_post_content")
    def test_enrich_articles(self, mock_build, reddit_agg):
        mock_build.return_value = "<html>Content</html>"
        articles = [
            {
                "name": "Post",
                "identifier": "url",
                "_reddit_post_data": {"id": "1"},
                "_reddit_subreddit": "python",
            }
        ]

        enriched = reddit_agg.enrich_articles(articles)

        assert enriched[0]["content"] == "<html>Content</html>"

    def test_get_original_post_data_cross_post(self, reddit_agg):
        from core.aggregators.reddit.types import RedditPostData

        data = {"id": "cross", "crosspost_parent_list": [{"id": "original", "title": "Original"}]}
        post_data = RedditPostData(data)
        original = reddit_agg._get_original_post_data(post_data)
        assert original.id == "original"
        assert original.title == "Original"

    @patch("core.aggregators.reddit.aggregator.get_praw_instance")
    @patch("core.aggregators.reddit.aggregator.fetch_subreddit_info")
    def test_daily_limit_exceeded(self, mock_info, mock_praw, reddit_agg):
        from django.utils import timezone

        mock_info.return_value = {"iconUrl": "https://example.com/icon.png"}
        reddit_agg.daily_limit = 2

        # Create 5 mock submissions
        submissions = []
        for i in range(5):
            submissions.append(
                _make_mock_submission(
                    post_id=f"post{i}",
                    title=f"Post {i}",
                    permalink=f"/r/python/post{i}",
                    url="https://url.com",
                    created_utc=1700000000 + i,
                    crosspost_parent_list=[],
                )
            )

        mock_reddit = MagicMock()
        mock_subreddit = MagicMock()
        mock_subreddit.hot.return_value = submissions
        mock_reddit.subreddit.return_value = mock_subreddit
        mock_praw.return_value = mock_reddit

        # Mock time to late evening (23:00) so target quota is near 100%
        late_evening = timezone.now().replace(hour=23, minute=0, second=0, microsecond=0)

        with (
            patch("django.utils.timezone.now", return_value=late_evening),
            patch.object(reddit_agg, "filter_articles", side_effect=lambda x: x),
            patch.object(reddit_agg, "enrich_articles", side_effect=lambda x: x),
        ):
            articles = reddit_agg.aggregate()

        assert len(articles) == 2

    @patch("core.aggregators.reddit.aggregator.get_praw_instance")
    @patch("core.aggregators.reddit.aggregator.fetch_subreddit_info")
    def test_daily_limit_under_limit(self, mock_info, mock_praw, reddit_agg):
        mock_info.return_value = {"iconUrl": "https://example.com/icon.png"}
        reddit_agg.daily_limit = 5

        # Create 2 mock submissions
        submissions = []
        for i in range(2):
            submissions.append(
                _make_mock_submission(
                    post_id=f"post{i}",
                    title=f"Post {i}",
                    permalink=f"/r/python/post{i}",
                    url="https://url.com",
                    created_utc=1700000000 + i,
                    crosspost_parent_list=[],
                )
            )

        mock_reddit = MagicMock()
        mock_subreddit = MagicMock()
        mock_subreddit.hot.return_value = submissions
        mock_reddit.subreddit.return_value = mock_subreddit
        mock_praw.return_value = mock_reddit

        # Mock filter_articles to return only 1
        with (
            patch.object(reddit_agg, "filter_articles", return_value=[{"name": "Only One"}]),
            patch.object(reddit_agg, "enrich_articles", side_effect=lambda x: x),
        ):
            articles = reddit_agg.aggregate()

        assert len(articles) == 1
        assert articles[0]["name"] == "Only One"


@pytest.mark.django_db
class TestRedditIdentifierChoices:
    """Test get_identifier_choices with PRAW."""

    @patch("core.aggregators.reddit.aggregator.get_praw_instance")
    def test_get_identifier_choices_success(self, mock_praw, user_with_settings):
        """Test successful subreddit search."""
        mock_reddit = MagicMock()
        mock_reddit.subreddits.search.return_value = [
            _make_mock_subreddit_search_result(
                display_name="python",
                display_name_prefixed="r/python",
                title="Python Programming",
                subscribers=1234567,
            ),
            _make_mock_subreddit_search_result(
                display_name="learnpython",
                display_name_prefixed="r/learnpython",
                title="Learn Python",
                subscribers=654321,
            ),
        ]
        mock_praw.return_value = mock_reddit

        choices = RedditAggregator.get_identifier_choices(query="python", user=user_with_settings)

        assert len(choices) == 2
        assert choices[0][0] == "python"
        assert "r/python" in choices[0][1]
        assert "1,234,567 subs" in choices[0][1]
        assert choices[1][0] == "learnpython"
        mock_reddit.subreddits.search.assert_called_once_with("python", limit=10)

    def test_get_identifier_choices_no_query(self, user_with_settings):
        """Test that empty query returns no results."""
        choices = RedditAggregator.get_identifier_choices(query=None, user=user_with_settings)
        assert choices == []

    def test_get_identifier_choices_no_user(self):
        """Test that no user returns no results."""
        choices = RedditAggregator.get_identifier_choices(query="python", user=None)
        assert choices == []

    def test_get_identifier_choices_unauthenticated(self):
        """Test that unauthenticated user returns no results."""
        mock_user = MagicMock()
        mock_user.is_authenticated = False
        choices = RedditAggregator.get_identifier_choices(query="python", user=mock_user)
        assert choices == []

    def test_get_identifier_choices_reddit_not_enabled(self, user):
        """Test that disabled Reddit returns no results."""
        from core.models import UserSettings

        UserSettings.objects.create(
            user=user,
            reddit_enabled=False,
            reddit_client_id="test_id",
            reddit_client_secret="test_secret",
        )
        choices = RedditAggregator.get_identifier_choices(query="python", user=user)
        assert choices == []

    @patch("core.aggregators.reddit.aggregator.get_praw_instance")
    def test_get_identifier_choices_handles_exception(self, mock_praw, user_with_settings):
        """Test that exceptions return empty list."""
        mock_praw.side_effect = Exception("API Error")

        choices = RedditAggregator.get_identifier_choices(query="python", user=user_with_settings)
        assert choices == []


@pytest.mark.django_db
class TestRedditAuth:
    def test_get_reddit_user_settings(self, user_with_settings):
        from core.aggregators.reddit.auth import get_reddit_user_settings

        settings = get_reddit_user_settings(user_with_settings.id)
        assert settings["reddit_enabled"] is True
        assert settings["reddit_client_id"] == "test_client_id"

    def test_get_reddit_user_settings_creates_defaults(self, user):
        """Test that get_reddit_user_settings creates defaults for new users."""
        from core.aggregators.reddit.auth import get_reddit_user_settings

        settings = get_reddit_user_settings(user.id)
        assert settings["reddit_enabled"] is False
        assert settings["reddit_client_id"] == ""
        assert settings["reddit_client_secret"] == ""
        assert settings["reddit_user_agent"] == "Yana/1.0"

    def test_get_reddit_user_settings_nonexistent_user(self):
        """Test that get_reddit_user_settings raises for nonexistent user."""
        from core.aggregators.reddit.auth import get_reddit_user_settings

        with pytest.raises(ValueError, match="User with id 99999 does not exist"):
            get_reddit_user_settings(99999)

    @patch("core.aggregators.reddit.auth.praw.Reddit")
    def test_get_praw_instance_success(self, mock_reddit_class, user_with_settings):
        """Test successful PRAW instance creation."""
        from core.aggregators.reddit.auth import get_praw_instance

        mock_reddit_instance = MagicMock()
        mock_reddit_class.return_value = mock_reddit_instance

        result = get_praw_instance(user_with_settings.id)

        assert result == mock_reddit_instance
        mock_reddit_class.assert_called_once_with(
            client_id="test_client_id",
            client_secret="test_client_secret",
            user_agent="Yana/1.0",
        )

    def test_get_praw_instance_reddit_not_enabled(self, user):
        """Test that get_praw_instance raises when Reddit is not enabled."""
        from core.aggregators.reddit.auth import get_praw_instance
        from core.models import UserSettings

        UserSettings.objects.create(
            user=user,
            reddit_enabled=False,
            reddit_client_id="test_id",
            reddit_client_secret="test_secret",
        )

        with pytest.raises(ValueError, match="Reddit is not enabled"):
            get_praw_instance(user.id)

    def test_get_praw_instance_missing_client_id(self, user):
        """Test that get_praw_instance raises when client_id is missing."""
        from core.aggregators.reddit.auth import get_praw_instance
        from core.models import UserSettings

        UserSettings.objects.create(
            user=user,
            reddit_enabled=True,
            reddit_client_id="",
            reddit_client_secret="test_secret",
        )

        with pytest.raises(ValueError, match="Reddit API credentials not configured"):
            get_praw_instance(user.id)

    def test_get_praw_instance_missing_client_secret(self, user):
        """Test that get_praw_instance raises when client_secret is missing."""
        from core.aggregators.reddit.auth import get_praw_instance
        from core.models import UserSettings

        UserSettings.objects.create(
            user=user,
            reddit_enabled=True,
            reddit_client_id="test_id",
            reddit_client_secret="",
        )

        with pytest.raises(ValueError, match="Reddit API credentials not configured"):
            get_praw_instance(user.id)

    @patch("core.aggregators.reddit.auth.praw.Reddit")
    def test_get_praw_instance_custom_user_agent(self, mock_reddit_class, user):
        """Test that custom user agent is passed to PRAW."""
        from core.aggregators.reddit.auth import get_praw_instance
        from core.models import UserSettings

        UserSettings.objects.create(
            user=user,
            reddit_enabled=True,
            reddit_client_id="test_id",
            reddit_client_secret="test_secret",
            reddit_user_agent="CustomApp/2.0",
        )

        mock_reddit_instance = MagicMock()
        mock_reddit_class.return_value = mock_reddit_instance

        get_praw_instance(user.id)

        mock_reddit_class.assert_called_once_with(
            client_id="test_id",
            client_secret="test_secret",
            user_agent="CustomApp/2.0",
        )


@pytest.mark.django_db
class TestRedditYouTubeEmbed:
    """Test YouTube video embedding in Reddit posts."""

    @pytest.fixture
    def reddit_agg(self, reddit_feed, user_with_settings):
        return RedditAggregator(reddit_feed)

    def test_strip_youtube_link_from_content(self, reddit_agg):
        """Test that YouTube links are stripped when embedded in header."""
        content = """
        <div>Some text</div>
        <p><a href="https://www.youtube.com/watch?v=sl2YybDiluQ" target="_blank">▶ View Video on YouTube</a></p>
        <section>Comments section</section>
        """
        youtube_url = "https://www.youtube.com/watch?v=sl2YybDiluQ"

        result = reddit_agg._strip_youtube_link_from_content(content, youtube_url)

        assert "View Video on YouTube" not in result
        assert "youtube.com/watch" not in result
        assert "Comments section" in result

    def test_strip_youtube_link_different_format(self, reddit_agg):
        """Test stripping works with different YouTube URL formats."""
        content = '<p><a href="https://youtu.be/sl2YybDiluQ">Watch video</a></p>'
        youtube_url = "https://www.youtube.com/watch?v=sl2YybDiluQ"

        result = reddit_agg._strip_youtube_link_from_content(content, youtube_url)

        # Same video ID should be stripped
        assert "youtu.be" not in result

    def test_strip_youtube_link_preserves_other_links(self, reddit_agg):
        """Test that other links are preserved when stripping YouTube link."""
        content = """
        <p><a href="https://www.youtube.com/watch?v=abc123def45">Video 1</a></p>
        <p><a href="https://www.youtube.com/watch?v=xyz789ghi12">Video 2</a></p>
        <p><a href="https://reddit.com/r/test">Reddit link</a></p>
        """
        youtube_url = "https://www.youtube.com/watch?v=abc123def45"

        result = reddit_agg._strip_youtube_link_from_content(content, youtube_url)

        assert "abc123def45" not in result
        assert "xyz789ghi12" in result  # Different video, should be preserved
        assert "reddit.com/r/test" in result

    def test_parse_youtube_video_url(self, reddit_agg):
        """Test that YouTube URLs are detected as video URLs."""
        from core.aggregators.reddit.types import RedditPost

        post_data = {
            "data": {
                "id": "testpost",
                "title": "YouTube Video Post",
                "url": "https://www.youtube.com/watch?v=sl2YybDiluQ",
                "author": "user1",
                "permalink": "/r/NintendoSwitch/comments/abc123/test/",
                "created_utc": 1704024000,
                "num_comments": 50,
                "is_self": False,
            }
        }

        posts = [RedditPost(post_data)]
        source_data = {"posts": posts, "subreddit": "NintendoSwitch"}

        articles = reddit_agg.parse_to_raw_articles(source_data)

        assert len(articles) == 1
        assert articles[0]["_reddit_video_url"] == "https://www.youtube.com/watch?v=sl2YybDiluQ"

    def test_parse_youtu_be_video_url(self, reddit_agg):
        """Test that youtu.be short URLs are detected as video URLs."""
        from core.aggregators.reddit.types import RedditPost

        post_data = {
            "data": {
                "id": "testpost",
                "title": "YouTube Video Post",
                "url": "https://youtu.be/sl2YybDiluQ",
                "author": "user1",
                "permalink": "/r/NintendoSwitch/comments/abc123/test/",
                "created_utc": 1704024000,
                "num_comments": 50,
                "is_self": False,
            }
        }

        posts = [RedditPost(post_data)]
        source_data = {"posts": posts, "subreddit": "NintendoSwitch"}

        articles = reddit_agg.parse_to_raw_articles(source_data)

        assert len(articles) == 1
        assert articles[0]["_reddit_video_url"] == "https://youtu.be/sl2YybDiluQ"


class TestContentFormatterYouTubeEmbed:
    """Test YouTube embed in content formatter."""

    def test_format_with_youtube_header(self):
        """Test that YouTube URLs are rendered as iframe embeds."""
        from core.aggregators.utils.content_formatter import format_article_content

        result = format_article_content(
            content="<p>Some content</p>",
            title="Test Title",
            url="https://reddit.com/r/test/comments/abc123/",
            header_image_url="https://www.youtube.com/watch?v=sl2YybDiluQ",
        )

        # Should have an iframe embed, not an img tag
        assert "<iframe" in result
        assert "youtube-embed-container" in result
        assert '<img src="https://www.youtube.com/watch' not in result

    def test_format_with_regular_image_header(self):
        """Test that regular images still work as img tags."""
        from core.aggregators.utils.content_formatter import format_article_content

        result = format_article_content(
            content="<p>Some content</p>",
            title="Test Title",
            url="https://reddit.com/r/test/",
            header_image_url="https://i.redd.it/example.jpg",
        )

        assert '<img src="https://i.redd.it/example.jpg"' in result
        assert "<iframe" not in result

    def test_format_with_youtu_be_header(self):
        """Test that youtu.be short URLs are also rendered as iframes."""
        from core.aggregators.utils.content_formatter import format_article_content

        result = format_article_content(
            content="<p>Some content</p>",
            title="Test Title",
            url="https://reddit.com/r/test/",
            header_image_url="https://youtu.be/sl2YybDiluQ",
        )

        assert "<iframe" in result
        assert "youtube-embed-container" in result
