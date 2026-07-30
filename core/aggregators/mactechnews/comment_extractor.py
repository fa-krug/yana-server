"""Comment extraction for MacTechNews articles."""

import html
import logging
from typing import Optional

from bs4 import BeautifulSoup, Tag

from ..utils import clean_html, remove_sanitized_attributes, sanitize_html_attributes
from ..utils.block_parser import is_safe_url


def _comment_link(url: str, label: str) -> str:
    """Render a scraped comment/anchor link, or bare text if ``url`` uses an
    unsafe scheme (see ``is_safe_url``) -- escaping alone does not neutralize
    a well-formed ``javascript:`` href."""
    if is_safe_url(url):
        return f'<a href="{html.escape(url, quote=True)}">{label}</a>'
    return label


def _sanitize_comment_html(content_html: str) -> str:
    """Sanitize a scraped MacTechNews comment's *body* HTML before it is
    spliced into stored article content.

    ``content_html`` is genuine HTML (a formatted comment body), so it can't
    just be escaped -- that would turn it into literal text. It must be
    sanitized instead. ``clean_html()`` alone is NOT enough here: it only
    strips HTML comments, so a ``<script>``, an ``onerror=`` attribute, or a
    ``javascript:``/``data:`` href or img src would pass through it
    untouched. This layers on ``sanitize_html_attributes()`` (removes
    script/object/embed/style/iframe elements and every ``on*`` attribute)
    plus an explicit ``is_safe_url`` scheme check on every ``href``/``src``,
    which ``sanitize_html_attributes`` does not perform.
    """
    soup = BeautifulSoup(clean_html(content_html), "html.parser")
    sanitize_html_attributes(soup)
    remove_sanitized_attributes(soup)

    for tag in soup.find_all("a"):
        href = tag.get("href")
        if href and not is_safe_url(href):
            del tag["href"]

    for tag in soup.find_all("img"):
        src = tag.get("src")
        if src and not is_safe_url(src):
            tag.decompose()

    return str(soup)


def extract_comments(
    html: str,
    article_url: str,
    max_comments: int = 5,
    logger: Optional[logging.Logger] = None,
) -> Optional[str]:
    """
    Extract comments from MacTechNews article HTML.

    Comments are found within div.MtnCommentScroll containers. Each comment
    has author name, timestamp, and text content.

    Args:
        html: Full article HTML
        article_url: Article URL for building anchor links
        max_comments: Maximum number of comments to extract
        logger: Optional logger instance

    Returns:
        HTML string with formatted comments, or None if no comments found
    """
    if max_comments <= 0:
        return None

    if logger is None:
        logger = logging.getLogger(__name__)

    soup = BeautifulSoup(html, "html.parser")

    # Find the comments container
    comment_scroll = soup.select_one("div.MtnCommentScroll")
    if not comment_scroll:
        logger.debug("No MtnCommentScroll container found")
        return None

    # Find individual comments
    comments = comment_scroll.select("div.MtnComment")
    if not comments:
        logger.debug("No MtnComment elements found")
        return None

    logger.info(f"Found {len(comments)} comments, extracting up to {max_comments}")

    comment_parts = []
    for comment_el in comments[:max_comments]:
        comment_html = _process_comment(comment_el, article_url)
        if comment_html:
            comment_parts.append(comment_html)

    if not comment_parts:
        return None

    # Build comments section with header
    comments_url = f"{article_url}#comments"
    header = f"<h3>{_comment_link(comments_url, 'Comments')}</h3>"
    return f"<section>{header}{''.join(comment_parts)}</section>"


def _process_comment(comment_el: Tag, article_url: str) -> Optional[str]:
    """Process a single MacTechNews comment element into a blockquote."""
    # Extract author
    author_el = comment_el.select_one("span.MtnCommentAccountName")
    author = author_el.get_text(strip=True) if author_el else "Unknown"

    # Extract timestamp
    time_el = comment_el.select_one("span.MtnCommentTime")
    timestamp = ""
    if time_el:
        time_spans = time_el.find_all("span")
        timestamp = " ".join(span.get_text(strip=True) for span in time_spans)

    # Extract comment text
    text_el = comment_el.select_one("div.MtnCommentText")
    if not text_el:
        return None

    comment_text = str(text_el)

    # Build anchor URL from comment element ID
    comment_id = comment_el.get("id", "")
    anchor_url = f"{article_url}#{comment_id}" if comment_id else f"{article_url}#comments"

    # Format timestamp display
    ts_display = f" ({html.escape(timestamp, quote=True)})" if timestamp else ""

    # author and timestamp are plain scraped text (not HTML) so they are
    # escaped, not sanitized; comment_text is genuine scraped HTML (a
    # MacTechNews comment body) so it must be sanitized instead -- see
    # _comment_link / _sanitize_comment_html.
    return (
        f"<blockquote>"
        f"<p><strong>{html.escape(author, quote=True)}</strong>{ts_display} | "
        f"{_comment_link(anchor_url, 'source')}</p>"
        f"<div>{_sanitize_comment_html(comment_text)}</div>"
        f"</blockquote>"
    )
