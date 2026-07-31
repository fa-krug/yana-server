"""Tagesschau aggregator implementation."""

import logging
from typing import Any, Dict, List, Optional, Tuple

from bs4 import BeautifulSoup

from ..website import FullWebsiteAggregator
from .content_extraction import extract_tagesschau_content
from .media_processor import extract_media_header

logger = logging.getLogger(__name__)

# Per-article cache for the parsed media header: extract_content needs it to
# decide whether a page is genuinely empty, process_content needs it to render.
# Parsing the page twice per article is pure waste.
_MEDIA_HEADER_CACHE_KEY = "_tagesschau_media_header"


class TagesschauAggregator(FullWebsiteAggregator):
    """
    Specialized aggregator for Tagesschau.de.

    Extracts article content using textabsatz paragraphs, handles media headers,
    and filters out specific types of content (livestreams, podcasts).
    """

    # Extraction runs three tiers: the bespoke textabsatz parser below, then
    # the shared generic extractor (Spec 2 / A3), then the RSS summary. Only
    # the generic tier reads ``selectors_to_remove`` (via get_ignore_selectors);
    # ``uses_first_content_match`` stays inert because the generic tier unions
    # its matches by design. A feed's ``content_selectors`` option has no effect
    # here -- the bespoke parser is the point of this aggregator.

    brand_site_url = "https://www.tagesschau.de/"

    # Body lives in one known container -- keep the first match, never union.
    uses_first_content_match = True

    # Selectors to remove (in addition to those in FullWebsiteAggregator)
    selectors_to_remove = FullWebsiteAggregator.selectors_to_remove + [
        "div.teaser",
        "div.socialbuttons",
        "aside",
        "nav",
        "button",
        "div.bigfive",
        "div.metatextline",
        "noscript",
        "svg",
    ]

    def __init__(self, feed):
        super().__init__(feed)
        if not self.identifier or self.identifier == "":
            self.identifier = self.get_default_identifier()

    def get_source_url(self) -> str:
        return "https://www.tagesschau.de"

    @classmethod
    def get_identifier_choices(
        cls, query: Optional[str] = None, user: Optional[Any] = None
    ) -> List[Tuple[str, str]]:
        """Get available Tagesschau RSS feed choices."""
        return [
            (
                "https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml",
                "Alle Meldungen",
            ),
            ("https://www.tagesschau.de/index~rss2.xml", "Startseite"),
            ("https://www.tagesschau.de/inland/index~rss2.xml", "Inland"),
            ("https://www.tagesschau.de/inland/innenpolitik/index~rss2.xml", "Innenpolitik"),
            ("https://www.tagesschau.de/inland/gesellschaft/index~rss2.xml", "Gesellschaft"),
            ("https://www.tagesschau.de/inland/regional/index~rss2.xml", "Regional (Alle)"),
            (
                "https://www.tagesschau.de/inland/regional/badenwuerttemberg/index~rss2.xml",
                "Baden-Württemberg",
            ),
            ("https://www.tagesschau.de/inland/regional/bayern/index~rss2.xml", "Bayern"),
            ("https://www.tagesschau.de/inland/regional/berlin/index~rss2.xml", "Berlin"),
            ("https://www.tagesschau.de/inland/regional/brandenburg/index~rss2.xml", "Brandenburg"),
            ("https://www.tagesschau.de/inland/regional/bremen/index~rss2.xml", "Bremen"),
            ("https://www.tagesschau.de/inland/regional/hamburg/index~rss2.xml", "Hamburg"),
            ("https://www.tagesschau.de/inland/regional/hessen/index~rss2.xml", "Hessen"),
            (
                "https://www.tagesschau.de/inland/regional/mecklenburgvorpommern/index~rss2.xml",
                "Mecklenburg-Vorpommern",
            ),
            (
                "https://www.tagesschau.de/inland/regional/niedersachsen/index~rss2.xml",
                "Niedersachsen",
            ),
            (
                "https://www.tagesschau.de/inland/regional/nordrheinwestfalen/index~rss2.xml",
                "Nordrhein-Westfalen",
            ),
            (
                "https://www.tagesschau.de/inland/regional/rheinlandpfalz/index~rss2.xml",
                "Rheinland-Pfalz",
            ),
            ("https://www.tagesschau.de/inland/regional/saarland/index~rss2.xml", "Saarland"),
            ("https://www.tagesschau.de/inland/regional/sachsen/index~rss2.xml", "Sachsen"),
            (
                "https://www.tagesschau.de/inland/regional/sachsenanhalt/index~rss2.xml",
                "Sachsen-Anhalt",
            ),
            (
                "https://www.tagesschau.de/inland/regional/schleswigholstein/index~rss2.xml",
                "Schleswig-Holstein",
            ),
            ("https://www.tagesschau.de/inland/regional/thueringen/index~rss2.xml", "Thüringen"),
            ("https://www.tagesschau.de/ausland/index~rss2.xml", "Ausland"),
            ("https://www.tagesschau.de/ausland/europa/index~rss2.xml", "Europa"),
            ("https://www.tagesschau.de/ausland/amerika/index~rss2.xml", "Amerika"),
            ("https://www.tagesschau.de/ausland/afrika/index~rss2.xml", "Afrika"),
            ("https://www.tagesschau.de/ausland/asien/index~rss2.xml", "Asien"),
            ("https://www.tagesschau.de/ausland/ozeanien/index~rss2.xml", "Ozeanien"),
            ("https://www.tagesschau.de/wirtschaft/index~rss2.xml", "Wirtschaft"),
            ("https://www.tagesschau.de/wirtschaft/finanzen/index~rss2.xml", "Finanzen"),
            ("https://www.tagesschau.de/wirtschaft/unternehmen/index~rss2.xml", "Unternehmen"),
            ("https://www.tagesschau.de/wirtschaft/verbraucher/index~rss2.xml", "Verbraucher"),
            (
                "https://www.tagesschau.de/wirtschaft/technologie/index~rss2.xml",
                "Technologie (Wirtschaft)",
            ),
            (
                "https://www.tagesschau.de/wirtschaft/weltwirtschaft/index~rss2.xml",
                "Weltwirtschaft",
            ),
            ("https://www.tagesschau.de/wirtschaft/konjunktur/index~rss2.xml", "Konjunktur"),
            ("https://www.tagesschau.de/wissen/index~rss2.xml", "Wissen"),
            ("https://www.tagesschau.de/wissen/gesundheit/index~rss2.xml", "Gesundheit"),
            ("https://www.tagesschau.de/wissen/klima/index~rss2.xml", "Klima & Umwelt"),
            ("https://www.tagesschau.de/wissen/forschung/index~rss2.xml", "Forschung"),
            ("https://www.tagesschau.de/wissen/technologie/index~rss2.xml", "Technologie (Wissen)"),
            ("https://www.tagesschau.de/faktenfinder/index~rss2.xml", "Faktenfinder"),
            ("https://www.tagesschau.de/investigativ/index~rss2.xml", "Investigativ"),
        ]

    @classmethod
    def get_default_identifier(cls) -> str:
        """Get default Tagesschau identifier."""
        return "https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml"

    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """Get Tagesschau configuration fields."""
        from django import forms

        return {
            "skip_livestreams": forms.BooleanField(
                initial=True,
                label="Skip Livestreams",
                help_text="Filter out articles that are just links to livestreams.",
                required=False,
            ),
            "skip_videos": forms.BooleanField(
                initial=True,
                label="Skip Videos",
                help_text="Filter out articles that are primarily videos.",
                required=False,
            ),
        }

    def filter_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Filter out livestreams, podcasts, and other unwanted content."""
        # First use base filtering (age check)
        articles = super().filter_articles(articles)

        filtered = []
        for article in articles:
            if self._should_skip_article(article):
                continue
            filtered.append(article)

        return filtered

    def _should_skip_article(self, article: Dict[str, Any]) -> bool:
        """Check if article should be skipped based on title or URL."""
        title = article.get("name", "")
        url = article.get("identifier", "")

        # Check configuration
        skip_livestreams = self.feed.options.get("skip_livestreams", True)
        skip_videos = self.feed.options.get("skip_videos", True)

        # Skip livestreams
        if skip_livestreams and "Livestream:" in title:
            self.logger.info(f"Skipping livestream article: {title}")
            return True

        # Check title filters
        skip_terms = [
            "tagesschau",
            "tagesthemen",
            "11KM-Podcast",
            "Podcast 15 Minuten",
            "15 Minuten:",
        ]

        if any(term in title for term in skip_terms):
            self.logger.info(f"Skipping filtered content by title: {title}")
            return True

        # Check URL filters
        if "bilder/blickpunkte" in url:
            self.logger.info(f"Skipping image gallery: {url}")
            return True

        if skip_videos and "video" in url.lower():
            self.logger.info(f"Skipping video article: {url}")
            return True

        return False

    def extract_content(self, html: str, article: Dict[str, Any]) -> str:
        """Extract content: textabsatz, then generic extraction, then RSS.

        Regional feeds syndicate items that link straight to an external ARD
        broadcaster page (mdr.de, ndr.de, ...). Those templates carry none of
        tagesschau.de's textabsatz/MediaPlayer markup, so tier 1 finds nothing
        and the article used to land empty. Tier 2 is the shared generic
        extractor with its 80-character floor; widget pages (the DWD weather
        pages) match no container at all and correctly reach tier 3.
        """
        extracted = extract_tagesschau_content(html)

        if self._has_real_content(extracted) or self._media_header(html, article):
            return extracted

        generic = self.generic_content_if_present(html, article)
        if generic:
            self.logger.info(
                "[extract_content] Using generic extraction for %s", article.get("identifier")
            )
            return generic

        self.logger.info(
            "[extract_content] No usable page content for %s -- using the RSS summary",
            article.get("identifier"),
        )
        return article.get("content", "")

    @staticmethod
    def _has_real_content(html: str) -> bool:
        """True when the bespoke extractor produced text or embedded media."""
        soup = BeautifulSoup(html, "html.parser")
        if soup.get_text(strip=True):
            return True
        return soup.find(["img", "iframe", "video", "audio"]) is not None

    def _media_header(self, html: str, article: Dict[str, Any]) -> Optional[str]:
        """Parse the MediaPlayer header once per article and cache the result."""
        if _MEDIA_HEADER_CACHE_KEY in article:
            cached: Optional[str] = article[_MEDIA_HEADER_CACHE_KEY]
            return cached

        media_header: Optional[str] = None
        if html:
            try:
                media_header = extract_media_header(html)
            except Exception as e:
                self.logger.debug(
                    f"Failed to extract media header for {article.get('identifier')}: {e}"
                )

        article[_MEDIA_HEADER_CACHE_KEY] = media_header
        return media_header

    def process_content(self, html: str, article: Dict[str, Any]) -> str:
        """Process content and add media header if available."""
        raw_html = article.get("raw_content", "")
        media_header = self._media_header(raw_html, article)
        # The cache is per-run scratch space; don't let it reach the ORM layer.
        article.pop(_MEDIA_HEADER_CACHE_KEY, None)

        # If we have a media_header, temporarily remove header_data so
        # super().process_content() doesn't add a duplicate (less specific) header image.
        header_data = article.get("header_data")
        if media_header and header_data:
            article["header_data"] = None

        try:
            processed = super().process_content(html, article)
        finally:
            if media_header and header_data:
                article["header_data"] = header_data

        if media_header:
            return media_header + processed

        return processed
