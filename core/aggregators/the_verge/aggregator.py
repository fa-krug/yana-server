"""The Verge aggregator implementation."""

from typing import Any, List, Optional, Tuple

from ..utils import IFRAME_SANITIZE_SELECTOR
from ..website import RssSummaryFallbackAggregator


class TheVergeAggregator(RssSummaryFallbackAggregator):
    """Aggregator for The Verge (theverge.com) US tech/culture news."""

    THE_VERGE_URL = "https://www.theverge.com"
    DEFAULT_FEED = "https://www.theverge.com/rss/index.xml"
    brand_site_url = "https://www.theverge.com/"

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

    # WordPress-backed with Vox's "Duet" design system, which emits one
    # article-body-component div per paragraph-group rather than one per
    # article -- keeping only the first (as this used to) throws away most of
    # the body. The page also embeds ~22 sibling article-body-component divs
    # for related/"stream" articles, so unioning the bare class would splice
    # unrelated articles into the body. Scoping to descendants of
    # .duet--layout--entry-body -- which wraps only the main article's
    # components -- makes unioning safe: every match is part of the one
    # article, so nothing outside it can be pulled in.
    uses_first_content_match = False
    content_selectors = [".duet--layout--entry-body .duet--article--article-body-component"]

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
