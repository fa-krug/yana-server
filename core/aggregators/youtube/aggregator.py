"""YouTube aggregator implementation."""

import html
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from django.utils import timezone

from ..base import BaseAggregator
from ..utils import format_article_content
from ..utils.youtube import create_youtube_embed_html
from ..utils.youtube_client import YouTubeAPIError, YouTubeClient

logger = logging.getLogger(__name__)


class YouTubeAggregator(BaseAggregator):
    """
    YouTube aggregator using YouTube Data API v3.
    """

    identifier_field = "youtube_channel"

    def __init__(self, feed):
        super().__init__(feed)
        self._client: Optional[YouTubeClient] = None
        self._channel_id: Optional[str] = None

    @classmethod
    def get_identifier_from_related(cls, related_obj: Any) -> str:
        """Extract channel ID."""
        return getattr(related_obj, "channel_id", str(related_obj))

    def get_aggregator_type(self) -> str:
        return "youtube"

    supports_identifier_search = True

    @classmethod
    def get_identifier_choices(
        cls, query: Optional[str] = None, user: Optional[Any] = None
    ) -> List[tuple]:
        """Search for YouTube channels via API."""
        if not query or not user:
            return []

        channels = cls.search_channels(query, user)
        choices = []

        for channel in channels:
            channel_id = channel["channel_id"]
            title = channel["title"]
            handle = channel["custom_url"]

            # Prefer handle in label for better UX
            label = f"{title} ({handle})" if handle else f"{title} ({channel_id})"

            # (value, label) -> value is what gets saved (channel_id), label is what is displayed
            choices.append((channel_id, label))

        return choices

    @classmethod
    def search_channels(cls, query: str, user: Any) -> List[Dict[str, Any]]:
        """Search for YouTube channels and return full metadata."""
        if not query or not user or not user.is_authenticated:
            return []

        try:
            from core.models import UserSettings

            settings = UserSettings.objects.get(user=user)
            if not settings.youtube_enabled or not settings.youtube_api_key:
                return []

            client = YouTubeClient(settings.youtube_api_key)

            # 1. Search for channel IDs
            data = client._get(
                "search", {"part": "id", "q": query, "type": "channel", "maxResults": 10}
            )

            items = data.get("items", [])
            channel_ids = [
                item.get("id", {}).get("channelId")
                for item in items
                if item.get("id", {}).get("channelId")
            ]

            if not channel_ids:
                return []

            # 2. Fetch full channel data (including customUrl/handle)
            return client.fetch_channels_data(channel_ids)
        except Exception as e:
            logger.error(f"Error searching YouTube channels: {e}")
            return []

    @classmethod
    def update_search_results(cls, query: str, user: Any) -> None:
        """Search YouTube channels and update local YouTubeChannel models."""
        from core.models import YouTubeChannel

        channels = cls.search_channels(query, user)

        for channel in channels:
            YouTubeChannel.objects.update_or_create(
                channel_id=channel["channel_id"],
                defaults={
                    "title": channel["title"][:255],
                    "handle": channel["custom_url"] or "",
                },
            )

    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """Get YouTube configuration fields."""
        from django import forms

        return {
            "comment_limit": forms.IntegerField(
                initial=10,
                label="Comment Limit",
                help_text="Number of top comments to include below the video.",
                required=False,
                min_value=0,
                max_value=50,
            ),
        }

    def get_source_url(self) -> str:
        """Return the YouTube channel URL."""
        if self.identifier:
            if self.identifier.startswith("UC"):
                return f"https://www.youtube.com/channel/{self.identifier}"
            if self.identifier.startswith("@"):
                return f"https://www.youtube.com/{self.identifier}"
        return "https://www.youtube.com"

    def _get_client(self) -> YouTubeClient:
        """Get or create the YouTube API client."""
        if self._client:
            return self._client

        if not self.feed or not self.feed.user:
            raise YouTubeAPIError("Feed must have a user to access YouTube API settings")

        from core.models import UserSettings

        try:
            settings = UserSettings.objects.get(user=self.feed.user)
            if not settings.youtube_enabled or not settings.youtube_api_key:
                raise YouTubeAPIError(
                    "YouTube API is not enabled or API key is missing in user settings"
                )

            self._client = YouTubeClient(settings.youtube_api_key)
            return self._client
        except UserSettings.DoesNotExist as e:
            raise YouTubeAPIError("User settings not found") from e

    def logo_image_url(self) -> Optional[str]:
        """Channel avatar from the YouTube Data API."""
        channel_id = self.identifier
        if not channel_id:
            return None
        client = self._get_client()
        channels = client.fetch_channels_data([channel_id])
        return channels[0].get("channel_icon_url") if channels else None

    def validate(self) -> None:
        """Validate and resolve channel identifier."""
        super().validate()

        client = self._get_client()
        channel_id, error = client.resolve_channel_id(self.identifier)

        if error or not channel_id:
            raise YouTubeAPIError(f"Could not resolve YouTube identifier: {error}")

        self._channel_id = channel_id

    def normalize_identifier(self, identifier: str) -> str:
        """
        Normalize YouTube identifier.
        Extracts ID/handle from 'Title (ID)' format or URLs.
        """
        iden = identifier.strip()

        # Handle 'Title (ID)' format from autocomplete label
        if "(" in iden and iden.endswith(")"):
            start = iden.rfind("(") + 1
            return iden[start:-1].strip()

        # Handle full URLs
        if "youtube.com" in iden or "youtu.be" in iden:
            # Use client's internal extractor if possible, or just return as is
            # since resolve_channel_id handles URLs anyway.
            # But for storage, we want it clean.
            pass

        return iden

    def get_identifier_label(self, identifier: str) -> str:
        """Get descriptive label for current identifier."""
        if self.feed and self.feed.name:
            return f"{self.feed.name} ({identifier})"
        return identifier

    def fetch_source_data(self, limit: Optional[int] = None) -> Any:
        """Fetch videos from the channel."""
        if not self._channel_id:
            self.validate()

        assert self._channel_id is not None
        client = self._get_client()

        # Fetch channel metadata (for icon and uploads playlist)
        channel_data = client.fetch_channel_data(self._channel_id)

        # Back-populate metadata to local YouTubeChannel model if attached
        if self.feed and self.feed.youtube_channel:
            try:
                yt_channel = self.feed.youtube_channel
                updated = False
                if not yt_channel.handle and channel_data.get("custom_url"):
                    yt_channel.handle = channel_data["custom_url"]
                    updated = True
                if yt_channel.title != channel_data.get("title"):
                    yt_channel.title = (channel_data.get("title") or "")[:255]
                    updated = True
                if updated:
                    yt_channel.save()
            except Exception as e:
                logger.warning(f"Failed to update YouTubeChannel metadata: {e}")

        uploads_playlist_id = channel_data.get("uploads_playlist_id")
        desired_count = limit or self.daily_limit

        if uploads_playlist_id:
            videos = client.fetch_videos_from_playlist(
                uploads_playlist_id, max_results=desired_count
            )
        else:
            # Fallback to search if uploads playlist is not available
            videos = client.fetch_videos_via_search(self._channel_id, max_results=desired_count)

        return {
            "videos": videos,
            "channel_id": self._channel_id,
            "channel_title": channel_data.get("custom_url") or channel_data.get("title"),
        }

    def parse_to_raw_articles(self, source_data: Any) -> List[Dict[str, Any]]:
        """Parse YouTube videos to article dictionaries."""
        videos = source_data.get("videos", [])
        articles = []

        for video in videos:
            snippet = video.get("snippet", {})
            video_id = video.get("id")
            if isinstance(video_id, dict):
                video_id = video_id.get("videoId")

            published_at = snippet.get("publishedAt")
            if published_at:
                date = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
            else:
                date = timezone.now()

            # Use high quality thumbnail if available
            thumbnails = snippet.get("thumbnails", {})
            icon_url = (
                thumbnails.get("maxres", {}).get("url")
                or thumbnails.get("high", {}).get("url")
                or thumbnails.get("medium", {}).get("url")
            )

            article = {
                "name": snippet.get("title", ""),
                "identifier": f"https://www.youtube.com/watch?v={video_id}",
                "raw_content": snippet.get("description", ""),
                "content": snippet.get("description", ""),
                "date": date,
                "author": source_data.get("channel_title", ""),
                "icon": icon_url,
                "_youtube_video_id": video_id,
            }
            articles.append(article)

        return articles

    def enrich_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Enrich articles with comments and build full HTML content."""
        client = self._get_client()

        comment_limit = self.feed.options.get("comment_limit", 10)

        for article in articles:
            video_id = article.get("_youtube_video_id")
            description = article.get("content", "")

            # Fetch comments
            comments = []
            if isinstance(video_id, str):
                comments = client.fetch_video_comments(video_id, max_results=comment_limit)

            # Build content HTML
            content_html = self._build_content_html(
                description, comments, video_id if isinstance(video_id, str) else ""
            )
            article["content"] = content_html
            article["raw_content"] = (
                content_html  # YouTube articles don't have separate raw content from website
            )

        return articles

    def _build_content_html(
        self, description: str, comments: List[Dict[str, Any]], video_id: str
    ) -> str:
        """Build the final HTML content for the article."""
        # Convert description newlines to <br>
        formatted_description = description.replace("\n", "<br>")

        html_content = f'<div class="youtube-description">{formatted_description}</div>'

        if comments:
            html_content += '<div class="youtube-comments"><h3>Comments</h3>'
            for comment in comments:
                top_level = comment.get("snippet", {}).get("topLevelComment", {})
                snippet = top_level.get("snippet", {})
                author = snippet.get("authorDisplayName", "Unknown")
                body = snippet.get("textDisplay", "")
                comment_id = comment.get("id")

                # Construct link to specific comment
                comment_url = f"https://www.youtube.com/watch?v={video_id}&lc={comment_id}"

                html_content += f"""
<blockquote>
<p><strong>{html.escape(author)}</strong> | <a href="{comment_url}" target="_blank" rel="noopener">source</a></p>
<div>{body}</div>
</blockquote>
"""
            html_content += "</div>"

        return html_content

    def finalize_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Finalize articles by adding the YouTube embed in the header."""
        # Apply AI processing first
        articles = self._apply_ai_processing(articles)

        finalized = []

        for article in articles:
            video_id = article.get("_youtube_video_id")

            # Create YouTube embed
            embed_html = ""
            if isinstance(video_id, str):
                embed_html = create_youtube_embed_html(video_id)

            # Use format_article_content for standard Yana styling
            processed = format_article_content(
                content=article["content"],
                title=article["name"],
                url=article["identifier"],
            )

            # Prepend the embed to the formatted content
            article["content"] = embed_html + processed

            # Clean up internal fields
            article.pop("_youtube_video_id", None)
            finalized.append(article)

        return finalized

    def fetch_article_content(self, url: str) -> str:
        """Fetch video details from YouTube API."""
        from ..utils.youtube import extract_youtube_video_id

        video_id = extract_youtube_video_id(url)
        if not video_id:
            return ""

        client = self._get_client()
        videos = client.fetch_video_details([video_id])
        if not videos:
            return ""

        # Fetch comments
        comments = client.fetch_video_comments(video_id, max_results=10)

        # We return the video_id and comments as part of a custom string that extract_content can parse
        # or we just store them in self to be used by extract_content/process_content
        self._last_reloaded_video = videos[0]
        self._last_reloaded_comments = comments

        # Return the description as 'raw content'
        return videos[0].get("snippet", {}).get("description", "")

    def extract_content(self, html: str, article: Dict[str, Any]) -> str:
        """Build content HTML for YouTube video."""
        if not hasattr(self, "_last_reloaded_video"):
            return html

        video = self._last_reloaded_video
        comments = getattr(self, "_last_reloaded_comments", [])

        video_id = video.get("id")
        description = video.get("snippet", {}).get("description", "")

        if not isinstance(video_id, str):
            return html

        # Build the HTML content using the existing method
        return self._build_content_html(description, comments, video_id)

    def process_content(self, content: str, article: Dict[str, Any]) -> str:
        """Finalize YouTube article content with embed and Yana formatting."""
        if not hasattr(self, "_last_reloaded_video"):
            return content

        video = self._last_reloaded_video
        video_id = video.get("id")

        if not isinstance(video_id, str):
            return content

        # Create YouTube embed
        embed_html = create_youtube_embed_html(video_id)

        # Use format_article_content for standard Yana styling
        processed = format_article_content(
            content=content,
            title=article["name"],
            url=article["identifier"],
        )

        return embed_html + processed

    def aggregate(self) -> List[Dict[str, Any]]:
        """Implementation of the aggregation flow."""
        try:
            self.validate()
            limit = self.get_current_run_limit()
            if limit == 0:
                return []

            source_data = self.fetch_source_data(limit)
            articles = self.parse_to_raw_articles(source_data)
            articles = self.filter_articles(articles)
            articles = self.enrich_articles(articles)
            articles = self.finalize_articles(articles)
            return articles
        except Exception as e:
            self.logger.error(f"Aggregation failed for {self.identifier}: {str(e)}")
            raise
