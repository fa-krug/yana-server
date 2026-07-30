"""
Convert the pipeline's already-sanitized article HTML into typed blocks.

The Python port of iOS's ``BlockParser``
(``../yana-ios/Yana/Aggregators/Utils/BlockParser.swift``), using BeautifulSoup
where the original uses SwiftSoup. This is the single HTML -> blocks conversion
point, run once at save time via ``core/blocks/conversion.py`` -- never on a
read path.

The walk maps known tags to blocks and handles everything else one of two ways,
and getting the distinction backwards is the classic failure mode:

* **dropped** -- ``table``, ``form``, ``script`` and friends never hold body
  content, so they are skipped without recursing. Recursing would surface table
  cells as stray paragraphs.
* **recursed** -- an unknown ``div``/``section``/``header``/``article`` may well
  wrap real content, so it is walked for known blocks and then discarded.

Whitespace is normalized to match SwiftSoup's ``TextNode.text()``. ``<pre>`` is
the one exception: its text is taken verbatim, because collapsing whitespace
destroys code indentation.
"""

import re
from collections.abc import Sequence
from typing import cast
from urllib.parse import urljoin

from bs4 import (
    BeautifulSoup,
    CData,
    Comment,
    Declaration,
    Doctype,
    NavigableString,
    ProcessingInstruction,
    Tag,
)

from core.blocks.types import (
    Block,
    Blockquote,
    CodeBlock,
    Divider,
    EmbedBlock,
    Heading,
    ImageBlock,
    InlineRun,
    ListBlock,
    Paragraph,
)

#: Tags whose content is purely inline, buffered into the surrounding paragraph.
INLINE_TAGS: frozenset[str] = frozenset(
    {
        "a", "b", "strong", "i", "em", "code", "span", "mark", "u", "s", "strike", "del",
        "sub", "sup", "small", "abbr", "cite", "q", "time", "label", "font", "ins", "var", "kbd",
    }
)  # fmt: skip

#: Tags dropped wholesale -- never recursed into (see the module docstring).
DROPPED_TAGS: frozenset[str] = frozenset(
    {
        "table", "thead", "tbody", "tfoot", "tr", "td", "th", "form", "input", "button", "select",
        "textarea", "script", "style", "noscript", "iframe", "audio", "svg", "canvas",
    }
)  # fmt: skip

_HEADING_TAGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}

#: bs4 string subclasses that are markup, not text. ``Comment`` and friends are
#: ``NavigableString`` subclasses, so they must be rejected before the
#: text-node check or an HTML comment becomes visible body text.
_NON_TEXT_STRINGS = (Comment, Doctype, CData, Declaration, ProcessingInstruction)

_WHITESPACE = re.compile(r"\s+")


def blocks_from_html(html: str, base_url: str = "") -> list[Block]:
    """
    Parse sanitized article HTML into blocks.

    ``base_url`` (the article URL) resolves relative link ``href``s to absolute
    URLs so a native client's taps open the right page.
    """
    if not html or not html.strip():
        return []
    soup = BeautifulSoup(html, "html.parser")
    container = soup.body or soup
    return _convert(container, base_url)


def plain_text(blocks: Sequence[Block]) -> str:
    """
    Flatten blocks to visible text -- what ``Article.plain_text`` stores for
    search. Sections are separated by blank lines; empty segments are skipped.
    """
    parts: list[str] = []

    def runs_text(runs: Sequence[InlineRun]) -> str:
        return "".join(run.text for run in runs)

    def walk(items: Sequence[Block]) -> None:
        for block in items:
            match block:
                case Paragraph(runs=runs) | Heading(runs=runs):
                    parts.append(runs_text(runs))
                case ListBlock(items=list_items):
                    for item in list_items:
                        walk(item)
                case Blockquote(blocks=inner):
                    walk(inner)
                case ImageBlock(caption=caption):
                    caption_text = runs_text(caption)
                    if caption_text:
                        parts.append(caption_text)
                case EmbedBlock(title=title):
                    if title:
                        parts.append(title)
                case CodeBlock(text=text):
                    parts.append(text)
                case Divider():
                    pass

    walk(blocks)
    return "\n\n".join(stripped for stripped in (part.strip() for part in parts) if stripped)


def _normalize(text: str) -> str:
    """Collapse whitespace runs, as SwiftSoup's ``TextNode.text()`` does."""
    return _WHITESPACE.sub(" ", text)


def _make_run(text: str, styles: frozenset[str], link: str) -> InlineRun:
    return InlineRun(
        text=text,
        bold="bold" in styles,
        italic="italic" in styles,
        code="code" in styles,
        strikethrough="strikethrough" in styles,
        link=link,
    )


def _resolve_url(href: str, base_url: str) -> str:
    if not base_url:
        return href
    try:
        return urljoin(base_url, href)
    except ValueError:
        return href


def _trimmed(runs: Sequence[InlineRun]) -> list[InlineRun]:
    """Drop empty runs and strip whitespace-only runs off both ends."""
    result = [run for run in runs if run.text]
    while result and not result[0].text.strip():
        result.pop(0)
    while result and not result[-1].text.strip():
        result.pop()
    return result


def _child_nodes(container: Tag) -> list[Tag | NavigableString]:
    # bs4's stubs type `.children` as the broader `PageElement`; every real
    # child of a parsed document is a `Tag` or `NavigableString`, and the
    # isinstance checks in the callers narrow it immediately.
    return cast("list[Tag | NavigableString]", list(container.children))


def _first(element: Tag, selector: str) -> Tag | None:
    """The first descendant matching ``selector``, or None."""
    return element.select_one(selector)


def _image_block(img: Tag, caption: Sequence[InlineRun] = ()) -> ImageBlock | None:
    src = str(img.get("src") or "")
    if not src:
        return None
    return ImageBlock(ref=src, caption=list(caption))


def _list_block(element: Tag, ordered: bool, base_url: str) -> ListBlock | None:
    """
    A ``ul``/``ol`` -> a list block, or None when nothing survives.

    Only *direct* ``li`` children count: a nested list belongs to its own item,
    not to the outer list. Empty items are dropped and an emptied list is
    skipped entirely, because a persisted empty block renders as a blank gap.
    """
    items: list[list[Block]] = []
    for li in element.find_all("li", recursive=False):
        item = _convert(li, base_url)
        if item:
            items.append(item)
    if not items:
        return None
    return ListBlock(ordered=ordered, items=items)


def _figure_blocks(element: Tag, base_url: str) -> list[Block]:
    img = _first(element, "img")
    if img is not None:
        figcaption = _first(element, "figcaption")
        caption = _trimmed(_inline_runs(figcaption, base_url)) if figcaption is not None else []
        block = _image_block(img, caption)
        if block is not None:
            return [block]
    return _convert(element, base_url)


def _convert(container: Tag, base_url: str) -> list[Block]:
    blocks: list[Block] = []
    inline: list[InlineRun] = []

    def flush() -> None:
        runs = _trimmed(inline)
        if runs:
            blocks.append(Paragraph(runs=runs))
        inline.clear()

    for node in _child_nodes(container):
        if isinstance(node, _NON_TEXT_STRINGS):
            continue
        if isinstance(node, NavigableString):
            text = _normalize(str(node))
            if text.strip():
                inline.append(InlineRun(text=text))
            elif inline:
                inline.append(InlineRun(text=" "))
            continue
        if not isinstance(node, Tag):
            continue

        tag = (node.name or "").lower()

        if tag in DROPPED_TAGS:
            continue

        if tag in INLINE_TAGS:
            inline.extend(_inline_runs(node, base_url))
            continue

        if tag == "br":
            inline.append(InlineRun(text="\n"))
            continue

        if tag == "p":
            flush()
            runs = _trimmed(_inline_runs(node, base_url))
            if runs:
                blocks.append(Paragraph(runs=runs))
            # _inline_runs drops images, so a paragraph that wraps media --
            # Reddit emits Giphy, gallery and inline images as exactly
            # <p><img></p> -- would otherwise vanish. Split them out as their
            # own blocks after the text; a pure-image <p> yields just the image.
            for img in node.select("img"):
                block = _image_block(img)
                if block is not None:
                    blocks.append(block)
            continue

        if tag in _HEADING_TAGS:
            flush()
            runs = _trimmed(_inline_runs(node, base_url))
            if runs:
                blocks.append(Heading(level=_HEADING_TAGS[tag], runs=runs))
            continue

        if tag in ("ul", "ol"):
            flush()
            list_block = _list_block(node, ordered=tag == "ol", base_url=base_url)
            if list_block is not None:
                blocks.append(list_block)
            continue

        if tag == "blockquote":
            flush()
            inner = _convert(node, base_url)
            if inner:
                blocks.append(Blockquote(blocks=inner))
            continue

        if tag == "pre":
            flush()
            # get_text(), not the normalized path: collapsing whitespace here
            # would destroy the indentation that makes a code block readable.
            text = node.get_text()
            if text.strip():
                blocks.append(CodeBlock(text=text))
            continue

        if tag == "img":
            flush()
            block = _image_block(node)
            if block is not None:
                blocks.append(block)
            continue

        if tag == "figure":
            flush()
            blocks.extend(_figure_blocks(node, base_url))
            continue

        if tag == "hr":
            flush()
            blocks.append(Divider())
            continue

        # Unknown wrapper: walk it for known blocks, then discard the wrapper.
        flush()
        blocks.extend(_convert(node, base_url))

    flush()
    return blocks


def _inline_runs(
    element: Tag,
    base_url: str,
    styles: frozenset[str] = frozenset(),
    link: str = "",
) -> list[InlineRun]:
    runs: list[InlineRun] = []
    for node in _child_nodes(element):
        if isinstance(node, _NON_TEXT_STRINGS):
            continue
        if isinstance(node, NavigableString):
            text = _normalize(str(node))
            if text:
                runs.append(_make_run(text, styles, link))
            continue
        if not isinstance(node, Tag):
            continue

        tag = (node.name or "").lower()
        if tag in DROPPED_TAGS:
            continue
        if tag == "br":
            runs.append(_make_run("\n", styles, link))
            continue
        if tag in ("img", "video"):
            # Media cannot live inside a text run. The block walk re-extracts
            # images as standalone image blocks and videos as embeds; skipping
            # here also keeps a <video>'s "your browser does not support..."
            # fallback text out of the body.
            continue

        child_styles = styles
        child_link = link
        match tag:
            case "b" | "strong":
                child_styles = styles | {"bold"}
            case "i" | "em" | "cite" | "var":
                child_styles = styles | {"italic"}
            case "code" | "kbd":
                child_styles = styles | {"code"}
            case "s" | "strike" | "del":
                child_styles = styles | {"strikethrough"}
            case "a":
                href = str(node.get("href") or "")
                if href:
                    child_link = _resolve_url(href, base_url)

        runs.extend(_inline_runs(node, base_url, child_styles, child_link))
    return runs
