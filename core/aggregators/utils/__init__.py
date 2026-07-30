"""Utility modules for aggregators."""

from .bs4_utils import get_attr_list, get_attr_str
from .content_extractor import (
    DEFAULT_CONTENT_SELECTORS,
    DEFAULT_IGNORE_SELECTORS,
    IFRAME_SANITIZE_SELECTOR,
    MANDATORY_REMOVE_SELECTORS,
    extract_main_content,
    extract_main_content_if_present,
    select_content_elements,
)
from .content_formatter import format_article_content
from .favicon import best_icon_url, resolve_site_icon
from .feed_discovery import discover_feed_url, feed_url_in_html
from .feed_url_resolver import normalize, resolve_feed_url
from .html_cleaner import (
    clean_data_attributes,
    clean_html,
    remove_empty_elements,
    remove_image_by_url,
    remove_sanitized_attributes,
    remove_selectors,
    sanitize_class_names,
    sanitize_html_attributes,
)
from .html_fetcher import fetch_html
from .legacy_options import convert_legacy_options, revert_options
from .logo_background import remove_white_background
from .rss_parser import parse_rss_feed

__all__ = [
    "best_icon_url",
    "clean_data_attributes",
    "clean_html",
    "convert_legacy_options",
    "DEFAULT_CONTENT_SELECTORS",
    "DEFAULT_IGNORE_SELECTORS",
    "discover_feed_url",
    "extract_main_content",
    "extract_main_content_if_present",
    "feed_url_in_html",
    "fetch_html",
    "format_article_content",
    "get_attr_list",
    "get_attr_str",
    "IFRAME_SANITIZE_SELECTOR",
    "MANDATORY_REMOVE_SELECTORS",
    "normalize",
    "parse_rss_feed",
    "remove_empty_elements",
    "remove_image_by_url",
    "remove_sanitized_attributes",
    "remove_selectors",
    "remove_white_background",
    "resolve_feed_url",
    "resolve_site_icon",
    "revert_options",
    "sanitize_class_names",
    "sanitize_html_attributes",
    "select_content_elements",
]
