"""Ars Technica aggregator implementation."""

from typing import Any, List, Optional, Tuple

from ..utils import IFRAME_SANITIZE_SELECTOR
from ..website import RssSummaryFallbackAggregator


class ArsTechnicaAggregator(RssSummaryFallbackAggregator):
    """Aggregator for Ars Technica (arstechnica.com) US tech/science news."""

    ARS_TECHNICA_URL = "https://arstechnica.com"
    DEFAULT_FEED = "https://arstechnica.com/feed/"

    def __init__(self, feed):
        super().__init__(feed)
        if not self.identifier or self.identifier == "":
            self.identifier = self.DEFAULT_FEED

    def get_source_url(self) -> str:
        """Return the Ars Technica website URL."""
        return self.ARS_TECHNICA_URL

    @classmethod
    def get_identifier_choices(
        cls, query: Optional[str] = None, user: Optional[Any] = None
    ) -> List[Tuple[str, str]]:
        """Get available Ars Technica RSS feed choices."""
        return [
            (cls.DEFAULT_FEED, "Main Feed"),
            ("https://arstechnica.com/gadgets/feed/", "Gadgets"),
            ("https://arstechnica.com/science/feed/", "Science"),
            ("https://arstechnica.com/gaming/feed/", "Gaming"),
        ]

    @classmethod
    def get_default_identifier(cls) -> str:
        """Get default Ars Technica identifier."""
        return cls.DEFAULT_FEED

    # The one scraper for which unioning is exactly right: Ars serves every
    # "page" of an article in the single fetched HTML as sibling
    # div.post-content.post-content-double blocks separated by <a data-page="N">
    # trackers, and even a single-page news article splits into 2 genuine
    # blocks. First-match would truncate the article. The blocks are distinct
    # segments, never repeats, so they are not de-duplicated. Appending /N/ to
    # an Ars URL only redirects to a #page-N anchor on the same URL, so no
    # pagination fetching is needed either.
    uses_first_content_match = False

    content_selectors = [".post-content"]

    selectors_to_remove = [
        IFRAME_SANITIZE_SELECTOR,
        ".ad",
        "[class*='ad-wrapper']",
        ".ad--mid-content",
        ".ad--rail",
        ".social-share",
        "aside",
        "script",
        "style",
        "noscript",
        "svg",
    ]
