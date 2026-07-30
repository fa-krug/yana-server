"""Oglaf aggregator implementation."""

import logging
from typing import Any, Dict, Optional

from bs4 import BeautifulSoup, Tag

from ..services.image_store import store_image_ref_from_url
from ..utils import format_article_content, get_attr_str
from ..website import FullWebsiteAggregator

logger = logging.getLogger(__name__)


class OglafAggregator(FullWebsiteAggregator):
    """
    Aggregator for Oglaf webcomic.

    Ported from legacy TypeScript implementation.
    Handles extraction of the comic image, which is stored in the shared image
    store and referenced by hash.
    """

    brand_site_url = "https://www.oglaf.com/"

    def __init__(self, feed):
        super().__init__(feed)
        # Set default identifier if not provided
        if not self.identifier:
            self.identifier = "https://www.oglaf.com/feeds/rss/"

    @classmethod
    def get_default_identifier(cls) -> str:
        """Get default Oglaf identifier."""
        return "https://www.oglaf.com/feeds/rss/"

    @classmethod
    def resolves_feed_url(cls) -> bool:
        """Fixed-brand scraper: the identifier is its own hardcoded feed URL."""
        return False

    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """Get Oglaf configuration fields."""
        from django import forms

        return {
            "show_alt_text": forms.BooleanField(
                initial=True,
                label="Show Alt Text",
                help_text="Display the comic's 'title' text (often containing a second joke) below the image.",
                required=False,
            ),
        }

    def get_source_url(self) -> str:
        """Return the Oglaf website URL."""
        return "https://www.oglaf.com"

    # Body lives in one known container -- keep the first match, never union.
    uses_first_content_match = True

    # Selectors for main content
    content_selectors = ["div.content"]

    # Selectors to strip from the main content div
    selectors_to_remove = [
        "#nav",
        "#tt",
        ".align",
        "#ll",
        "script",
        "style",
        "div.clear",
        "#ad_btm",
    ]

    def extract_header_element(self, article: Dict[str, Any]) -> Optional[Any]:
        """Disable header element extraction for Oglaf as the comic is the main content."""
        return None

    def process_content(self, html: str, article: Dict[str, Any]) -> str:
        """Process Oglaf content by extracting and storing the comic image."""
        show_alt_text = self.feed.options.get("show_alt_text", True)

        soup = BeautifulSoup(html, "html.parser")

        # Find the comic image
        comic_img = soup.select_one("#strip")
        if not comic_img:
            # Fallback selectors from legacy
            comic_img = soup.select_one(".content img, #content img, .comic img")

        if isinstance(comic_img, Tag):
            img_url = get_attr_str(comic_img, "src")
            # Handle relative URLs
            if img_url.startswith("/"):
                img_url = "https://www.oglaf.com" + img_url
            elif not img_url.startswith("http") and "media.oglaf.com" not in img_url:
                # Handle other relative paths if any (usually media.oglaf.com)
                img_url = "https://media.oglaf.com/comic/" + img_url

            # Extract alt text (Oglaf uses 'title' for the extra joke)
            alt_text = get_attr_str(comic_img, "alt") or "Oglaf comic"
            joke_text = get_attr_str(comic_img, "title")

            # Store the comic once; fall back to the remote URL if that fails.
            img_src = store_image_ref_from_url(img_url) or img_url

            new_html = (
                f'<div style="text-align: center;">'
                f'<img src="{img_src}" alt="{alt_text}" style="max-width: 100%; height: auto;">'
            )

            if show_alt_text and joke_text:
                new_html += (
                    f'<p style="font-style: italic; margin-top: 1em; color: #666;">{joke_text}</p>'
                )

            new_html += "</div>"
        else:
            # If no image found, use the cleaned HTML (from extract_content)
            new_html = html

        # Wrap content (no header image for Oglaf)
        return format_article_content(
            new_html,
            title=article["name"],
            url=article["identifier"],
        )
