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
from .rss_parser import parse_rss_feed

__all__ = [
    "parse_rss_feed",
    "fetch_html",
    "convert_legacy_options",
    "revert_options",
    "extract_main_content",
    "DEFAULT_CONTENT_SELECTORS",
    "DEFAULT_IGNORE_SELECTORS",
    "IFRAME_SANITIZE_SELECTOR",
    "MANDATORY_REMOVE_SELECTORS",
    "extract_main_content_if_present",
    "select_content_elements",
    "clean_html",
    "remove_selectors",
    "remove_empty_elements",
    "clean_data_attributes",
    "remove_image_by_url",
    "sanitize_class_names",
    "sanitize_html_attributes",
    "remove_sanitized_attributes",
    "format_article_content",
    "get_attr_str",
    "get_attr_list",
]
