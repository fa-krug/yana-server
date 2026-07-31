"""Multi-page article detection and fetching for MacTechNews."""

import logging
import re
from typing import Callable, List, Set
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from bs4 import BeautifulSoup

from ..utils.content_extractor import select_content_elements


def detect_pagination(html: str, logger: logging.Logger) -> Set[int]:
    """
    Detect page numbers from MacTechNews pagination elements.

    MacTechNews uses ?page=N query parameters for multi-page articles.
    The pagination section contains links with ?page=N and the current page
    as plain (non-linked) text.

    Args:
        html: HTML content to parse
        logger: Logger instance

    Returns:
        Set of page numbers (always includes 1)
    """
    soup = BeautifulSoup(html, "html.parser")
    page_numbers: Set[int] = {1}

    logger.debug("Starting MacTechNews pagination detection")

    # Find all links containing ?page=N or &page=N
    for link in soup.find_all("a", href=True):
        href = str(link.get("href", ""))
        match = re.search(r"[?&]page=(\d+)", href)
        if match:
            page_num = int(match.group(1))
            page_numbers.add(page_num)
            logger.debug(f"Found page number from link: {page_num}")

    # Detect the current page (rendered as <strong>N</strong> without a link)
    for strong in soup.find_all("strong"):
        text = strong.get_text(strip=True)
        if re.fullmatch(r"\d+", text):
            page_num = int(text)
            page_numbers.add(page_num)
            logger.debug(f"Found current page number from bold text: {page_num}")

    sorted_pages = sorted(page_numbers)
    logger.info(f"Pagination detection complete: {len(page_numbers)} pages found - {sorted_pages}")
    return page_numbers


def _build_page_url(base_url: str, page_num: int) -> str:
    """Build URL for a specific page number using query parameters."""
    parsed = urlparse(base_url)
    params = parse_qs(parsed.query)
    params["page"] = [str(page_num)]
    new_query = urlencode(params, doseq=True)
    return urlunparse(parsed._replace(query=new_query))


def fetch_all_pages(
    base_url: str,
    page_numbers: Set[int],
    content_selectors: List[str],
    fetcher: Callable[[str], str],
    logger: logging.Logger,
    first_page_html: str | None = None,
) -> str:
    """
    Fetch all pages and combine content.

    Args:
        base_url: Base article URL
        page_numbers: Set of page numbers to fetch
        content_selectors: CSS selectors for the content container
        fetcher: Function to fetch HTML from URL
        logger: Logger instance
        first_page_html: Already fetched HTML for the first page

    Returns:
        Combined HTML with content from all pages
    """
    sorted_pages = sorted(page_numbers)
    content_parts = []
    max_pages = len(sorted_pages)

    logger.info(f"Starting multi-page fetch: {max_pages} pages to fetch")

    for idx, page_num in enumerate(sorted_pages, 1):
        page_url = base_url if page_num == 1 else _build_page_url(base_url, page_num)

        try:
            if page_num == 1 and first_page_html:
                logger.debug(f"Using provided first page HTML for page {page_num}")
                page_html = first_page_html
            else:
                logger.debug(f"Fetching page {idx}/{max_pages} (page {page_num}): {page_url}")
                page_html = fetcher(page_url)
                logger.debug(f"Page {page_num}: HTML fetched ({len(page_html)} bytes)")

            # Extract content using the provided selectors (dedicated container: first match)
            soup = BeautifulSoup(page_html, "html.parser")
            matches = select_content_elements(soup, content_selectors, first_match_only=True)

            if matches:
                content_html = str(matches[0])
                content_parts.append(content_html)
                logger.debug(f"Page {page_num}: Content extracted ({len(content_html)} bytes)")
            else:
                logger.warning(f"Page {page_num}: No content found with {content_selectors}")

        except Exception as e:
            logger.error(f"Page {page_num}: Failed to fetch - {type(e).__name__}: {e}")
            continue

    if not content_parts:
        logger.error("Multi-page fetch: No content parts extracted from any page")
        return ""

    combined = "\n\n".join(content_parts)
    logger.info(
        f"Multi-page fetch complete: {len(content_parts)}/{max_pages} pages, "
        f"combined size {len(combined)} bytes"
    )
    return combined
