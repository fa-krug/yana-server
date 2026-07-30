"""Podcast RSS aggregator implementation."""

import re
from typing import Any, Dict, List, Optional, Tuple

from bs4 import BeautifulSoup

from ..rss import RssAggregator
from ..utils import clean_html, format_article_content, sanitize_class_names


class PodcastAggregator(RssAggregator):
    """Aggregator for podcast RSS feeds."""

    def __init__(self, feed):
        super().__init__(feed)

    @classmethod
    def get_identifier_choices(
        cls, query: Optional[str] = None, user: Optional[Any] = None
    ) -> List[Tuple[str, str]]:
        # Generic podcast aggregator, no predefined choices
        return []

    @classmethod
    def get_default_identifier(cls) -> str:
        return ""

    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """Get Podcast configuration fields."""
        from django import forms

        return {
            "include_player": forms.BooleanField(
                initial=True,
                label="Include Audio Player",
                help_text="Include an HTML5 audio player in the article.",
                required=False,
            ),
            "include_download_link": forms.BooleanField(
                initial=True,
                label="Include Download Link",
                help_text="Include a direct download link for the audio file.",
                required=False,
            ),
            "artwork_size": forms.IntegerField(
                initial=300,
                label="Artwork Max Width",
                help_text="Maximum width of the podcast artwork in pixels.",
                required=False,
                min_value=50,
                max_value=1000,
            ),
        }

    def parse_to_raw_articles(self, source_data: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Parse RSS feed items, extracting podcast-specific metadata."""
        articles = []
        entries = source_data.get("entries", [])
        limit = self.get_current_run_limit()

        for entry in entries[:limit]:
            # Extract audio enclosure
            media_url = ""
            media_type = "audio/mpeg"
            enclosures = entry.get("enclosures", [])
            if enclosures:
                for enc in enclosures:
                    url = enc.get("url")
                    mtype = enc.get("type", "")
                    if mtype.startswith("audio/") or any(
                        url.lower().endswith(ext)
                        for url in [url]
                        if url
                        for ext in [".mp3", ".m4a", ".ogg", ".opus", ".wav"]
                    ):
                        media_url = url
                        media_type = mtype or "audio/mpeg"
                        break

            # Skip episodes without audio
            if not media_url:
                continue

            # Extract duration
            duration = None
            duration_str = (
                entry.get("itunes_duration")
                or entry.get("itunes:duration")
                or entry.get("duration")
            )
            if duration_str:
                duration = self._parse_duration_to_seconds(str(duration_str))

            # Extract image
            image_url = ""
            itunes_image = entry.get("itunes_image")
            if itunes_image:
                if isinstance(itunes_image, dict):
                    image_url = itunes_image.get("href") or itunes_image.get("url") or ""
                else:
                    image_url = str(itunes_image)

            if not image_url:
                media_thumbnail = entry.get("media_thumbnail")
                if (
                    media_thumbnail
                    and isinstance(media_thumbnail, list)
                    and len(media_thumbnail) > 0
                ):
                    image_url = media_thumbnail[0].get("url") or ""

            article = {
                "name": entry.get("title", "Untitled"),
                "identifier": entry.get("link", ""),
                "raw_content": entry.get("summary", ""),
                "content": entry.get("summary", ""),
                "date": self._parse_date(entry.get("published")),
                "author": entry.get("author", ""),
                "icon": None,
                # Private fields for enrichment
                "_media_url": media_url,
                "_media_type": media_type,
                "_duration": duration,
                "_image_url": image_url,
            }
            articles.append(article)

        return articles

    def enrich_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Build HTML content with embedded audio player."""
        enriched = []

        # Get options
        include_player = self.feed.options.get("include_player", True)
        include_download_link = self.feed.options.get("include_download_link", True)
        artwork_size = self.feed.options.get("artwork_size", 300)

        for article in articles:
            media_url = article.get("_media_url")
            if not media_url:
                enriched.append(article)
                continue

            html_parts = []

            # Artwork
            image_url = article.get("_image_url")
            if image_url:
                html_parts.append(
                    f'<div data-sanitized-class="podcast-artwork" style="margin-bottom: 1em;">'
                    f'<img src="{image_url}" alt="Episode artwork" style="max-width: {artwork_size}px; height: auto; border-radius: 8px;">'
                    f"</div>"
                )

            # Player
            if include_player:
                media_type = article.get("_media_type", "audio/mpeg")
                html_parts.append(
                    f'<div data-sanitized-class="podcast-player" style="margin-bottom: 1em;">'
                    f'<audio controls preload="metadata" style="width: 100%;">'
                    f'<source src="{media_url}" type="{media_type}">'
                    f"Your browser does not support the audio element."
                    f"</audio>"
                )

            # Duration and Download
            meta_parts = []
            duration = article.get("_duration")
            if duration:
                meta_parts.append(
                    f'<span data-sanitized-class="podcast-duration">Duration: {self._format_duration(duration)}</span>'
                )

            if include_download_link:
                meta_parts.append(
                    f'<a href="{media_url}" data-sanitized-class="podcast-download" download>Download Episode</a>'
                )

            if (include_player or include_download_link) and meta_parts:
                html_parts.append(
                    f'<div style="margin-top: 0.5em; font-size: 0.9em; color: #666;">'
                    f"{' | '.join(meta_parts)}"
                    f"</div>"
                )

            if include_player:
                html_parts.append("</div>")

            # Description
            description = article.get("content", "")
            if description:
                html_parts.append('<div data-sanitized-class="podcast-description">')
                html_parts.append("<h4>Show Notes</h4>")
                html_parts.append(description)
                html_parts.append("</div>")

            # Final content processing
            combined_html = "\n".join(html_parts)
            article["content"] = self.process_content(combined_html, article)
            enriched.append(article)

        return enriched

    def process_content(self, html: str, article: Dict[str, Any]) -> str:
        """Process and format podcast content."""
        if not html:
            return ""

        # Parse HTML
        soup = BeautifulSoup(html, "html.parser")

        # Sanitize class names
        sanitize_class_names(soup)

        # Clean HTML
        cleaned = clean_html(str(soup))

        # Wrap content (artwork is handled in enrich_articles)
        formatted = format_article_content(
            cleaned,
            title=article["name"],
            url=article["identifier"],
        )

        return formatted

    def _parse_duration_to_seconds(self, duration_str: str) -> Optional[int]:
        """Parse duration string (HH:MM:SS, MM:SS, or seconds) to integer seconds."""
        if not duration_str:
            return None

        duration_str = duration_str.strip()

        # Seconds only
        if re.match(r"^\d+$", duration_str):
            return int(duration_str)

        # HH:MM:SS or MM:SS
        parts = duration_str.split(":")
        try:
            if len(parts) == 3:
                return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
            elif len(parts) == 2:
                return int(parts[0]) * 60 + int(parts[1])
        except (ValueError, IndexError):
            pass

        return None

    def _format_duration(self, seconds: int) -> str:
        """Format seconds to H:MM:SS or M:SS."""
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        secs = seconds % 60

        if hours > 0:
            return f"{hours}:{minutes:02d}:{secs:02d}"
        return f"{minutes}:{secs:02d}"
