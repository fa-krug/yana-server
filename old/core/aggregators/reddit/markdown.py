"""Reddit markdown conversion utilities."""

import html
import re
from typing import Optional

import markdown
from bs4 import BeautifulSoup, NavigableString, Tag

from ..utils import clean_html, remove_sanitized_attributes, sanitize_html_attributes
from ..utils.block_parser import is_safe_url
from .urls import decode_html_entities_in_url

# Configure markdown with extensions
# Python markdown extensions: fenced_code, tables, nl2br (if available), sane_lists
# Note: nl2br may not be available by default, we'll handle newlines manually if needed
try:
    _md = markdown.Markdown(
        extensions=[
            "fenced_code",  # Support ```code blocks```
            "tables",  # Support tables
            "sane_lists",  # Better list handling
            "nl2br",  # Convert newlines to <br>
        ]
    )
except Exception:
    # Fallback to basic markdown if extensions fail
    _md = markdown.Markdown()


def convert_reddit_markdown(text: str) -> str:
    """
    Convert Reddit markdown to HTML.

    Handles Reddit-specific markdown extensions like ^superscript,
    ~~strikethrough~~, >!spoilers!<, and Giphy embeds.
    Then converts standard markdown to HTML using markdown library.
    Finally, auto-links plain URLs and ensures all links open in a new tab.

    Args:
        text: Reddit markdown text

    Returns:
        HTML string
    """
    if not text:
        return ""

    # Limit input size to prevent regex DoS attacks
    MAX_TEXT_LENGTH = 100000  # 100KB limit
    if len(text) > MAX_TEXT_LENGTH:
        text = text[:MAX_TEXT_LENGTH]

    # Handle Reddit preview images. The URL comes straight from the source
    # markdown -- it can contain a literal quote that would otherwise break
    # out of the `src` attribute -- so it is escaped and scheme-checked via
    # safe_img_html rather than interpolated raw.
    text = re.sub(
        r"(?<!\[\(])https?://preview\.redd\.it/[^\s)]+",
        lambda m: safe_img_html(decode_html_entities_in_url(m.group(0)), "Reddit preview image"),
        text,
    )

    # Convert markdown links with preview.redd.it URLs to image tags. Same
    # reasoning as above: both the URL and the caption are attacker-controlled
    # markdown text.
    text = re.sub(
        r"\[([^\]]{0,200})\]\((https?://preview\.redd\.it/[^\s)]{1,500})\)",
        lambda m: safe_img_html(
            decode_html_entities_in_url(m.group(2)), m.group(1) or "Reddit preview image"
        ),
        text,
    )

    # Handle Giphy images
    text = re.sub(
        r"!\[([^\]]*)\]\(giphy\|([a-z0-9]+)(?:\|[^)]+)?\)",
        lambda m: f'<img src="https://i.giphy.com/{m.group(2)}.gif" alt="Giphy GIF">',
        text,
        flags=re.IGNORECASE,
    )

    # Match img tags with giphy URLs
    text = re.sub(
        r'<img\s+[^>]{0,200}src\s*=\s*["\']giphy\|([a-z0-9]{1,50})(?:\|[^"\']{0,100})?["\'][^>]{0,200}>',
        lambda m: f'<img src="https://i.giphy.com/{m.group(1)}.gif" alt="Giphy GIF">',
        text,
        flags=re.IGNORECASE,
    )

    text = re.sub(
        r"(?<![\"'])giphy\|([a-z0-9]+)(?![\"'])",
        lambda m: f'<img src="https://i.giphy.com/{m.group(1)}.gif" alt="Giphy GIF">',
        text,
        flags=re.IGNORECASE,
    )

    # Handle Reddit-specific superscript syntax (before markdown conversion)
    text = re.sub(r"\^(\w+)", r"<sup>\1</sup>", text)
    text = re.sub(r"\^\(([^)]+)\)", r"<sup>\1</sup>", text)

    # Handle strikethrough (before markdown conversion)
    text = re.sub(r"~~(.+?)~~", r"<del>\1</del>", text)

    # Handle spoiler syntax (before markdown conversion)
    text = re.sub(
        r">!(.+?)!<",
        r'<span class="spoiler" style="background: #000; color: #000;">\1</span>',
        text,
    )

    # Convert markdown to HTML using markdown library
    html_content = _md.convert(text)
    _md.reset()  # Reset for next use

    # Post-process to linkify plain URLs and add target="_blank"
    linked = linkify_html(html_content)

    # Sanitize once, here at the boundary where markdown-rendered HTML becomes
    # article content -- both build_post_content() (selftext) and
    # format_comment_html() (comments) call this function, so this is the one
    # seam both paths share. Reddit markdown can carry raw HTML verbatim (the
    # `markdown` library passes it straight through, unescaped) and arbitrary
    # link targets (linkify_html() above adds target/rel to every anchor it
    # finds, safe or not) -- neither is sanitized anywhere else downstream.
    return _sanitize_markdown_html(linked)


def linkify_html(html_content: str) -> str:
    """
    Linkify plain text URLs in HTML and ensure all links open in new tab.

    Args:
        html_content: HTML string

    Returns:
        Modified HTML string
    """
    if not html_content:
        return ""

    try:
        soup = BeautifulSoup(html_content, "html.parser")

        # 1. Linkify plain text URLs in text nodes
        # Regex to match URLs (simple version)
        url_pattern = re.compile(r'(https?://[^\s<"]+)')

        # Iterate over text nodes, skipping those inside 'a' tags
        for text_node in soup.find_all(string=True):
            if (
                isinstance(text_node, NavigableString)
                and text_node.parent
                and text_node.parent.name != "a"
            ):
                text = str(text_node)
                if url_pattern.search(text):
                    new_content = []
                    last_idx = 0
                    for match in url_pattern.finditer(text):
                        url = match.group(0)
                        # Strip trailing punctuation often included by simple regex
                        # e.g. "http://example.com." -> "http://example.com"
                        clean_url = re.sub(r"[.,;:!?)]+$", "", url)

                        # Add preceding text
                        if match.start() > last_idx:
                            new_content.append(text[last_idx : match.start()])

                        # Add link
                        link_tag = soup.new_tag(
                            "a", href=clean_url, target="_blank", rel="noopener"
                        )
                        link_tag.string = clean_url
                        new_content.append(link_tag)  # type: ignore

                        trailing_punct = url[len(clean_url) :]
                        if trailing_punct:
                            new_content.append(trailing_punct)

                        last_idx = match.end()

                    # Add remaining text
                    if last_idx < len(text):
                        new_content.append(text[last_idx:])

                    # Replace the text node with the new content
                    text_node.replace_with(*new_content)

        # 2. Add target="_blank" to all links (existing and new)
        for a in soup.find_all("a"):
            if isinstance(a, Tag):
                a["target"] = "_blank"
                a["rel"] = "noopener"

        return str(soup)

    except Exception:
        # Fallback to original content on error
        return html_content


def escape_html(text: str) -> str:
    """
    Escape HTML special characters.

    Args:
        text: Text to escape

    Returns:
        Escaped text
    """
    return html.escape(text)


def safe_link_html(url: Optional[str], text: str) -> str:
    """
    Render ``<a href target="_blank" rel="noopener">text</a>``, or ``text``
    (escaped, with no anchor) when ``url`` is missing or uses an unsafe scheme
    -- escaping the href alone does not neutralize a well-formed
    ``javascript:``/``data:`` URL (see ``is_safe_url``).

    ``url`` is checked as two separate ``if`` statements rather than combined
    with an ``or``: mypy narrows ``Optional[str]`` to ``str`` more reliably
    that way, and both `content.py` and `comments.py` pass values that really
    are ``str | None`` here (fields sourced straight from Reddit API data).
    """
    escaped_text = escape_html(text)
    if not url:
        return escaped_text
    if not is_safe_url(url):
        return escaped_text
    return (
        f'<a href="{html.escape(url, quote=True)}" target="_blank" rel="noopener">'
        f"{escaped_text}</a>"
    )


def safe_img_html(url: Optional[str], alt: str) -> str:
    """
    Render ``<img src alt>``, or ``""`` (skip the image entirely) when ``url``
    is missing or uses an unsafe scheme -- see ``safe_link_html`` for why an
    unsafe URL isn't merely escaped.
    """
    if not url:
        return ""
    if not is_safe_url(url):
        return ""
    return f'<img src="{html.escape(url, quote=True)}" alt="{html.escape(alt, quote=True)}">'


def _sanitize_markdown_html(content_html: str) -> str:
    """
    Sanitize markdown-rendered HTML before it is spliced into stored article
    content.

    Reddit markdown can carry raw HTML verbatim -- the ``markdown`` library
    passes a literal ``<script>`` or an ``onerror=`` attribute straight
    through unchanged -- and ``linkify_html`` above adds ``target``/``rel`` to
    every anchor it finds, including one with a ``javascript:``/``data:``
    href from a markdown link. ``clean_html()`` alone is NOT enough here: it
    only strips HTML comments. This layers on the same pipeline as heise's
    ``_sanitize_comment_html`` (``core/aggregators/heise/aggregator.py``):
    ``sanitize_html_attributes()`` (removes script/object/embed/style/iframe
    elements and every ``on*`` attribute) plus an explicit ``is_safe_url``
    scheme check on every ``href``/``src``, which ``sanitize_html_attributes``
    does not perform.
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
