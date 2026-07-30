"""The Verge aggregator implementation."""

from typing import Any, List, Optional, Tuple

from ..utils import IFRAME_SANITIZE_SELECTOR
from ..website import RssSummaryFallbackAggregator


class TheVergeAggregator(RssSummaryFallbackAggregator):
    """Aggregator for The Verge (theverge.com) US tech/culture news."""

    THE_VERGE_URL = "https://www.theverge.com"
    DEFAULT_FEED = "https://www.theverge.com/rss/index.xml"

    def __init__(self, feed):
        super().__init__(feed)
        if not self.identifier or self.identifier == "":
            self.identifier = self.DEFAULT_FEED

    def get_source_url(self) -> str:
        """Return The Verge website URL."""
        return self.THE_VERGE_URL

    @classmethod
    def get_identifier_choices(
        cls, query: Optional[str] = None, user: Optional[Any] = None
    ) -> List[Tuple[str, str]]:
        """The only feed The Verge exposes -- section feeds return 404."""
        return [(cls.DEFAULT_FEED, "Main Feed")]

    @classmethod
    def get_default_identifier(cls) -> str:
        """Get default The Verge identifier."""
        return cls.DEFAULT_FEED

    # Essential: the page embeds ~22 sibling article-body-component divs -- the
    # main article plus related/"stream" article bodies. Unioning them would
    # splice unrelated articles into the body.
    uses_first_content_match = True

    # WordPress-backed with Vox's "Duet" design system; the prose lives in
    # .duet--article--dangerously-set-cms-markup blocks inside this container.
    content_selectors = [".duet--article--article-body-component"]

    selectors_to_remove = [
        IFRAME_SANITIZE_SELECTOR,
        "aside",
        "[class*='duet--recirculation']",
        "[class*='duet--ad']",
        "[class*='newsletter']",
        "script",
        "style",
        "noscript",
        "svg",
    ]
