"""Caschy's Blog aggregator implementation."""

from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from ..website import FullWebsiteAggregator


class CaschysBlogAggregator(FullWebsiteAggregator):
    """Aggregator for Caschy's Blog (stadt-bremerhaven.de)."""

    def __init__(self, feed):
        super().__init__(feed)
        if not self.identifier or self.identifier == "":
            self.identifier = "https://stadt-bremerhaven.de/feed/"

    def get_source_url(self) -> str:
        return "https://stadt-bremerhaven.de"

    @classmethod
    def get_identifier_choices(
        cls, query: Optional[str] = None, user: Optional[Any] = None
    ) -> List[Tuple[str, str]]:
        return [
            ("https://stadt-bremerhaven.de/feed/", "Caschy's Blog (Main Feed)"),
        ]

    @classmethod
    def get_default_identifier(cls) -> str:
        return "https://stadt-bremerhaven.de/feed/"

    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """Get Caschy's Blog configuration fields."""
        from django import forms

        return {
            "skip_ads": forms.BooleanField(
                initial=True,
                label="Skip Advertisements",
                help_text="Filter out articles marked as '(Anzeige)'.",
                required=False,
            ),
        }

    # Main content container
    content_selectors = [".entry-inner"]

    # Selectors to strip
    selectors_to_remove = [
        ".aawp",
        ".aawp-disclaimer",
        "script",
        "style",
        "noscript",
        "svg",
    ]

    def filter_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Skip articles marked as advertisements or weekly recaps."""
        # First use base filtering (age check)
        filtered = super().filter_articles(articles)

        # Get options
        skip_ads = self.feed.options.get("skip_ads", True)

        # Filter articles
        result = []
        for article in filtered:
            name = article.get("name", "")

            # Filter out advertisements
            if skip_ads and "(Anzeige)" in name:
                self.logger.info(f"Skipping advertisement article: {name}")
                continue

            # Filter out weekly recaps
            if "Immer wieder sonntags KW" in name:
                self.logger.info(f"Skipping weekly recap article: {name}")
                continue

            result.append(article)

        return result

    def process_content(self, html: str, article: Dict[str, Any]) -> str:
        """Resolve relative URLs in content."""
        soup = BeautifulSoup(html, "html.parser")
        base_url = article["identifier"]

        # Filter iframes (only allow YouTube and Twitter/X)
        for iframe in soup.find_all("iframe"):
            src = iframe.get("src", "")
            if not src:
                iframe.decompose()
                continue

            # Check if source is allowed
            is_youtube = "youtube.com" in src or "youtu.be" in src
            is_twitter = "twitter.com" in src or "x.com" in src

            if not (is_youtube or is_twitter):
                self.logger.debug(f"Removing disallowed iframe: {src}")
                iframe.decompose()

        # Resolve relative URLs for images
        for img in soup.find_all("img"):
            src = img.get("src")
            if (
                src
                and not isinstance(src, list)
                and not src.startswith(("http://", "https://", "data:"))
            ):
                img["src"] = urljoin(base_url, str(src))

        # Resolve relative URLs for links
        for a in soup.find_all("a"):
            href = a.get("href")
            if (
                href
                and not isinstance(href, list)
                and not href.startswith(("http://", "https://", "mailto:", "tel:", "#"))
            ):
                a["href"] = urljoin(base_url, str(href))

        # Remove first image if we have a header image (avoid duplication)
        # Caschy's Blog often has the featured image at the top of the content,
        # sometimes with a different filename than the OG image.
        if article.get("header_data"):
            # Get the root container. The content passed to this method is usually wrapped in the
            # matched content selector's element.
            # We want to check the *contents* of that wrapper.
            root: Tag = soup

            # Helper to filter only Tags (ignoring NavigableString etc)
            top_level_tags = [t for t in soup.contents if isinstance(t, Tag)]
            if len(top_level_tags) == 1:
                root = top_level_tags[0]

            # Iterate over top-level elements (ignoring whitespace)
            for element in root.contents:
                if not isinstance(element, Tag):
                    continue

                if not element.name:
                    continue

                # If first element is an image, remove it
                if element.name == "img":
                    self.logger.debug("Removing first image (duplicate of header)")
                    element.decompose()
                    break

                # If first element is a paragraph, check if it starts with an image
                if element.name == "p":
                    found_image = False
                    for p_child in element.contents:
                        if isinstance(p_child, str):
                            if p_child.strip():
                                # Text found before image
                                break
                            continue

                        if not isinstance(p_child, Tag):
                            continue

                        if p_child.name == "img":
                            self.logger.debug(
                                "Removing first image in paragraph (duplicate of header)"
                            )
                            p_child.decompose()
                            found_image = True
                            break

                        # Check for image wrapped in a link: <a><img></a>
                        if p_child.name == "a":
                            link_img = p_child.find("img", recursive=False)
                            if link_img:
                                self.logger.debug(
                                    "Removing first image in link (duplicate of header)"
                                )
                                # Remove the entire link containing the image
                                p_child.decompose()
                                found_image = True
                            break

                        # Skip line breaks
                        if p_child.name == "br":
                            continue

                        # Stop at other tags
                        break

                    if found_image:
                        break

                # Only check the first significant element
                break

        return super().process_content(str(soup), article)
