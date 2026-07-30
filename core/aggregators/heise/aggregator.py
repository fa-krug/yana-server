"""Heise aggregator implementation."""

import json
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, Tag

from ..utils import (
    clean_html,
    extract_main_content_if_present,
    fetch_html,
    format_article_content,
    remove_image_by_url,
    sanitize_class_names,
)
from ..utils.youtube import proxy_youtube_embeds
from ..website import FullWebsiteAggregator


class HeiseAggregator(FullWebsiteAggregator):
    """Specialized aggregator for Heise.de German tech news."""

    HEISE_URL = "https://www.heise.de/"

    def __init__(self, feed):
        super().__init__(feed)
        if not self.identifier or self.identifier == "":
            self.identifier = "https://www.heise.de/rss/heise.rdf"

    def get_source_url(self) -> str:
        """Return the Heise website URL."""
        return self.HEISE_URL

    @classmethod
    def get_identifier_choices(
        cls, query: Optional[str] = None, user: Optional[Any] = None
    ) -> List[Tuple[str, str]]:
        """Get available Heise RSS feed choices."""
        return [
            ("https://www.heise.de/rss/heise.rdf", "Main Feed"),
            ("https://www.heise.de/rss/heise-security.rdf", "Security"),
            ("https://www.heise.de/rss/heise-developer.rdf", "Developer"),
            ("https://www.heise.de/rss/heise-top.rdf", "Top News"),
        ]

    @classmethod
    def get_default_identifier(cls) -> str:
        """Get default Heise identifier."""
        return "https://www.heise.de/rss/heise.rdf"

    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """Get Heise configuration fields."""
        from django import forms

        return {
            "include_comments": forms.BooleanField(
                initial=True,
                label="Include Forum Comments",
                help_text="Extract top comments from the Heise forum.",
                required=False,
            ),
            "max_comments": forms.IntegerField(
                initial=5,
                label="Max Comments",
                help_text="Number of comments to extract if enabled.",
                required=False,
                min_value=0,
                max_value=20,
            ),
        }

    # Body lives in one known container -- keep the first match, never union.
    uses_first_content_match = True

    # Heise specific selectors
    content_selectors = ["#meldung", ".StoryContent"]

    selectors_to_remove = [
        ".ad-label",
        ".ad",
        ".article-sidebar",
        "section",
        "a[name='meldung.ho.bottom.zurstartseite']",
        ".a-article-header__lead",
        ".a-article-header__title",
        ".a-article-header__publish-info",
        ".a-article-header__service",
        "a-lightbox.article-image",  # Main article header image
        "figure.a-article-header__image",  # Main article header image (fallback)
        "div[data-component='RecommendationBox']",
        ".opt-in__content-container",
        ".a-box",
        "iframe:not([src*='youtube.com']):not([src*='youtu.be'])",
        ".a-u-inline",
        ".redakteurskuerzel",
        ".branding",
        "a-gift",
        "aside",
        "script",
        "style",
        "noscript",
        "footer",
        ".rte__list",
        "#wtma_teaser_ho_vertrieb_inline_branding",
    ]

    def fetch_article_content(self, url: str) -> str:
        """Fetch article content, optionally converting to all-pages URL."""
        # By default, we always try to get all pages if it's a multi-page article
        article_url = url
        try:
            parsed = urlparse(url)
            if "seite=all" not in parsed.query:
                article_url = f"{url}&seite=all" if parsed.query else f"{url}?seite=all"
                self.logger.info(
                    f"[fetch_article_content] Converted to all-pages URL: {article_url}"
                )
        except Exception as e:
            self.logger.warning(f"[fetch_article_content] Failed to convert to all-pages URL: {e}")

        return super().fetch_article_content(article_url)

    def filter_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Filter articles based on title terms."""
        # First use base filtering (age check)
        articles = super().filter_articles(articles)

        skip_terms = [
            "die Bilder der Woche",
            "Produktwerker",
            "heise-Angebot",
            "#TGIQF",
            "heise+",
            "#heiseshow:",
            "Mein Scrum ist kaputt",
            "software-architektur.tv",
            "Developer Snapshots",
        ]

        filtered = []
        for article in articles:
            title = article.get("name", "")
            title_lower = title.lower()
            if any(term.lower() in title_lower for term in skip_terms):
                self.logger.info(f"[filter_articles] Skipping filtered content by title: {title}")
                continue
            filtered.append(article)

        return filtered

    def enrich_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Enrich articles and filter out specific content terms."""
        enriched = super().enrich_articles(articles)

        # Additional content-based filtering (e.g. Event Sourcing)
        final_articles = []
        for article in enriched:
            content = article.get("content", "").lower()
            if "event sourcing" in content:
                self.logger.info(
                    f"[enrich_articles] Skipping article with 'Event Sourcing' in content: {article['name']}"
                )
                continue
            final_articles.append(article)

        return final_articles

    def extract_content(self, html: str, article: Dict[str, Any]) -> str:
        """Extract the Heise story container, degrading to the RSS summary.

        Heise pages carry many sibling ``<article>`` teaser cards and a
        page-chrome ``.article-content`` container, so a ``<body>`` fallback
        surfaces the whole site as the article -- magazine and paywall gate
        pages have a different DOM and hit that path routinely. Report the miss
        instead and let the RSS summary stand.
        """
        extracted = extract_main_content_if_present(
            html,
            content_selectors=self.get_content_selectors(),
            remove_selectors=self.get_ignore_selectors(),
            first_match_only=self.uses_first_content_match,
        )

        if extracted is None:
            self.logger.info(
                "[extract_content] No Heise story container for %s -- using the RSS summary",
                article.get("identifier"),
            )
            return article.get("content", "")

        # Remove empty elements (p/div/span with no text and no images).
        soup = BeautifulSoup(extracted, "html.parser")
        for tag in soup.find_all(["p", "div", "span"]):
            if not tag.get_text(strip=True) and not tag.find_all("img"):
                tag.decompose()

        return str(soup)

    def process_content(self, html: str, article: Dict[str, Any]) -> str:
        """Process content and optionally add comments."""
        # Note: We override FullWebsiteAggregator.process_content entirely
        # to inject comments BEFORE the footer (which format_article_content adds).

        # 1. Standard Content Processing (copied from FullWebsiteAggregator)
        soup = BeautifulSoup(html, "html.parser")

        # Proxy YouTube embeds
        proxy_youtube_embeds(soup)

        # Remove header image from content if it was extracted
        header_data = article.get("header_data")
        if header_data and header_data.image_url:
            self.logger.debug(f"Removing header image from content: {header_data.image_url}")
            remove_image_by_url(soup, header_data.image_url)

        # Sanitize class names
        sanitize_class_names(soup)

        # Clean HTML
        cleaned = clean_html(str(soup))

        # Determine header image URL for formatting
        header_image_url = header_data.image_ref if header_data else None

        # 2. Extract Comments (Heise Specific)
        comments_html = None
        include_comments = self.feed.options.get("include_comments", True)
        max_comments = self.feed.options.get("max_comments", 5)

        if include_comments:
            try:
                # We need the original full HTML to find the forum link
                raw_html = article.get("raw_content", "")
                if raw_html:
                    comments_html = self.extract_comments(
                        article["identifier"], raw_html, max_comments=max_comments
                    )
            except Exception as e:
                self.logger.warning(
                    f"[process_content] Failed to extract comments for {article['identifier']}: {e}"
                )

        # 3. Format Article (Inject content + comments + footer)
        formatted = format_article_content(
            cleaned,
            title=article["name"],
            url=article["identifier"],
            header_image_url=header_image_url,
            comments_content=comments_html,
        )

        return formatted

    def extract_comments(
        self, article_url: str, article_html: str, max_comments: int = 5
    ) -> Optional[str]:
        """Extract comments from the forum link."""
        # Use HEISE_URL as base if article_url is an RSS GUID (http://heise.de/-...)
        # This ensures we resolve relative forum links to https://www.heise.de
        base_url = article_url
        if "heise.de/-" in article_url:
            base_url = "https://www.heise.de/"

        forum_url = self._find_forum_url(article_html, base_url)
        if not forum_url:
            return None

        self.logger.info(f"[extract_comments] Fetching comments from forum: {forum_url}")
        try:
            forum_html = fetch_html(forum_url)
            soup = BeautifulSoup(forum_html, "html.parser")

            # Find comment elements
            comment_elements = self._find_comment_elements(soup)
            if not comment_elements:
                return None

            comment_parts = []
            for i, el in enumerate(comment_elements[:max_comments]):
                comment_html = self._process_comment_element(el, i, article_url)
                if comment_html:
                    comment_parts.append(comment_html)

            if not comment_parts:
                return None

            # Reddit-style header and simple section container
            header = f'<h3><a href="{forum_url}">Comments</a></h3>'
            return f"<section>{header}{''.join(comment_parts)}</section>"

        except Exception as e:
            self.logger.warning(f"[extract_comments] Error: {e}")
            return None

    def _find_forum_url(self, html: str, article_url: str) -> Optional[str]:
        """Find forum URL from JSON-LD or fallback links."""
        soup = BeautifulSoup(html, "html.parser")

        # JSON-LD
        for script in soup.find_all("script", type="application/ld+json"):
            if not script.string:
                continue
            try:
                data = json.loads(str(script.string))
                items = data if isinstance(data, list) else [data]
                for item in items:
                    if "discussionUrl" in item:
                        discussion_url = str(item["discussionUrl"])
                        return urljoin(article_url, discussion_url)
            except Exception:
                continue

        # Fallback link
        # 1. Look for the "Kommentare lesen" button (usually in footer)
        comment_button = soup.select_one(
            'a[href*="/forum/"][href*="comment"], footer a[href*="/forum/"]'
        )
        if isinstance(comment_button, Tag):
            href = str(comment_button.get("href", ""))
            if href:
                return urljoin(article_url, href)

        return None

    def _find_comment_elements(self, soup: BeautifulSoup) -> List[Any]:
        """Find comment elements using various selectors."""
        selectors = [
            "li.posting_element",
            '[id^="posting_"]',
            ".posting",
            ".a-comment",
        ]
        for selector in selectors:
            elements = soup.select(selector)
            if elements:
                return elements
        return []

    def _process_comment_element(self, el: Any, index: int, article_url: str) -> Optional[str]:
        """Process a single comment element."""
        # Determine if it's a list item view or full view
        if el.name == "li":
            return self._process_list_item_comment(el)
        else:
            return self._process_full_view_comment(el, index, article_url)

    def _process_list_item_comment(self, el: Any) -> Optional[str]:
        author = "Unknown"
        author_el = el.select_one(".tree_thread_list--written_by_user, .pseudonym")
        if author_el:
            author = author_el.get_text(strip=True)

        title_link = el.select_one("a.posting_subject")
        if not title_link:
            return None

        title = title_link.get_text(strip=True)
        comment_url = urljoin(self.HEISE_URL, title_link.get("href", ""))

        # Reddit-style styling (clean blockquote)
        return (
            f"<blockquote>"
            f'<p><strong>{author}</strong> | <a href="{comment_url}">source</a></p>'
            f"<div><p>{title}</p></div>"
            f"</blockquote>"
        )

    def _process_full_view_comment(self, el: Any, index: int, article_url: str) -> Optional[str]:
        author = "Unknown"
        author_selectors = [
            'a[href*="/forum/heise-online/Meinungen"]',
            ".pseudonym",
            ".username",
            "strong",
        ]
        for selector in author_selectors:
            author_el = el.select_one(selector)
            if author_el:
                text = author_el.get_text(strip=True)
                if text and len(text) < 50:
                    author = text
                    break

        content = ""
        content_selectors = [".text", ".posting-content", ".comment-body", "p"]
        for selector in content_selectors:
            content_el = el.select_one(selector)
            if content_el:
                content = str(content_el)
                break

        if not content:
            return None

        comment_id = el.get("id") or f"comment-{index}"
        comment_url = f"{article_url}#{comment_id}"

        # Reddit-style styling (clean blockquote)
        return (
            f"<blockquote>"
            f'<p><strong>{author}</strong> | <a href="{comment_url}">source</a></p>'
            f"<div>{content}</div>"
            f"</blockquote>"
        )
