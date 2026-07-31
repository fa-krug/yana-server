"""Mein-MMO utility functions."""

import logging
from typing import Optional

from bs4 import BeautifulSoup, Tag

from ..utils import get_attr_str


def extract_header_image_url(html: str, logger: logging.Logger) -> Optional[str]:
    """
    Extract header image URL from Mein-MMO article.

    Strategy:
    1. Look for img.wp-post-image inside div.post-thumbnail in header.entry-header
    2. Fallback: First img.wp-post-image anywhere on the page

    Args:
        html: Full HTML of article page
        logger: Logger instance

    Returns:
        Image URL or None
    """
    logger.debug("[extract_header_image_url] Starting header image extraction")
    soup = BeautifulSoup(html, "html.parser")

    # Strategy 1: Find wp-post-image inside the entry header's post-thumbnail
    logger.debug(
        "[extract_header_image_url] Strategy 1: Looking for img.wp-post-image in div.post-thumbnail"
    )
    post_thumbnail = soup.select_one("header.entry-header div.post-thumbnail")
    if isinstance(post_thumbnail, Tag):
        img = post_thumbnail.find("img", class_="wp-post-image")
        if isinstance(img, Tag):
            src = get_attr_str(img, "src")
            if src:
                logger.info(
                    f"[extract_header_image_url] Found header image in post-thumbnail: {src}"
                )
                return src
            else:
                logger.debug(
                    "[extract_header_image_url] Strategy 1: Image found but no src attribute"
                )

    # Strategy 2: Fallback to first wp-post-image on page
    logger.debug("[extract_header_image_url] Strategy 2: Looking for first img.wp-post-image")
    header_img = soup.select_one("img.wp-post-image")
    if isinstance(header_img, Tag):
        src = get_attr_str(header_img, "src")
        if src:
            logger.info(f"[extract_header_image_url] Found header image (wp-post-image): {src}")
            return src
        else:
            logger.debug("[extract_header_image_url] Strategy 2: Image found but no src attribute")

    logger.debug("[extract_header_image_url] No header image found using any strategy")
    return None
