"""Reddit aggregator implementation."""

import logging
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from django.utils import timezone

import praw.exceptions
import prawcore.exceptions
from bs4 import BeautifulSoup

from ..base import BaseAggregator
from ..exceptions import ArticleSkipError
from ..services.image_extraction.compression import compress_and_encode_image
from ..services.image_extraction.fetcher import fetch_single_image
from ..utils import format_article_content
from ..utils.twitter import is_twitter_url
from ..utils.youtube import extract_youtube_video_id
from .auth import (
    get_praw_instance,
    get_reddit_user_settings,
)
from .content import build_post_content
from .images import extract_header_image_url, extract_thumbnail_url
from .posts import fetch_reddit_post
from .types import RedditPostData
from .urls import (
    extract_post_info_from_url,
    fetch_subreddit_info,
    normalize_subreddit,
    validate_subreddit,
)

logger = logging.getLogger(__name__)


class RedditAggregator(BaseAggregator):
    """Aggregator for Reddit subreddits using PRAW."""

    identifier_field = "reddit_subreddit"
    supports_identifier_search = True

    def __init__(self, feed):
        """Initialize Reddit aggregator."""
        super().__init__(feed)

    @classmethod
    def get_identifier_from_related(cls, related_obj: Any) -> str:
        """Extract subreddit display name."""
        return getattr(related_obj, "display_name", str(related_obj))

    def get_source_url(self) -> str:
        """Return the Reddit subreddit URL."""
        if self.identifier:
            subreddit = normalize_subreddit(self.identifier)
            return f"https://www.reddit.com/r/{subreddit}"
        return "https://www.reddit.com"

    @classmethod
    def get_identifier_choices(
        cls, query: Optional[str] = None, user: Optional[Any] = None
    ) -> List[tuple]:
        """
        Search for subreddits via PRAW.
        """
        if not query or not user or not user.is_authenticated:
            return []

        try:
            # Check if Reddit is enabled for this user
            settings = get_reddit_user_settings(user.id)
            if not settings.get("reddit_enabled"):
                return []

            reddit = get_praw_instance(user.id)
            results = reddit.subreddits.search(query, limit=10)

            choices = []
            for sub in results:
                display_name = sub.display_name or ""
                display_name_prefixed = sub.display_name_prefixed or ""
                title = sub.title or ""
                subscribers = sub.subscribers or 0

                label = f"{display_name_prefixed}: {title} ({subscribers:,} subs)"
                choices.append((display_name, label))

            return choices

        except Exception as e:
            logger.error(f"Error searching subreddits: {e}")
            return []

    @classmethod
    def update_search_results(cls, query: str, user: Any) -> None:
        """Search subreddits and update local RedditSubreddit models."""
        import re

        from core.models import RedditSubreddit

        choices = cls.get_identifier_choices(query=query, user=user)

        # Format: "r/{display_name}: {title} ({subscribers:,} subs)"
        pattern = re.compile(r"^r/[^:]+:\s*(?P<title>.*)\s+\((?P<subs>[\d,]+)\s+subs\)$")

        for value, label in choices:
            title = ""
            subscribers = 0
            match = pattern.match(label)
            if match:
                title = match.group("title")
                subs_str = match.group("subs").replace(",", "")
                if subs_str.isdigit():
                    subscribers = int(subs_str)

            RedditSubreddit.objects.update_or_create(
                display_name=value,
                defaults={
                    "title": title[:255],
                    "subscribers": subscribers,
                },
            )

    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """Get Reddit configuration fields."""
        from django import forms

        return {
            "min_comments": forms.IntegerField(
                initial=5,
                label="Minimum Comments",
                help_text="Skip posts with fewer comments than this.",
                required=False,
                min_value=0,
            ),
            "comment_limit": forms.IntegerField(
                initial=10,
                label="Comment Limit",
                help_text="Number of top comments to include in the article body.",
                required=False,
                min_value=0,
                max_value=50,
            ),
            "include_header_image": forms.BooleanField(
                initial=True,
                label="Include Header Image",
                help_text="Include the post image/thumbnail at the top of the article.",
                required=False,
            ),
            "subreddit_sort": forms.ChoiceField(
                choices=[
                    ("hot", "Hot"),
                    ("new", "New"),
                    ("top", "Top"),
                    ("rising", "Rising"),
                ],
                initial="hot",
                label="Sort Order",
                help_text="Which posts to fetch (Hot, New, Top, Rising).",
                required=False,
            ),
            "min_age_hours": forms.IntegerField(
                initial=48,
                label="Minimum Post Age (hours)",
                help_text=(
                    "Only import posts older than this many hours. "
                    "Helps filter out posts that get removed by moderators shortly after posting. "
                    "Set to 0 to disable."
                ),
                required=False,
                min_value=0,
                max_value=168,
            ),
        }

    def aggregate(self) -> List[Dict[str, Any]]:
        """Implement template method pattern flow."""
        self.validate()
        limit = self.get_current_run_limit()
        if limit == 0:
            return []

        source_data = self.fetch_source_data(limit)
        articles = self.parse_to_raw_articles(source_data)
        articles = self.filter_articles(articles)

        # Respect daily_limit after filtering
        if len(articles) > limit:
            logger.info(f"Limiting Reddit articles from {len(articles)} to {limit}")
            articles = articles[:limit]

        articles = self.enrich_articles(articles)
        articles = self.finalize_articles(articles)
        return articles

    def validate(self) -> None:
        """Validate feed configuration."""
        super().validate()

        if not self.feed:
            raise ValueError("Feed not initialized")

        if not self.feed.user:
            raise ValueError(
                "Feed must have a user to use Reddit API. Reddit requires authenticated API access."
            )

        subreddit = normalize_subreddit(self.identifier)
        if not subreddit:
            raise ValueError(f"Could not extract subreddit from identifier: {self.identifier}")

        validation = validate_subreddit(subreddit)
        if not validation["valid"]:
            raise ValueError(validation.get("error", "Invalid subreddit"))

        # Validate Reddit is enabled and credentials are configured
        settings = get_reddit_user_settings(self.feed.user.id)
        if not settings.get("reddit_enabled"):
            raise ValueError(
                "Reddit is not enabled. Please enable Reddit in your settings and configure API credentials."
            )

        if not settings.get("reddit_client_id") or not settings.get("reddit_client_secret"):
            raise ValueError(
                "Reddit API credentials not configured. Please set Client ID and Client Secret in your settings."
            )

    def normalize_identifier(self, identifier: str) -> str:
        """
        Normalize Reddit identifier.
        Extracts subreddit name from 'r/name: title (subs)' format.
        """
        iden = identifier.strip()

        # Handle 'r/name: title (subs)' format
        if ":" in iden:
            part = iden.split(":")[0].strip()
            if part.startswith("r/"):
                return part.replace("r/", "")
            return part

        # Standard normalization (removes r/ prefix etc)
        return normalize_subreddit(iden) or iden

    def get_identifier_label(self, identifier: str) -> str:
        """Get descriptive label for current identifier."""
        if self.feed and self.feed.name:
            return f"{self.feed.name} (r/{identifier})"
        return identifier

    def fetch_source_data(self, limit: Optional[int] = None) -> Dict[str, Any]:
        """
        Fetch Reddit posts via PRAW.

        Args:
            limit: Optional limit on number of posts to fetch

        Returns:
            Dict with 'posts', 'subreddit', and 'subredditInfo' keys.
            Each post in 'posts' is a SimpleNamespace with a .data attribute
            containing a RedditPostData instance (compatible with parse_to_raw_articles).
        """
        from types import SimpleNamespace

        if not self.feed or not self.feed.user:
            raise ValueError("Feed not initialized or missing user")

        subreddit = normalize_subreddit(self.identifier)
        if not subreddit:
            raise ValueError(f"Could not extract subreddit from identifier: {self.identifier}")

        user_id = self.feed.user.id

        # Get sort method (default: hot)
        sort_by = self.feed.options.get("subreddit_sort", "hot")

        # Fetch subreddit info to get icon for feed thumbnail
        subreddit_info = fetch_subreddit_info(subreddit, user_id)
        self.subreddit_icon_url = subreddit_info.get("iconUrl")

        # Calculate desired article count
        desired_article_count = limit or 25

        # Fetch 2-3x more posts than needed to account for filtering
        # (AutoModerator posts, old posts, etc.)
        # Reddit API max is 100
        fetch_limit = min(desired_article_count * 3, 100)

        try:
            reddit = get_praw_instance(user_id)
            subreddit_obj = reddit.subreddit(subreddit)

            # Fetch posts using the configured sort method
            submissions = list(getattr(subreddit_obj, sort_by)(limit=fetch_limit))

            # Convert PRAW submissions to RedditPostData and wrap for
            # compatibility with parse_to_raw_articles (which expects post.data)
            posts = [SimpleNamespace(data=RedditPostData.from_praw(s)) for s in submissions]

            logger.info(f"Reddit posts fetched: {len(posts)} posts from r/{subreddit}")

            return {
                "posts": posts,
                "subreddit": subreddit,
                "subredditInfo": subreddit_info,
            }

        except prawcore.exceptions.Forbidden as e:
            raise ValueError(f"Subreddit 'r/{subreddit}' is private or banned.") from e
        except prawcore.exceptions.NotFound as e:
            raise ValueError(f"Subreddit 'r/{subreddit}' does not exist.") from e
        except praw.exceptions.RedditAPIException as e:
            raise ValueError("Reddit rate limit exceeded.") from e
        except prawcore.exceptions.RequestException as e:
            raise ValueError("Failed to connect to Reddit.") from e
        except Exception as e:
            logger.error(f"Error fetching Reddit posts: {e}")
            raise

    def parse_to_raw_articles(self, source_data: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Parse Reddit posts to raw article dictionaries.

        Args:
            source_data: Dict with 'posts', 'subreddit', and 'subredditInfo' keys

        Returns:
            List of article dictionaries
        """
        posts = source_data.get("posts", [])
        subreddit = source_data.get("subreddit", "")

        if not posts:
            logger.warning(f"No posts found in subreddit r/{subreddit}")
            return []

        articles = []

        for post in posts:
            # Get original post data if this is a cross-post
            post_data = self._get_original_post_data(post.data)
            is_cross_post = bool(
                post.data.crosspost_parent_list and len(post.data.crosspost_parent_list) > 0
            )

            # Get the original subreddit from the post data (for cross-posts, use original subreddit)
            original_subreddit = (
                post.data.crosspost_parent_list[0].get("subreddit", "")
                if post.data.crosspost_parent_list
                else subreddit
            )

            # Build permalink URL
            decoded_permalink = post_data.permalink.replace("&amp;", "&")
            permalink = f"https://reddit.com{decoded_permalink}"

            # Extract header image and thumbnail
            header_image_url = extract_header_image_url(post_data)
            thumbnail_url = extract_thumbnail_url(post_data)
            article_thumbnail_url = header_image_url or thumbnail_url

            # Extract video media URL (v.redd.it or YouTube)
            video_url = None
            if post_data.url:
                url_lower = post_data.url.lower()
                if (
                    "v.redd.it" in url_lower
                    or "youtube.com" in url_lower
                    or "youtu.be" in url_lower
                ):
                    video_url = post_data.url

            # Convert created_utc to datetime
            post_date = datetime.fromtimestamp(post_data.created_utc, tz=dt_timezone.utc)

            article = {
                "name": post_data.title,
                "identifier": permalink,
                "raw_content": "",  # Will be filled in enrich_articles
                "content": "",  # Will be filled in enrich_articles
                "date": post_date,
                "author": post_data.author,
                "icon": article_thumbnail_url,
                # Store additional Reddit-specific data
                "_reddit_post_data": post_data.to_dict(),
                "_reddit_subreddit": original_subreddit,
                "_reddit_is_cross_post": is_cross_post,
                "_reddit_num_comments": post_data.num_comments,
                "_reddit_header_image_url": header_image_url,
                "_reddit_video_url": video_url,
            }

            articles.append(article)

        return articles

    def _get_original_post_data(self, post_data: RedditPostData) -> RedditPostData:
        """Extract original post data from cross-post if present."""
        if post_data.crosspost_parent_list and len(post_data.crosspost_parent_list) > 0:
            original_post = post_data.crosspost_parent_list[0]
            logger.debug(
                f"Detected cross-post {post_data.id}, using original post {original_post.get('id')}"
            )
            # Return the original post data, preserving the structure
            return RedditPostData(original_post)
        return post_data

    def filter_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Filter articles based on criteria.

        Filters out:
        - AutoModerator posts
        - Posts older than 2 months
        - Posts younger than min_age_hours (to avoid moderator-removed content)
        - Posts with fewer than min_comments (if configured)

        Args:
            articles: List of article dictionaries

        Returns:
            Filtered list of articles
        """
        filtered = []

        # Get options
        min_comments = self.feed.options.get("min_comments", 5)
        min_age_hours = self.feed.options.get("min_age_hours", 48)

        now = timezone.now()
        two_months_ago = now - timedelta(days=60)
        min_age_cutoff = now - timedelta(hours=min_age_hours) if min_age_hours > 0 else None

        for article in articles:
            article_date = article.get("date")

            # Normalize the representation only -- same instant, now comparable
            # and safe for the cutoff comparisons below.
            if article_date and timezone.is_naive(article_date):
                article_date = timezone.make_aware(article_date)
                article["date"] = article_date

            # Skip posts older than 2 months
            if article_date and article_date < two_months_ago:
                logger.debug(f"Skipping old post: {article.get('name')} ({article_date})")
                continue

            # Skip posts that are too recent (not yet past moderation window)
            if min_age_cutoff and article_date and article_date > min_age_cutoff:
                logger.debug(
                    f"Skipping too-recent post (age < {min_age_hours}h): {article.get('name')} ({article_date})"
                )
                continue

            # Skip AutoModerator posts
            if article.get("author") == "AutoModerator":
                logger.debug(f"Skipping AutoModerator post: {article.get('name')}")
                continue

            # Check minimum comment count
            if min_comments > 0:
                num_comments = article.get("_reddit_num_comments", 0)
                if num_comments < min_comments:
                    logger.debug(
                        f"Skipping post with insufficient comments ({num_comments} < {min_comments}): {article.get('name')}"
                    )
                    continue

            filtered.append(article)

        logger.info(f"Filtered articles: kept {len(filtered)}/{len(articles)}")
        return filtered

    def enrich_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Enrich articles with full content (including comments).

        Args:
            articles: List of article dictionaries

        Returns:
            Enriched list of articles
        """
        if not self.feed or not self.feed.user:
            return articles

        user_id = self.feed.user.id

        # Get comment_limit option (default: 10)
        comment_limit = self.feed.options.get("comment_limit", 10)

        enriched = []

        for article in articles:
            try:
                post_data_dict = article.get("_reddit_post_data", {})
                post_data = RedditPostData(post_data_dict)
                subreddit = article.get("_reddit_subreddit", "")
                is_cross_post = article.get("_reddit_is_cross_post", False)

                # Build post content with comments
                content = build_post_content(
                    post_data,
                    comment_limit,
                    subreddit,
                    user_id,
                    is_cross_post,
                )

                article["raw_content"] = content
                article["content"] = content

            except ArticleSkipError:
                # Skip this article if comments fetch failed with 4xx
                logger.warning(f"Skipping article due to error: {article.get('name')}")
                continue
            except Exception as e:
                logger.error(f"Error enriching article {article.get('name')}: {e}")
                # Continue with empty content rather than failing entire aggregation
                article["raw_content"] = ""
                article["content"] = ""

            enriched.append(article)

        return enriched

    def process_content(self, content: str, article: Dict[str, Any]) -> str:
        """
        Process and format Reddit content.
        Uses header_image_only=True to avoid redundant title/meta header.
        """
        # Check if we should include header image
        include_header_image = self.feed.options.get("include_header_image", True)

        header_image_url = None
        header_caption_html = None

        if include_header_image:
            # Get header image URL from article dict if available
            header_image_url = article.get("header_image_url")

            # Fallback to header_data if available (e.g. during article reloads)
            if not header_image_url and article.get("header_data"):
                header_data = article["header_data"]
                header_image_url = getattr(header_data, "base64_data_uri", None) or getattr(
                    header_data, "image_url", None
                )

            # Check for video URL to display in header
            # Only show "View Video" link if header is NOT a YouTube embed (would be redundant)
            video_url = article.get("_reddit_video_url")
            is_youtube_embed = header_image_url and extract_youtube_video_id(header_image_url)
            if video_url and not is_youtube_embed:
                header_caption_html = f'<p><a href="{video_url}">▶ View Video</a></p>'

        return format_article_content(
            content=content,
            title=article["name"],
            url=article["identifier"],
            header_image_url=header_image_url,
            header_caption_html=header_caption_html,
        )

    def finalize_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Final processing before returning articles.

        Processes content with Reddit-specific formatting.

        Args:
            articles: List of article dictionaries

        Returns:
            Finalized list of articles
        """
        # Apply AI processing first
        articles = self._apply_ai_processing(articles)

        finalized = []

        for article in articles:
            # Move header image URL to a standard field for process_content
            header_image_url = article.get("_reddit_header_image_url")

            # Check if header is a YouTube or Twitter/X URL (will be embedded, not image)
            is_youtube_header = header_image_url and extract_youtube_video_id(header_image_url)
            is_twitter_header = header_image_url and is_twitter_url(header_image_url)

            # Strip duplicate image from content before inlining header image
            if header_image_url and article.get("content"):
                article["content"] = self._strip_image_from_content(
                    article["content"], header_image_url
                )

            # Strip YouTube link from content if it's being embedded in header
            if is_youtube_header and header_image_url and article.get("content"):
                article["content"] = self._strip_youtube_link_from_content(
                    article["content"], header_image_url
                )

            if header_image_url:
                # Skip image fetching for YouTube/Twitter URLs (they'll be embedded)
                if is_youtube_header or is_twitter_header:
                    article["header_image_url"] = header_image_url
                else:
                    # Fetch and inline header image (user requirement: base64 encoded)
                    try:
                        # Check if it's already a Data URI or a regular URL
                        if header_image_url.startswith("http"):
                            image_data_result = fetch_single_image(header_image_url)
                            if image_data_result:
                                # Compress and encode
                                encoded = compress_and_encode_image(
                                    image_data_result["imageData"],
                                    image_data_result["contentType"],
                                    is_header=True,
                                )
                                if encoded:
                                    header_image_url = encoded["dataUri"]
                    except Exception as e:
                        logger.warning(
                            f"Failed to inline header image for {article.get('name')}: {e}"
                        )
                        # Fallback to original URL if fetching/encoding fails

                    article["header_image_url"] = header_image_url

            # Process content with formatting
            content = article.get("content", "")
            if content:
                article["content"] = self.process_content(content, article)

            # Clean up internal Reddit-specific fields
            article.pop("_reddit_post_data", None)
            article.pop("_reddit_subreddit", None)
            article.pop("_reddit_is_cross_post", None)
            article.pop("_reddit_num_comments", None)
            article.pop("_reddit_header_image_url", None)
            article.pop("header_image_url", None)

            finalized.append(article)

        return finalized

    def _strip_image_from_content(self, content: str, image_url: str) -> str:
        """
        Strip image from content if it matches the header image.

        Args:
            content: HTML content
            image_url: Header image URL

        Returns:
            Modified HTML content
        """
        if not content or not image_url:
            return content

        try:
            soup = BeautifulSoup(content, "html.parser")
            header_parsed = urlparse(image_url)
            # Compare base paths (ignore query params)
            header_base = header_parsed.path

            modified = False
            for img in soup.find_all("img"):
                src = img.get("src")
                if not src or not isinstance(src, str):
                    continue

                src_parsed = urlparse(src)
                if src_parsed.path == header_base:
                    # Found duplicate image, remove it
                    parent = img.parent
                    img.decompose()
                    modified = True

                    # Check if parent is now empty (e.g. <p> or <div> wrapper)
                    if (
                        parent
                        and parent.name in ["p", "div", "figure"]
                        and not parent.get_text(strip=True)
                        and not parent.find_all(["img", "iframe", "video", "a"])
                    ):
                        parent.decompose()

            return str(soup) if modified else content

        except Exception as e:
            logger.warning(f"Error stripping image from content: {e}")
            return content

    def _strip_youtube_link_from_content(self, content: str, youtube_url: str) -> str:
        """
        Strip YouTube link from content when it's being embedded in the header.

        Removes the "View Video on YouTube" link that would be redundant
        when the video is embedded in the header.

        Args:
            content: HTML content
            youtube_url: YouTube URL being embedded in header

        Returns:
            Modified HTML content
        """
        if not content or not youtube_url:
            return content

        try:
            soup = BeautifulSoup(content, "html.parser")
            youtube_video_id = extract_youtube_video_id(youtube_url)
            if not youtube_video_id:
                return content

            modified = False
            for link in soup.find_all("a"):
                href = link.get("href")
                if not href or not isinstance(href, str):
                    continue

                # Check if this link points to the same YouTube video
                link_video_id = extract_youtube_video_id(href)
                if link_video_id == youtube_video_id:
                    # Found duplicate YouTube link, remove it
                    parent = link.parent
                    link.decompose()
                    modified = True

                    # Check if parent is now empty (e.g. <p> wrapper)
                    if (
                        parent
                        and parent.name in ["p", "div"]
                        and not parent.get_text(strip=True)
                        and not parent.find_all(["img", "iframe", "video", "a"])
                    ):
                        parent.decompose()

            return str(soup) if modified else content

        except Exception as e:
            logger.warning(f"Error stripping YouTube link from content: {e}")
            return content

    def fetch_article_content(self, url: str) -> str:
        """
        Fetch article content from URL.

        Override to fetch Reddit posts via API (including comments) instead of web scraping.
        Always uses API - never falls back to web scraping.

        Args:
            url: Reddit post URL

        Returns:
            HTML content string

        Raises:
            ValueError: If URL is invalid or post cannot be fetched
        """
        if not self.feed or not self.feed.user:
            raise ValueError("Feed not initialized or missing user")

        post_info = extract_post_info_from_url(url)
        subreddit = post_info.get("subreddit")
        post_id = post_info.get("post_id")

        if not subreddit or not post_id:
            raise ValueError(
                f"Invalid Reddit URL format: {url}. Expected format: /r/{{subreddit}}/comments/{{postId}}/..."
            )

        user_id = self.feed.user.id

        post_data = fetch_reddit_post(subreddit, post_id, user_id)
        if not post_data:
            raise ValueError(f"Failed to fetch Reddit post {post_id} from r/{subreddit} via API")

        # Handle cross-posts
        is_cross_post = False
        effective_subreddit = subreddit

        if post_data.crosspost_parent_list and len(post_data.crosspost_parent_list) > 0:
            original_post = post_data.crosspost_parent_list[0]
            is_cross_post = True
            effective_subreddit = original_post.get("subreddit", subreddit)
            post_data = RedditPostData(original_post)

        # Get comment_limit option (default: 10)
        comment_limit = 10

        content = build_post_content(
            post_data,
            comment_limit,
            effective_subreddit,
            user_id,
            is_cross_post,
        )

        return content
