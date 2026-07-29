"""Content extraction utilities using BeautifulSoup."""

import logging
from typing import List, Optional, Union

from bs4 import BeautifulSoup, Tag

logger = logging.getLogger(__name__)

# Always removed before content selection. Not user-configurable: emptying
# ``ignore_selectors`` must never be able to disable sanitization.
MANDATORY_REMOVE_SELECTORS: List[str] = [
    "script",
    "style",
    "noscript",
    "template",
]

# Iframe sanitization is an aggregator-level policy, not an extractor one: some
# scrapers allow additional embed hosts (Caschy's Blog allows Twitter/X) and
# filter iframes themselves in process_content. Kept in
# FullWebsiteAggregator.selectors_to_remove, where feed options cannot disable it.
IFRAME_SANITIZE_SELECTOR = "iframe:not([src*='youtube.com']):not([src*='youtu.be'])"

# Defaults mirrored from the iOS client's shipped AggregatorOptions.swift.
DEFAULT_CONTENT_SELECTORS: List[str] = ["article", ".article-content", ".entry-content", "main"]
DEFAULT_IGNORE_SELECTORS: List[str] = [
    ".advertisement",
    ".ad",
    ".ads",
    "[class*='advert']",
    "[class*='sponsor']",
    ".social-share",
    ".newsletter",
    ".related-articles",
]

SoupOrTag = Union[BeautifulSoup, Tag]


def _remove_matching(root: SoupOrTag, selectors: List[str]) -> None:
    """Remove every element matching any selector. Invalid selectors are skipped."""
    for selector in selectors:
        try:
            matches = root.select(selector)
        except Exception as exc:
            logger.warning("Skipping invalid remove selector %r: %s", selector, exc)
            continue
        for element in matches:
            element.decompose()


def select_content_elements(
    root: SoupOrTag, content_selectors: List[str], first_match_only: bool = False
) -> List[Tag]:
    """
    Collect the content containers matching any of ``content_selectors``.

    Matches are returned in document order (not selector order), de-duplicated,
    and reduced to the outermost elements -- a match nested inside another match
    is dropped so its body is not captured twice.

    Args:
        root: Soup or tag to search within
        content_selectors: CSS selectors marking places to look for the body
        first_match_only: Keep only the first match in document order

    Returns:
        List of matching tags, possibly empty
    """
    matched_ids = set()
    for selector in content_selectors:
        try:
            matches = root.select(selector)
        except Exception as exc:
            logger.warning("Skipping invalid content selector %r: %s", selector, exc)
            continue
        for element in matches:
            if isinstance(element, Tag):
                matched_ids.add(id(element))

    if not matched_ids:
        return []

    # Walking the tree yields document order and de-duplicates for free.
    ordered = [tag for tag in root.find_all(True) if id(tag) in matched_ids]

    # Outermost wins.
    outermost = [
        tag for tag in ordered if not any(id(parent) in matched_ids for parent in tag.parents)
    ]

    if first_match_only:
        return outermost[:1]
    return outermost


def extract_main_content_if_present(
    html: str,
    content_selectors: List[str],
    remove_selectors: Optional[List[str]] = None,
    first_match_only: bool = False,
) -> Optional[str]:
    """
    Extract article content, reporting a miss instead of falling back to <body>.

    Used by scrapers with a dedicated article container, where a ``<body>``
    fallback would surface site navigation as the article.

    Returns:
        Extracted HTML, or None when no content selector matched
    """
    soup = BeautifulSoup(html, "html.parser")
    _remove_matching(soup, MANDATORY_REMOVE_SELECTORS)

    elements = select_content_elements(soup, content_selectors, first_match_only=first_match_only)
    if not elements:
        return None

    for element in elements:
        _remove_matching(element, remove_selectors or [])

    return "\n".join(str(element) for element in elements)


def extract_main_content(
    html: str,
    content_selectors: List[str],
    remove_selectors: Optional[List[str]] = None,
    first_match_only: bool = False,
) -> str:
    """
    Extract main content from HTML using a list of CSS selectors.

    Every selector is applied and the surviving containers are concatenated, so
    an article split across sibling containers is no longer truncated.

    Args:
        html: Full HTML document
        content_selectors: CSS selectors marking places to look for the body
        remove_selectors: CSS selectors for elements to remove from the result
        first_match_only: Keep only the first match in document order

    Returns:
        Extracted HTML content, falling back to <body> when nothing matched
    """
    extracted = extract_main_content_if_present(
        html,
        content_selectors=content_selectors,
        remove_selectors=remove_selectors,
        first_match_only=first_match_only,
    )
    if extracted is not None:
        return extracted

    soup = BeautifulSoup(html, "html.parser")
    _remove_matching(soup, MANDATORY_REMOVE_SELECTORS)
    body = soup.find("body")
    target: SoupOrTag = body if isinstance(body, Tag) else soup
    _remove_matching(target, remove_selectors or [])
    return str(target)
