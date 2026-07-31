"""Podcast RSS aggregator implementation."""

import html
import re
from typing import Any, Dict, List, Optional, Tuple

from bs4 import BeautifulSoup

from ..rss import RssAggregator
from ..utils import (
    clean_html,
    format_article_content,
    remove_sanitized_attributes,
    sanitize_class_names,
    sanitize_html_attributes,
)
from ..utils.block_parser import is_safe_url


def _safe_url_attr(url: Optional[str]) -> Optional[str]:
    """
    Return ``url`` escaped for an ``href``/``src`` attribute, or ``None`` if
    it is missing or uses an unsafe scheme.

    Every URL here (the RSS enclosure's media URL, the episode artwork URL)
    is attacker-reachable straight from the feed, so it needs both the escape
    (a literal quote would break out of the attribute) and the scheme check
    (a well-formed ``javascript:``/``data:`` URL is an XSS vector escaping
    alone does not fix -- see ``is_safe_url``). Callers skip the image/media
    element entirely, or fall back to bare text for the download link, when
    this returns ``None``.
    """
    if not url:
        return None
    if not is_safe_url(url):
        return None
    return html.escape(url, quote=True)


def _sanitize_show_notes_html(content_html: str) -> str:
    """
    Sanitize a podcast episode's show-notes HTML (the RSS
    ``<description>``/``<summary>`` field) before it is spliced into stored
    article content.

    This is genuine third-party HTML -- show notes routinely carry
    paragraphs, links, and bold/italic markup -- so it can't just be escaped;
    that would turn it into literal, visibly-escaped text. It must be
    sanitized instead. ``clean_html()`` alone is NOT enough here: it only
    strips HTML comments, so a ``<script>``, an ``onerror=`` attribute, or a
    ``javascript:``/``data:`` href or img src would pass through it
    untouched. This layers on ``sanitize_html_attributes()`` (removes
    script/object/embed/style/iframe elements and every ``on*`` attribute)
    plus an explicit ``is_safe_url`` scheme check on every ``href``/``src``,
    matching the pipeline used for third-party HTML elsewhere (e.g.
    ``core/aggregators/heise/aggregator.py``'s ``_sanitize_comment_html``).
    """
    soup = BeautifulSoup(clean_html(content_html), "html.parser")
    sanitize_html_attributes(soup)
    remove_sanitized_attributes(soup)

    for tag in soup.find_all("a"):
        href = tag.get("href")
        if href and not is_safe_url(href):
            del tag["href"]

    for tag in soup.find_all("img"):
        src = tag.get("src")
        if src and not is_safe_url(src):
            tag.decompose()

    return str(soup)


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

            # `media_url` is the RSS enclosure's URL -- attacker-reachable
            # straight from the feed -- and lands in both a `<source src>`
            # and a download `<a href>` below. An unsafe scheme disables the
            # player and falls the download link back to bare text rather
            # than a broken/unsafe anchor (see `_safe_url_attr`).
            safe_media_url = _safe_url_attr(media_url)

            html_parts = []

            # Artwork. Same reasoning as `media_url`: an unsafe image URL is
            # skipped entirely rather than escaped into place.
            safe_image_url = _safe_url_attr(article.get("_image_url"))
            if safe_image_url:
                html_parts.append(
                    f'<div data-sanitized-class="podcast-artwork" style="margin-bottom: 1em;">'
                    f'<img src="{safe_image_url}" alt="Episode artwork" '
                    f'style="max-width: {artwork_size}px; height: auto; border-radius: 8px;">'
                    f"</div>"
                )

            # Player
            player_rendered = include_player and safe_media_url is not None
            if player_rendered:
                media_type = article.get("_media_type", "audio/mpeg")
                html_parts.append(
                    f'<div data-sanitized-class="podcast-player" style="margin-bottom: 1em;">'
                    f'<audio controls preload="metadata" style="width: 100%;">'
                    f'<source src="{safe_media_url}" type="{html.escape(media_type, quote=True)}">'
                    f"Your browser does not support the audio element."
                    f"</audio>"
                )

            # Duration and Download
            meta_parts = []
            duration = article.get("_duration")
            if duration:
                meta_parts.append(
                    f'<span data-sanitized-class="podcast-duration">Duration: '
                    f"{html.escape(self._format_duration(duration), quote=True)}</span>"
                )

            if include_download_link:
                if safe_media_url:
                    meta_parts.append(
                        f'<a href="{safe_media_url}" data-sanitized-class="podcast-download" '
                        f"download>Download Episode</a>"
                    )
                else:
                    meta_parts.append(
                        '<span data-sanitized-class="podcast-download">Download Episode</span>'
                    )

            if (include_player or include_download_link) and meta_parts:
                html_parts.append(
                    f'<div style="margin-top: 0.5em; font-size: 0.9em; color: #666;">'
                    f"{' | '.join(meta_parts)}"
                    f"</div>"
                )

            if player_rendered:
                html_parts.append("</div>")

            # Description (show notes) -- genuine third-party HTML, so it is
            # sanitized rather than escaped (see `_sanitize_show_notes_html`).
            description = article.get("content", "")
            if description:
                html_parts.append('<div data-sanitized-class="podcast-description">')
                html_parts.append("<h4>Show Notes</h4>")
                html_parts.append(_sanitize_show_notes_html(description))
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
