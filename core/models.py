"""Database models for the application."""

from django.db import models
from django.utils import timezone

from .choices import AGGREGATOR_CHOICES

AI_PROVIDER_CHOICES = [
    ("openai", "OpenAI"),
    ("anthropic", "Anthropic"),
    ("gemini", "Gemini"),
]

OPENAI_MODEL_CHOICES = [
    ("gpt-4o", "GPT-4o"),
    ("gpt-4o-mini", "GPT-4o Mini"),
    ("gpt-4-turbo", "GPT-4 Turbo"),
    ("gpt-3.5-turbo", "GPT-3.5 Turbo"),
    ("o1-preview", "o1 Preview"),
    ("o1-mini", "o1 Mini"),
]

ANTHROPIC_MODEL_CHOICES = [
    ("claude-3-5-sonnet-20240620", "Claude 3.5 Sonnet"),
    ("claude-3-opus-20240229", "Claude 3 Opus"),
    ("claude-3-sonnet-20240229", "Claude 3 Sonnet"),
    ("claude-3-haiku-20240307", "Claude 3 Haiku"),
]

GEMINI_MODEL_CHOICES = [
    ("gemini-3-pro-preview", "Gemini 3 Pro Preview"),
    ("gemini-3-flash-preview", "Gemini 3 Flash Preview"),
    ("gemini-2.5-pro", "Gemini 2.5 Pro"),
    ("gemini-2.5-flash", "Gemini 2.5 Flash"),
    ("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite"),
    ("gemini-2.0-flash", "Gemini 2.0 Flash"),
    ("gemini-2.0-flash-lite", "Gemini 2.0 Flash-Lite"),
    ("gemini-1.5-pro", "Gemini 1.5 Pro"),
    ("gemini-1.5-flash", "Gemini 1.5 Flash"),
    ("gemini-1.0-pro", "Gemini 1.0 Pro"),
]


class FeedGroup(models.Model):
    """Feed group for organizing feeds."""

    name = models.CharField(max_length=255)
    user = models.ForeignKey("auth.User", on_delete=models.CASCADE, related_name="feed_groups")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Feed Group"
        verbose_name_plural = "Feed Groups"
        unique_together = [["name", "user"]]
        ordering = ["name"]

    def __str__(self):
        return self.name


class Feed(models.Model):
    """Feed configuration for content aggregation."""

    name = models.CharField(max_length=255)
    aggregator = models.CharField(max_length=50, choices=AGGREGATOR_CHOICES, default="full_website")
    identifier = models.TextField(
        blank=True,
        default="",
        help_text="Required for Reddit and YouTube aggregators. For others, optional URL or identifier.",
    )
    daily_limit = models.IntegerField(default=20)
    enabled = models.BooleanField(default=True)
    user = models.ForeignKey(
        "auth.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="feeds"
    )
    group = models.ForeignKey(
        FeedGroup, on_delete=models.SET_NULL, null=True, blank=True, related_name="feeds"
    )
    # Autocomplete relationships
    reddit_subreddit = models.ForeignKey(
        "RedditSubreddit", on_delete=models.SET_NULL, null=True, blank=True
    )
    youtube_channel = models.ForeignKey(
        "YouTubeChannel", on_delete=models.SET_NULL, null=True, blank=True
    )
    options = models.JSONField(
        default=dict, blank=True, help_text="Aggregator-specific configuration"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Feed"
        verbose_name_plural = "Feeds"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["user"]),
            models.Index(fields=["group"]),
            models.Index(fields=["aggregator"]),
        ]

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        """Sync identifier from related models if applicable."""
        try:
            from .aggregators.registry import AggregatorRegistry

            agg_class = AggregatorRegistry.get(self.aggregator)

            # If the aggregator uses a specialized field, sync the string identifier
            if agg_class.identifier_field != "identifier":
                related_obj = getattr(self, agg_class.identifier_field)
                if related_obj:
                    self.identifier = agg_class.get_identifier_from_related(related_obj)
        except Exception:
            # Fallback for initialization or unknown aggregators
            pass

        super().save(*args, **kwargs)


class Article(models.Model):
    """Article from a feed."""

    name = models.CharField(max_length=500)  # Article title
    identifier = models.TextField()  # URL or external ID
    raw_content = models.TextField(help_text="Raw HTML content")
    content = models.TextField(help_text="Processed content")
    date = models.DateTimeField(default=timezone.now)
    read = models.BooleanField(default=False)
    starred = models.BooleanField(default=False)
    author = models.CharField(max_length=255, blank=True, default="")
    icon = models.ImageField(upload_to="article_icons/", blank=True, null=True)
    feed = models.ForeignKey(Feed, on_delete=models.CASCADE, related_name="articles")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Article"
        verbose_name_plural = "Articles"
        ordering = ["-date"]
        indexes = [
            models.Index(fields=["feed", "identifier"]),
            models.Index(fields=["feed", "date"]),
            models.Index(fields=["date"]),
            models.Index(fields=["read"]),
            models.Index(fields=["starred"]),
            models.Index(fields=["feed", "read", "date"]),
        ]

    def __str__(self):
        return self.name


class UserSettings(models.Model):
    """User settings for API credentials and preferences."""

    user = models.OneToOneField(
        "auth.User", on_delete=models.CASCADE, related_name="user_settings", unique=True
    )

    # Reddit API
    reddit_enabled = models.BooleanField(default=False)
    reddit_client_id = models.CharField(max_length=255, blank=True, default="")
    reddit_client_secret = models.CharField(max_length=255, blank=True, default="")
    reddit_user_agent = models.CharField(max_length=255, default="Yana/1.0")

    # YouTube API
    youtube_enabled = models.BooleanField(default=False)
    youtube_api_key = models.CharField(max_length=255, blank=True, default="")

    # AI Provider Settings
    active_ai_provider = models.CharField(
        max_length=50,
        choices=AI_PROVIDER_CHOICES,
        blank=True,
        default="",
        help_text="Select an AI provider to enable AI features. Leave blank to disable.",
    )

    # OpenAI API
    openai_enabled = models.BooleanField(default=False)
    openai_api_url = models.CharField(max_length=255, default="https://api.openai.com/v1")
    openai_api_key = models.CharField(max_length=255, blank=True, default="")
    openai_model = models.CharField(
        max_length=100, default="gpt-4o-mini", choices=OPENAI_MODEL_CHOICES
    )

    # Anthropic API
    anthropic_enabled = models.BooleanField(default=False)
    anthropic_api_key = models.CharField(max_length=255, blank=True, default="")
    anthropic_model = models.CharField(
        max_length=100, default="claude-3-5-sonnet-20240620", choices=ANTHROPIC_MODEL_CHOICES
    )

    # Gemini API
    gemini_enabled = models.BooleanField(default=False)
    gemini_api_key = models.CharField(max_length=255, blank=True, default="")
    gemini_model = models.CharField(
        max_length=100, default="gemini-1.5-flash", choices=GEMINI_MODEL_CHOICES
    )

    # Global AI Settings
    ai_temperature = models.FloatField(default=0.3)
    ai_max_tokens = models.IntegerField(default=2000)
    ai_default_daily_limit = models.IntegerField(default=200)
    ai_default_monthly_limit = models.IntegerField(default=2000)
    ai_max_prompt_length = models.IntegerField(default=500)
    ai_request_timeout = models.IntegerField(default=120)
    ai_max_retries = models.IntegerField(default=3)
    ai_retry_delay = models.IntegerField(default=2)
    ai_request_delay = models.IntegerField(
        default=2,
        help_text="Delay in seconds between AI API calls to avoid rate limits.",
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "User Settings"
        verbose_name_plural = "User Settings"
        indexes = [
            models.Index(fields=["user"]),
        ]

    def __str__(self):
        return f"Settings for {self.user.username}"


class RedditSubreddit(models.Model):
    """Reddit subreddit model for autocomplete."""

    display_name = models.CharField(max_length=255, unique=True)
    title = models.CharField(max_length=255, blank=True)
    subscribers = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "Reddit Subreddit"
        verbose_name_plural = "Reddit Subreddits"
        ordering = ["display_name"]
        indexes = [models.Index(fields=["display_name"])]

    def __str__(self):
        return f"r/{self.display_name} ({self.subscribers:,} subs)"


class YouTubeChannel(models.Model):
    """YouTube channel model for autocomplete."""

    channel_id = models.CharField(max_length=255, unique=True)
    title = models.CharField(max_length=255)
    handle = models.CharField(max_length=255, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "YouTube Channel"
        verbose_name_plural = "YouTube Channels"
        ordering = ["title"]
        indexes = [models.Index(fields=["title"])]

    def __str__(self):
        if self.handle:
            return f"{self.title} ({self.handle})"
        return self.title
