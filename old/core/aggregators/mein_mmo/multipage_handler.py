"""Multi-page article detection and fetching for Mein-MMO."""

import logging
import re
from typing import Callable, Set

from bs4 import BeautifulSoup

from ..utils import get_attr_str


def detect_pagination(html: str, logger: logging.Logger) -> Set[int]:
    """
    Detect page numbers from pagination elements.

    Looks for:
    - div.page-links (new layout: contains a.post-page-numbers and span.post-page-numbers)

    Args:
        html: HTML content to parse
        logger: Logger instance

    Returns:
        Set of page numbers (always includes 1)
    """
    soup = BeautifulSoup(html, "html.parser")
    page_numbers = {1}  # Always include page 1

    logger.debug("Starting pagination detection")

    # Try to find pagination within the content area first to avoid header/footer pagination
    content_div = soup.select_one("div.entry-content")

    pagination = None
    if content_div:
        pagination = content_div.select_one("div.page-links")

    # Fallback to global search if not found in content div
    if not pagination:
        pagination = soup.select_one("div.page-links")

    if not pagination:
        logger.debug("No pagination container found, assuming single page")
        return page_numbers

    logger.debug(
        f"Found pagination container: {pagination.name}.{'.'.join(pagination.get('class', []))}"
    )

    # Extract page numbers from links (a.post-page-numbers)
    logger.debug("Extracting page numbers from links")
    for link in pagination.select("a.post-page-numbers"):
        text = link.get_text(strip=True)
        if text.isdigit():
            page_numbers.add(int(text))
            logger.debug(f"Found page number from link text: {text}")

        # Try URL pattern: /article-name/2/
        href = get_attr_str(link, "href")
        if href:
            match = re.search(r"/(\d+)/?$", href)
            if match:
                page_num = int(match.group(1))
                page_numbers.add(page_num)
                logger.debug(f"Found page number from URL pattern: {page_num}")

    # Extract current page from spans (span.post-page-numbers.current)
    logger.debug("Extracting current page from spans")
    for span in pagination.select("span.post-page-numbers"):
        text = span.get_text(strip=True)
        if text.isdigit():
            page_numbers.add(int(text))
            logger.debug(f"Found page number from span: {text}")

    sorted_pages = sorted(page_numbers)
    logger.info(f"Pagination detection complete: {len(page_numbers)} pages found - {sorted_pages}")
    return page_numbers


def fetch_all_pages(
    base_url: str,
    page_numbers: Set[int],
    fetcher: Callable[[str], str],
    logger: logging.Logger,
    first_page_html: str | None = None,
) -> str:
    """
    Fetch all pages and combine content divs.

    Args:
        base_url: Base article URL
        page_numbers: Set of page numbers to fetch
        fetcher: Function to fetch HTML from URL
        logger: Logger instance
        first_page_html: Already fetched HTML for the first page

    Returns:
        Combined HTML with all content divs
    """
    sorted_pages = sorted(page_numbers)
    content_parts = []
    max_pages = len(sorted_pages)

    logger.info(f"Starting multi-page fetch: {max_pages} pages to fetch")

    for idx, page_num in enumerate(sorted_pages, 1):
        # Construct page URL
        if page_num == 1:
            page_url = base_url
        else:
            # Handle trailing slash
            if base_url.endswith("/"):
                page_url = f"{base_url}{page_num}/"
            else:
                page_url = f"{base_url}/{page_num}/"

        try:
            if page_num == 1 and first_page_html:
                logger.debug(f"Using provided first page HTML for page {page_num}")
                page_html = first_page_html
            else:
                logger.debug(f"Fetching page {idx}/{max_pages} (page {page_num}): {page_url}")
                page_html = fetcher(page_url)
                logger.debug(f"Page {page_num}: HTML fetched ({len(page_html)} bytes)")

            # Extract content div
            soup = BeautifulSoup(page_html, "html.parser")
            content_div = soup.select_one("div.entry-content")

            if content_div:
                content_html = str(content_div)
                content_parts.append(content_html)
                logger.debug(f"Page {page_num}: Content div extracted ({len(content_html)} bytes)")
            else:
                logger.warning(f"Page {page_num}: No content div found (skipping)")

        except Exception as e:
            logger.error(f"Page {page_num}: Failed to fetch - {type(e).__name__}: {e}")
            continue

    if not content_parts:
        logger.error("Multi-page fetch: No content parts extracted from any page")
        return ""

    combined = "\n\n".join(content_parts)
    logger.info(
        f"Multi-page fetch complete: {len(content_parts)}/{max_pages} pages fetched, combined size {len(combined)} bytes"
    )
    return combined
