"""Base aggregator class for implementing feed providers."""

import contextlib
import json
import logging
import math
import re
import time
from abc import ABC, abstractmethod
from datetime import timedelta
from typing import Any, Dict, List, Optional

from django.utils import timezone

from bs4 import BeautifulSoup

from core.ai_client import AIClient
from core.models import UserSettings

from .services.header_element.context import HeaderElementData


class BaseAggregator(ABC):
    """Base class for all aggregators using Template Method pattern."""

    # The model field name used for identifier input (e.g. "identifier", "reddit_subreddit")
    identifier_field = "identifier"

    # Set to True if the aggregator implements dynamic identifier search
    # (i.e. uses the query parameter in get_identifier_choices)
    supports_identifier_search = False

    @classmethod
    def resolves_feed_url(cls) -> bool:
        """Whether a pasted identifier should be normalized and resolved.

        True only for free-form URL types (full_website, feed_content, podcast).
        Managed feeds pick their identifier from fixed ``identifier_choices``, and
        the non-URL kinds hold a subreddit name or a channel id -- normalizing
        ``swift`` into ``https://swift`` would be a real bug. Override per
        aggregator when the default reads the wrong way.
        """
        if cls.identifier_field != "identifier":
            return False
        return not cls.get_identifier_choices()

    # Fixed-brand scrapers point at their own site so the logo comes from the
    # brand's favicon rather than whichever feed URL the identifier happens to
    # be. None for free-form URL types (the identifier's origin is used) and for
    # reddit/youtube (their API provides an image).
    brand_site_url: Optional[str] = None

    def logo_image_url(self) -> Optional[str]:
        """API-provided logo image URL, when the source has one.

        Overridden by aggregators whose API exposes an avatar or icon (Reddit
        subreddit icon, YouTube channel avatar). Returning None means "fall
        through to the favicon tiers".
        """
        return None

    # Scrapers whose body lives in one known container set this True: extraction
    # then keeps only the first match instead of unioning every match.
    uses_first_content_match = False

    def __init__(self, feed):
        """
        Initialize aggregator with a feed.

        Args:
            feed: Feed model instance
        """
        self.feed = feed
        self.identifier = feed.identifier
        self.daily_limit = feed.daily_limit
        self.logger = logging.getLogger(f"aggregator.{self.get_aggregator_type()}")

    @classmethod
    def get_identifier_from_related(cls, related_obj: Any) -> str:
        """
        Extract the identifier string from a related model object.
        Default implementation returns str(related_obj).
        """
        return str(related_obj)

    @abstractmethod
    def aggregate(self) -> List[Dict[str, Any]]:
        """
        Fetch and aggregate articles from the feed.

        Returns:
            List of article dictionaries with keys:
                - name: Article title
                - identifier: URL or external ID
                - raw_content: Raw HTML content
                - content: Processed content
                - date: Publication date
                - author: Article author (optional)
                - icon: Article icon URL (optional)
        """
        pass

    def validate(self) -> None:
        """
        Validate feed configuration.

        Override for custom validation.
        Raises ValueError if validation fails.
        """
        if not self.identifier:
            raise ValueError("Feed identifier is required")

    def normalize_identifier(self, identifier: str) -> str:
        """
        Normalize an identifier before saving.

        Checks if the identifier matches a label in get_identifier_choices()
        and returns the corresponding value if so. Otherwise returns stripped.

        Args:
            identifier: Raw identifier string

        Returns:
            Normalized identifier string
        """
        normalized = identifier.strip()

        # If the identifier matches a label in our choices, use the value instead
        # We call it with default args since we don't have request context here
        choices = self.get_identifier_choices()
        for value, label in choices:
            if normalized == label:
                return str(value)

        return normalized

    def get_identifier_label(self, identifier: str) -> str:
        """
        Get a nice display label for an identifier.

        Checks get_identifier_choices() for a matching value and returns its label.

        Args:
            identifier: Clean identifier

        Returns:
            Display label string
        """
        choices = self.get_identifier_choices()
        for value, label in choices:
            if str(identifier) == str(value):
                return str(label)

        return identifier

    def get_collected_today_count(self) -> int:
        """Get the number of articles collected today for this feed."""
        if not self.feed:
            return 0
        from core.models import Article

        today = timezone.now().replace(hour=0, minute=0, second=0, microsecond=0)
        return Article.objects.filter(feed=self.feed, created_at__gte=today).count()

    def get_current_run_limit(self) -> int:
        """
        Calculate the article limit for the current run based on daily limit,
        already collected count, and time of day.

        Logic:
        1. Calculate target quota for the current time of day (linear progression).
        2. In the morning, we allow collecting more to fill the quota.
        3. The more is left to reach the daily limit, the more we allow to collect in this run.
        """
        collected = self.get_collected_today_count()
        if collected >= self.daily_limit:
            self.logger.info(
                f"Daily limit of {self.daily_limit} reached ({collected} collected today)."
            )
            return 0

        now = timezone.now()
        start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
        seconds_since_start = (now - start_of_day).total_seconds()
        total_seconds_in_day = 24 * 3600

        # Linear target quota based on time of day
        # e.g. at 12:00 (midday), target is 50% of daily limit
        # Use ceil to ensure we can reach the full limit by end of day even for small limits
        target_quota = math.ceil(self.daily_limit * (seconds_since_start / total_seconds_in_day))

        # Ensure we always allow at least a minimum catch-up if we are behind target
        # or if it's very early in the morning.
        remaining_total = self.daily_limit - collected

        # "The more left, the more it should collect"
        # We calculate a run limit that tries to bridge the gap but doesn't necessarily
        # take everything at once unless we are far behind.
        gap_to_target = max(0, target_quota - collected)

        # Base allowance: at least some articles even if we are on target
        base_allowance = max(1, int(self.daily_limit / 48))

        # Proportional allowance: the more is left, the more we collect (e.g. 20% of remaining)
        proportional_allowance = int(remaining_total * 0.2)

        run_limit = max(base_allowance, gap_to_target, proportional_allowance)

        # In the morning (e.g. before 10 AM), we are more aggressive (e.g. 40% of remaining)
        if now.hour < 10:
            run_limit = max(run_limit, int(remaining_total * 0.4))

        run_limit = min(run_limit, remaining_total)

        self.logger.info(
            f"Adaptive Daily Limit: {collected}/{self.daily_limit} collected today. "
            f"Target at {now.strftime('%H:%M')}: {target_quota}. "
            f"Run limit: {run_limit}"
        )
        return run_limit

    @abstractmethod
    def fetch_source_data(self, limit: Optional[int] = None) -> Any:
        """
        Fetch raw source data (RSS feed, API, etc.).

        Must be implemented by subclasses.

        Args:
            limit: Optional limit on number of items to fetch

        Returns:
            Raw source data in implementation-specific format
        """
        pass

    @abstractmethod
    def parse_to_raw_articles(self, source_data: Any) -> List[Dict[str, Any]]:
        """
        Parse source data to raw article dictionaries.

        Must be implemented by subclasses.

        Args:
            source_data: Raw source data from fetch_source_data()

        Returns:
            List of article dictionaries with basic fields populated
        """
        pass

    def filter_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Filter articles based on criteria.

        Default implementation drops articles older than 60 days. The article
        date is the real publish time and is never rewritten -- naive datetimes
        are only made timezone-aware, which preserves the instant. Anything that
        needs append-only ordering must use Article.created_at.

        Args:
            articles: List of article dictionaries

        Returns:
            Filtered list of articles
        """
        self.logger.debug("[filter_articles] Starting age check filter")
        cutoff_date = timezone.now() - timedelta(days=60)
        filtered = []

        for article in articles:
            article_date = article.get("date")

            # Normalize the representation only -- same instant, now comparable.
            if article_date and timezone.is_naive(article_date):
                article_date = timezone.make_aware(article_date)
                article["date"] = article_date

            if article_date and article_date < cutoff_date:
                self.logger.info(
                    f"[filter_articles] Skipping old article: {article.get('name')} ({article_date})"
                )
                continue

            filtered.append(article)
        self.logger.info(f"[filter_articles] Kept {len(filtered)}/{len(articles)} articles")
        return filtered

    def enrich_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Enrich articles with additional data (full content, images, etc.).

        Override for custom enrichment.

        Args:
            articles: List of article dictionaries

        Returns:
            Enriched list of articles
        """
        return articles

    def finalize_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Final processing before returning articles.

        Override for custom finalization.
        Applies AI processing if enabled.

        Args:
            articles: List of article dictionaries

        Returns:
            Finalized list of articles
        """
        return self._apply_ai_processing(articles)

    def _apply_ai_processing(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Apply AI processing to articles if configured.
        """
        # Check if AI is enabled for the feed
        options = self.feed.options or {}
        ai_enabled = any(
            [
                options.get("ai_summarize"),
                options.get("ai_improve_writing"),
                options.get("ai_translate"),
            ]
        )

        if not ai_enabled:
            return articles

        # Check if AI provider is configured for the user
        try:
            user_settings = UserSettings.objects.get(user=self.feed.user)
            if not user_settings.active_ai_provider:
                return articles
        except UserSettings.DoesNotExist:
            return articles

        ai_client = AIClient(user_settings)
        finalized_articles = []
        ai_delay = getattr(user_settings, "ai_request_delay", 2)

        for i, article in enumerate(articles):
            if i > 0 and ai_delay:
                time.sleep(ai_delay)
            try:
                content = article.get("content", "")
                if not content:
                    finalized_articles.append(article)
                    continue

                # Parse HTML and extract sections (removing header/footer/nav)
                soup = BeautifulSoup(content, "html.parser")
                for tag in soup(["header", "footer", "nav", "script", "style"]):
                    tag.decompose()

                # Get clean text for AI (keeping structure if possible, but request implies just sections)
                # However, to maintain formatting, we should probably pass the cleaned HTML body
                clean_html = str(soup)

                prompt_parts = []

                # Instruction to output JSON
                prompt_parts.append(
                    "You are an AI assistant that processes article content. "
                    "You will receive an article title and content in HTML format. "
                    "You must return the result as a JSON object with keys 'title' and 'content'. "
                    "Do not include any markdown formatting (like ```json) in the response, just the raw JSON string."
                )

                if options.get("ai_summarize"):
                    prompt_parts.append("Summarize the article content concisely.")

                if options.get("ai_improve_writing"):
                    prompt_parts.append(
                        "Rewrite the content to improve clarity, flow, and style. "
                        "IMPORTANT: Preserve the complete HTML structure including all tags. "
                        "Keep all links (<a> tags) exactly as they are - do not modify href attributes or remove any links. "
                        "Only improve the text content itself."
                    )

                if options.get("ai_translate"):
                    target_lang = options.get("ai_translate_language", "English")
                    prompt_parts.append(
                        f"Translate the title and content to {target_lang}. "
                        "IMPORTANT: Do NOT translate link labels (the text inside <a> tags). "
                        "Keep link text in the original language. Only translate regular text content."
                    )

                prompt_parts.append(
                    "The input content is HTML with stripped headers/footers. "
                    "CRITICAL: Preserve ALL HTML tags and structure in your output. "
                    "This includes: links (<a>), paragraphs (<p>), headings (<h1>-<h6>), lists (<ul>, <ol>, <li>), "
                    "images (<img>), divs, spans, and all other HTML elements. "
                    "Your output 'content' field must be valid HTML with the exact same structure as the input."
                )

                # Prepare input
                input_data = {"title": article.get("name", ""), "content": clean_html}

                full_prompt = "\n".join(prompt_parts) + "\n\nInput Data:\n" + json.dumps(input_data)

                # Schema for JSON mode (using uppercase types for Gemini responseSchema)
                json_schema = {
                    "type": "OBJECT",
                    "properties": {
                        "title": {"type": "STRING"},
                        "content": {"type": "STRING"},
                    },
                    "required": ["title", "content"],
                }

                self.logger.info(
                    f"Sending article '{article.get('name')}' to AI ({user_settings.active_ai_provider})"
                )
                result = ai_client.generate_response(
                    full_prompt, json_mode=True, json_schema=json_schema
                )

                if result:
                    # Robust JSON extraction
                    parsed_result = None
                    try:
                        parsed_result = json.loads(result)
                    except json.JSONDecodeError:
                        # Try to find JSON block in the response
                        # Look for ```json ... ``` or just { ... }
                        match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", result, re.DOTALL)
                        if match:
                            with contextlib.suppress(json.JSONDecodeError):
                                parsed_result = json.loads(match.group(1))

                        if not parsed_result:
                            # Try to find the first '{' and last '}'
                            start = result.find("{")
                            end = result.rfind("}")
                            if start != -1 and end != -1:
                                with contextlib.suppress(json.JSONDecodeError):
                                    parsed_result = json.loads(result[start : end + 1])

                    if parsed_result:
                        if "title" in parsed_result:
                            article["name"] = parsed_result["title"]
                        if "content" in parsed_result:
                            article["content"] = parsed_result["content"]
                        finalized_articles.append(article)
                    else:
                        self.logger.error(
                            f"AI returned invalid JSON for article '{article.get('name')}': {result[:100]}..."
                        )
                        # Skip article on error
                        continue
                else:
                    self.logger.warning(
                        f"AI processing failed for article '{article.get('name')}'. Skipping."
                    )

            except Exception as e:
                self.logger.error(
                    f"Error during AI processing for article '{article.get('name')}': {e}"
                )
                # Skip article on error as requested
                continue

        return finalized_articles

    def get_aggregator_type(self) -> str:
        """Get the aggregator type name."""
        return self.__class__.__name__.replace("Aggregator", "").lower()

    def get_source_url(self) -> str:
        """
        Get the source URL for this feed.

        This returns the feed's canonical website URL -- the human-facing page
        a reader would open, as opposed to the feed identifier the aggregator
        fetches from. Subclasses override it when the two differ.

        Override this method in subclasses to provide aggregator-specific URLs.
        Default implementation returns the feed identifier.

        Returns:
            Source URL as string, or empty string if not available
        """
        return self.identifier or ""

    @classmethod
    def get_identifier_choices(
        cls, query: Optional[str] = None, user: Optional[Any] = None
    ) -> List[tuple]:
        """
        Get available identifier choices for this aggregator.

        Returns a list of (value, label) tuples for identifier autocomplete.
        Aggregators can override this to provide predefined identifier options.

        Args:
            query: Optional search query string
            user: Optional user object (for authenticated APIs)

        Returns:
            List of (identifier_value, display_label) tuples
            Empty list if no predefined choices available

        Example:
            [
                ("https://www.merkur.de/rssfeed.rdf", "Main Feed"),
                ("https://www.merkur.de/lokales/muenchen/rssfeed.rdf", "München"),
            ]
        """
        return []

    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """
        Get configuration fields for this aggregator.
        """
        return {}

    def save_options(self, form_cleaned_data: Dict[str, Any]) -> None:
        """
        Extract aggregator-specific options from form data and save to feed.options.
        """
        config_fields = self.get_configuration_fields()
        options = self.feed.options or {}
        for field_name in config_fields:
            if field_name not in form_cleaned_data:
                continue
            value = form_cleaned_data[field_name]
            if value is None:
                # Blank input means "use the default" -- drop the key entirely.
                options.pop(field_name, None)
            else:
                options[field_name] = value
        self.feed.options = options

    @classmethod
    def get_default_identifier(cls) -> str:
        """
        Get the default identifier for this aggregator.

        Some aggregators set a default identifier in __init__, but that requires
        a feed instance. This class method allows getting the default without
        instantiation, useful for autocomplete pre-population.

        Returns:
            Default identifier string, or empty string if none
        """
        return ""

    def extract_header_element(self, article: Dict[str, Any]) -> Optional[HeaderElementData]:
        """
        Extract header element (image/video converted to image data) for an article.

        Uses the HeaderElementExtractor to attempt to extract a header element
        from the article URL. Returns HeaderElementData or None if extraction fails.

        This method bridges async extraction with the synchronous aggregator pipeline.

        Args:
            article: Article dictionary with 'identifier' and 'name' keys

        Returns:
            HeaderElementData containing raw bytes and the stored image's hash, or None if
            extraction fails

        Raises:
            ArticleSkipError: On 4xx HTTP errors (article should be skipped)
        """
        from .exceptions import ArticleSkipError
        from .services.header_element import HeaderElementExtractor

        try:
            url = article.get("identifier")
            alt = article.get("name", "Article image")

            if not url:
                self.logger.warning("extract_header_element: Missing article URL")
                return None

            # Run extraction synchronously
            extractor = HeaderElementExtractor()
            user_id = getattr(getattr(self.feed, "user", None), "id", None)
            header_data = extractor.extract_header_element(url, alt, user_id=user_id)

            return header_data

        except ArticleSkipError:
            # Re-raise ArticleSkipError to be handled by caller
            raise
        except Exception as e:
            self.logger.error(f"extract_header_element: Unexpected error - {e}")
            return None

    def fetch_article_content(self, url: str) -> str:
        """
        Fetch HTML content from URL.

        Base implementation returns empty string.
        Override in subclasses (e.g. FullWebsiteAggregator) to fetch actual HTML.
        """
        return ""

    def extract_content(self, html: str, article: Dict[str, Any]) -> str:
        """
        Extract main content from HTML.

        Base implementation returns original HTML.
        Override in subclasses to extract specific elements.
        """
        return html

    def process_content(self, content: str, article: Dict[str, Any]) -> str:
        """
        Process and format content.

        Base implementation returns original content.
        Override in subclasses to clean/format HTML.
        """
        return content
