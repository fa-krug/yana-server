"""Comment extraction for Mein-MMO articles (wpDiscuz)."""

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
    """Sanitize a scraped wpDiscuz comment's *body* HTML before it is spliced
    into stored article content.

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
    Extract wpDiscuz comments from a Mein-MMO article page.

    Comments are server-rendered on the article page itself (outside the content
    div), so they survive selectors_to_remove and are read from the raw page
    HTML. Output mirrors the Heise/MacTechNews comment shape.

    Args:
        html: Full article page HTML
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

    thread = soup.select_one("div.wpd-thread-list")
    if not thread:
        logger.debug("No wpd-thread-list container found")
        return None

    comments = thread.select("div.wpd-comment")
    if not comments:
        logger.debug("No wpd-comment elements found")
        return None

    logger.info(f"Found {len(comments)} comments, extracting up to {max_comments}")

    comment_parts = []
    for comment_el in comments[:max_comments]:
        comment_html = _process_comment(comment_el, article_url)
        if comment_html:
            comment_parts.append(comment_html)

    if not comment_parts:
        return None

    comments_url = f"{article_url}#comments"
    header = f"<h3>{_comment_link(comments_url, 'Comments')}</h3>"
    return f"<section>{header}{''.join(comment_parts)}</section>"


def _process_comment(comment_el: Tag, article_url: str) -> Optional[str]:
    """Process a single wpDiscuz comment element into a blockquote.

    Every field is read with select_one *within* the comment element: in
    document order a parent's own fields precede any nested reply's, so this
    always resolves to this comment rather than a child.
    """
    author = "Unknown"
    author_el = comment_el.select_one("div.wpd-comment-author")
    if author_el:
        link = author_el.select_one("a")
        text = link.get_text(strip=True) if link else author_el.get_text(strip=True)
        if text:
            author = text

    timestamp = ""
    date_el = comment_el.select_one("div.wpd-comment-date")
    if date_el:
        title = date_el.get("title")
        if isinstance(title, list):
            title = title[0] if title else None
        timestamp = str(title) if title else date_el.get_text(strip=True)

    text_el = comment_el.select_one("div.wpd-comment-text")
    if not text_el:
        return None

    comment_text = text_el.decode_contents()
    if not comment_text.strip():
        return None

    anchor_url = f"{article_url}#comments"
    right_el = comment_el.select_one("div.wpd-comment-right")
    if right_el:
        comment_id = right_el.get("id")
        if isinstance(comment_id, list):
            comment_id = comment_id[0] if comment_id else None
        if comment_id:
            anchor_url = f"{article_url}#{comment_id}"

    ts_display = f" ({html.escape(timestamp, quote=True)})" if timestamp else ""

    # author and timestamp are plain scraped text (not HTML) so they are
    # escaped, not sanitized; comment_text is genuine scraped HTML (a
    # wpDiscuz comment body) so it must be sanitized instead -- see
    # _comment_link / _sanitize_comment_html.
    return (
        f"<blockquote>"
        f"<p><strong>{html.escape(author, quote=True)}</strong>{ts_display} | "
        f"{_comment_link(anchor_url, 'source')}</p>"
        f"<div>{_sanitize_comment_html(comment_text)}</div>"
        f"</blockquote>"
    )
