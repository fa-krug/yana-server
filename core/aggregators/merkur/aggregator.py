"""Merkur aggregator implementation."""

from typing import Any, Dict, List, Optional, Tuple

from bs4 import BeautifulSoup

from ..utils import (
    extract_main_content,
    remove_empty_elements,
    remove_sanitized_attributes,
    sanitize_html_attributes,
)
from ..utils.youtube import proxy_youtube_embeds
from ..website import FullWebsiteAggregator


class MerkurAggregator(FullWebsiteAggregator):
    """Specialized aggregator for Merkur.de (German news)."""

    MERKUR_URL = "https://www.merkur.de"

    def __init__(self, feed):
        super().__init__(feed)
        # Use Merkur main RSS feed if identifier is not set
        if not self.identifier or self.identifier == "":
            self.identifier = "https://www.merkur.de/rssfeed.rdf"

    def get_source_url(self) -> str:
        """Return the Merkur website URL."""
        return self.MERKUR_URL

    @classmethod
    def get_identifier_choices(
        cls, query: Optional[str] = None, user: Optional[Any] = None
    ) -> List[Tuple[str, str]]:
        """Get available Merkur RSS feed choices."""
        return [
            ("https://www.merkur.de/rssfeed.rdf", "Main Feed"),
            (
                "https://www.merkur.de/lokales/garmisch-partenkirchen/rssfeed.rdf",
                "Garmisch-Partenkirchen",
            ),
            ("https://www.merkur.de/lokales/wuermtal/rssfeed.rdf", "Würmtal"),
            ("https://www.merkur.de/lokales/starnberg/rssfeed.rdf", "Starnberg"),
            (
                "https://www.merkur.de/lokales/fuerstenfeldbruck/rssfeed.rdf",
                "Fürstenfeldbruck",
            ),
            ("https://www.merkur.de/lokales/dachau/rssfeed.rdf", "Dachau"),
            ("https://www.merkur.de/lokales/freising/rssfeed.rdf", "Freising"),
            ("https://www.merkur.de/lokales/erding/rssfeed.rdf", "Erding"),
            ("https://www.merkur.de/lokales/ebersberg/rssfeed.rdf", "Ebersberg"),
            ("https://www.merkur.de/lokales/muenchen/rssfeed.rdf", "München"),
            (
                "https://www.merkur.de/lokales/muenchen-lk/rssfeed.rdf",
                "München Landkreis",
            ),
            ("https://www.merkur.de/lokales/holzkirchen/rssfeed.rdf", "Holzkirchen"),
            ("https://www.merkur.de/lokales/miesbach/rssfeed.rdf", "Miesbach"),
            (
                "https://www.merkur.de/lokales/region-tegernsee/rssfeed.rdf",
                "Region Tegernsee",
            ),
            ("https://www.merkur.de/lokales/bad-toelz/rssfeed.rdf", "Bad Tölz"),
            (
                "https://www.merkur.de/lokales/wolfratshausen/rssfeed.rdf",
                "Wolfratshausen",
            ),
            ("https://www.merkur.de/lokales/weilheim/rssfeed.rdf", "Weilheim"),
            ("https://www.merkur.de/lokales/schongau/rssfeed.rdf", "Schongau"),
        ]

    @classmethod
    def get_default_identifier(cls) -> str:
        """Get default Merkur identifier."""
        return "https://www.merkur.de/rssfeed.rdf"

    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """Get Merkur configuration fields."""
        from django import forms

        return {
            "remove_empty_elements": forms.BooleanField(
                initial=True,
                label="Remove Empty Elements",
                help_text="Cleanup empty paragraphs and divs from the article content.",
                required=False,
            ),
        }

    # Body lives in one known container -- keep the first match, never union.
    uses_first_content_match = True

    # Merkur specific selectors
    content_selectors = [".idjs-Story"]

    selectors_to_remove = [
        ".id-DonaldBreadcrumb--default",
        ".id-StoryElement-headline",
        ".id-StoryElement-image",
        ".lp_west_printAction",
        ".lp_west_webshareAction",
        ".id-Recommendation",
        ".enclosure",
        ".id-Story-timestamp",
        ".id-Story-authors",
        ".id-Story-interactionBar",
        # Standalone "Uns auf Google/YouTube folgen" anchors that leak into the
        # story flow outside the interaction bar. The class name varies per
        # network, so match the shared suffix instead of enumerating each.
        "[class*='FollowButton']",
        ".id-Comments",
        ".id-ClsPrevention",
        "egy-discussion",
        "figcaption",
        "script",
        "style",
        "iframe:not([src*='youtube.com']):not([src*='youtu.be'])",
        "noscript",
        "svg",
        ".id-StoryElement-intestitialLink",
        ".id-StoryElement-embed--fanq",
    ]

    def extract_content(self, html: str, article: Dict[str, Any]) -> str:
        """
        Extract content using .idjs-Story selector with fallback.

        Args:
            html: Full HTML document
            article: Article dictionary

        Returns:
            Extracted HTML content
        """
        self.logger.debug(
            f"[extract_content] Extracting content from .idjs-Story element for {article.get('identifier')}"
        )

        # Try to extract using .idjs-Story selector
        extracted = extract_main_content(
            html,
            content_selectors=self.get_content_selectors(),
            remove_selectors=self.get_ignore_selectors(),
            first_match_only=self.uses_first_content_match,
        )

        if not extracted or extracted.strip() == "":
            self.logger.warning(
                f"[extract_content] Could not find .idjs-Story content, using base extraction for {article.get('identifier')}"
            )
            # Fallback to base extraction
            return super().extract_content(html, article)

        self.logger.debug(
            f"[extract_content] Content extracted from .idjs-Story for {article.get('identifier')}"
        )
        return extracted

    def process_content(self, html: str, article: Dict[str, Any]) -> str:
        """
        Process Merkur content with custom cleanup.
        """
        self.logger.debug(
            f"[process_content] Processing Merkur content with custom cleanup for {article.get('identifier')}"
        )

        # Get options
        remove_empty = self.feed.options.get("remove_empty_elements", True)

        # Parse HTML
        soup = BeautifulSoup(html, "html.parser")

        # Step 1: Remove empty elements (p, div, span) that have no text and no images
        if remove_empty:
            remove_empty_elements(soup, tags=["p", "div", "span"])

        # Proxy YouTube embeds (before sanitization)
        proxy_youtube_embeds(soup)

        # Step 2: Sanitize HTML (create data-sanitized-* attributes)
        # This removes scripts, converts class/style/id to data-sanitized-* format
        sanitize_html_attributes(soup)

        # Step 3: Remove all data-sanitized-* attributes after sanitization
        # This is Merkur-specific behavior (legacy cleanup)
        remove_sanitized_attributes(soup)

        # Convert back to HTML string
        content = str(soup)

        # Step 4: Use base process_content for final formatting
        # This handles header image extraction, content formatting, etc.
        result = super().process_content(content, article)

        self.logger.debug(
            f"[process_content] Merkur content processed for {article.get('identifier')}"
        )
        return result
