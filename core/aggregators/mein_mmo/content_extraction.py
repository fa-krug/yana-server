"""Mein-MMO content extraction logic."""

import logging
import re
from typing import Any, Dict, List

from bs4 import BeautifulSoup, Tag

from ..utils import clean_data_attributes, remove_empty_elements, sanitize_class_names
from ..utils.content_formatter import build_dailymotion_facade_html
from .embed_processors import process_embeds


def extract_mein_mmo_content(
    html: str, article: Dict[str, Any], selectors_to_remove: List[str], logger: logging.Logger
) -> str:
    """
    Extract and process Mein-MMO specific content.

    Steps:
    1. Parse HTML
    2. Find all content divs (multi-page support)
    3. Combine content from multiple pages
    4. Remove unwanted elements
    5. Process embeds (YouTube, Twitter, Reddit, Bluesky)
    6. Remove empty elements
    7. Clean data attributes
    8. Sanitize class names

    Args:
        html: HTML content (may contain multiple content divs for multi-page)
        article: Article dictionary
        selectors_to_remove: CSS selectors to remove
        logger: Logger instance

    Returns:
        Processed HTML content string
    """
    logger.debug(f"Starting content extraction for {article.get('identifier')}")
    soup = BeautifulSoup(html, "html.parser")

    # Find all content divs (multi-page articles have multiple)
    content_divs = soup.select("div.entry-content")
    logger.debug(f"Found {len(content_divs)} content div(s)")

    if not content_divs:
        logger.warning(f"No content divs found for {article.get('identifier')}, returning raw HTML")
        return html

    # Combine content from all pages
    if len(content_divs) > 1:
        logger.info(f"Multi-page article detected: combining {len(content_divs)} content divs")
        # Create wrapper div
        wrapper = soup.new_tag("div")
        wrapper["class"] = "entry-content"
        for div in content_divs:
            # Move all children to wrapper
            for child in list(div.children):
                wrapper.append(child)
        content = wrapper
        logger.debug(f"Combined content div created, size: {len(str(content))} bytes")
    else:
        content = content_divs[0]
        logger.debug("Single page article, using first content div")

    # Convert Dailymotion video blocks to playable iframes before removal
    process_dailymotion_blocks(content, logger)

    # Remove unwanted elements
    logger.debug(f"Removing unwanted elements using {len(selectors_to_remove)} selectors")
    removed_count = 0
    for selector in selectors_to_remove:
        elements = content.select(selector)
        for elem in elements:
            elem.decompose()
            removed_count += 1
    logger.debug(f"Removed {removed_count} unwanted elements")

    # Remove pagination markers like "Weiter geht es auf Seite 2."
    for em in content.find_all("em"):
        text = em.get_text()
        if text and "Weiter geht es auf Seite" in text:
            p_parent = em.find_parent("p")
            if p_parent:
                p_parent.decompose()
            else:
                em.decompose()
            removed_count += 1
    logger.debug(f"Removed pagination markers, total removed: {removed_count}")

    # Process embeds
    logger.debug("Processing embeds (YouTube, Twitter, Reddit, Bluesky)")
    process_embeds(content, logger)

    # Remove empty paragraphs and divs
    logger.debug("Removing empty paragraphs and divs")
    remove_empty_elements(content, ["p", "div"])

    # Clean data attributes (keep data-src and data-srcset for lazy loading)
    logger.debug("Cleaning data attributes (keeping data-src and data-srcset)")
    clean_data_attributes(content, keep=["data-src", "data-srcset"])

    # Sanitize class names
    logger.debug("Sanitizing class names")
    sanitize_class_names(content)

    result = str(content)
    logger.info(f"Content extraction complete: {len(result)} bytes")
    return result


def process_dailymotion_blocks(content: Tag, logger: logging.Logger) -> None:
    """
    Convert div.wp-block-mmo-video blocks to click-through Dailymotion facades.

    MeinMMO uses Dailymotion as their video provider. The video blocks contain
    a JavaScript-rendered player with the Dailymotion video ID in a script tag.
    This function extracts the video ID and replaces the block with a facade
    (see `build_dailymotion_facade_html`) that the block parser turns into a
    typed `embed` block for the client's own player.
    """
    video_blocks = content.select("div.wp-block-mmo-video")
    if not video_blocks:
        return

    logger.debug(f"Found {len(video_blocks)} Dailymotion video block(s)")

    soup = content.find_parent()
    if not soup:
        soup = BeautifulSoup("", "html.parser")
    elif not isinstance(soup, BeautifulSoup):
        curr = content
        while curr.parent:
            curr = curr.parent
        soup = curr if isinstance(curr, BeautifulSoup) else BeautifulSoup("", "html.parser")

    for idx, block in enumerate(video_blocks, 1):
        video_id = _extract_dailymotion_video_id(block)
        if not video_id:
            logger.debug(f"Dailymotion block {idx}: no video ID found, skipping")
            continue

        # Extract title from the thumbnail overlay
        title_div = block.select_one("div.title")
        title = title_div.get_text(strip=True) if title_div else ""

        # Wrap in container div. There is no iframe -- see
        # build_dailymotion_facade_html for why -- so the facade's own markup
        # (data-embed + watch-link anchor) is parsed into the wrapper directly
        # rather than built by hand here.
        # This class must never appear in the aggregator's selectors_to_remove:
        # that removal loop runs right after this function, and would delete
        # the very facade being built here.
        wrapper = soup.new_tag("div")
        wrapper["class"] = "dailymotion-embed-container"
        fragment = BeautifulSoup(build_dailymotion_facade_html(video_id), "html.parser")
        facade = fragment.find("div")
        assert isinstance(facade, Tag)  # build_dailymotion_facade_html always yields one
        wrapper["data-embed"] = facade["data-embed"]
        for child in list(facade.children):
            wrapper.append(child)

        # Add title as caption if available
        if title:
            caption = soup.new_tag("p")
            caption.string = title
            wrapper.append(caption)

        block.replace_with(wrapper)
        logger.debug(f"Dailymotion block {idx}: converted to a facade (video={video_id})")


def _extract_dailymotion_video_id(block: Tag) -> str | None:
    """Extract Dailymotion video ID from a wp-block-mmo-video block."""
    # The video ID is in a script tag: dmVideoId: 'x9yt07o'
    for script in block.find_all("script"):
        script_text = script.string or ""
        match = re.search(r"dmVideoId:\s*'([^']+)'", script_text)
        if match:
            return match.group(1)
    return None
