"""Explosm aggregator implementation."""

from typing import Any, Dict, List, Optional, Tuple

from bs4 import BeautifulSoup

from ..website import FullWebsiteAggregator


class ExplosmAggregator(FullWebsiteAggregator):
    """Aggregator for Explosm (Cyanide & Happiness)."""

    def __init__(self, feed):
        super().__init__(feed)
        if not self.identifier or self.identifier == "":
            self.identifier = "https://explosm.net/rss.xml"

    def get_source_url(self) -> str:
        return "https://explosm.net"

    @classmethod
    def get_identifier_choices(
        cls, query: Optional[str] = None, user: Optional[Any] = None
    ) -> List[Tuple[str, str]]:
        return [
            ("https://explosm.net/rss.xml", "Cyanide & Happiness (Main RSS)"),
        ]

    @classmethod
    def get_default_identifier(cls) -> str:
        return "https://explosm.net/rss.xml"

    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """Get Explosm configuration fields."""
        from django import forms

        return {
            "show_alt_text": forms.BooleanField(
                initial=True,
                label="Show Alt Text",
                help_text="Display the comic's alt text below the image.",
                required=False,
            ),
        }

    # Body lives in one known container -- keep the first match, never union.
    uses_first_content_match = True

    # Main comic container
    content_selectors = ["#comic"]

    # Selectors to strip from the comic container
    selectors_to_remove = [
        "script",
        "style",
        "iframe",
        "noscript",
        "aside",
        'div[class*="MainComic__LinkContainer"]',
        'div[class*="MainComic__MetaContainer"]',
        'div[class*="ComicSelector__Container"]',
        'div[class*="ComicShare__Container"]',
        'img[loading~="lazy"]',
    ]

    def extract_header_element(self, article: Dict[str, Any]) -> Optional[Any]:
        """Disable header element extraction for Explosm as the comic is the main content."""
        return None

    def process_content(self, html: str, article: Dict[str, Any]) -> str:
        """Specialized processing to ensure we only have the comic image if possible."""
        soup = BeautifulSoup(html, "html.parser")

        # Get options
        show_alt_text = self.feed.options.get("show_alt_text", True)

        # Try to find the primary comic image
        comic_img = None
        for img in soup.find_all("img"):
            src = img.get("src", "")
            if not src or not isinstance(src, str) or src.startswith("data:"):
                continue

            # In the fixture: https://static.explosm.net/2025/12/12113205/bygones.png
            if "static.explosm.net" in src:
                comic_img = img
                break

        if comic_img:
            # Create a clean div with just the image
            new_soup = BeautifulSoup("<div></div>", "html.parser")
            if new_soup.div:
                new_img = new_soup.new_tag("img", src=str(comic_img["src"]))
                alt_text = comic_img.get("alt")
                if alt_text:
                    new_img["alt"] = str(alt_text)
                new_soup.div.append(new_img)

                if show_alt_text and alt_text:
                    p = new_soup.new_tag(
                        "p",
                        style="font-style: italic; margin-top: 1em; color: #666; text-align: center;",
                    )
                    p.string = str(alt_text)
                    new_soup.div.append(p)

                html = str(new_soup)

        return super().process_content(html, article)
