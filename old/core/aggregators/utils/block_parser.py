"""
Convert the pipeline's already-sanitized article HTML into typed blocks.

The Python port of iOS's ``BlockParser``
(``../yana-ios/Yana/Aggregators/Utils/BlockParser.swift``), using BeautifulSoup
where the original uses SwiftSoup. This is the single HTML -> blocks conversion
point, run once at save time via ``core/blocks/conversion.py`` -- never on a
read path.

The walk maps known tags to blocks and handles everything else one of two ways,
and getting the distinction backwards is the classic failure mode:

* **dropped** -- ``form``, ``script`` and friends never hold body content, so
  they are skipped without recursing.
* **recursed** -- an unknown ``div``/``section``/``article`` may well wrap real
  content, so it is walked for known blocks and then discarded. ``header`` is
  recursed the same way, with one narrowing: it is the article's dedicated
  hero-media slot (see ``content_formatter.build_header_html``), and a plain
  image there is persisted separately to ``Article.icon``, so any ``image``
  block a header's subtree produces -- at any depth -- is dropped after the
  fact. Everything else a header holds survives, because some aggregators
  (Reddit's YouTube/tweet facade, Tagesschau's ``<video>``/``<audio>`` player)
  put content there that has nowhere else to live -- see ``_header_blocks``.
* **flattened** -- ``table`` and its row/cell tags do hold body content (a
  table-only article body is real), but there is no table block kind, so each
  ``tr`` collapses to one paragraph with its cells joined by an em dash; see
  ``_table_row_blocks``.

Whitespace is normalized to match SwiftSoup's ``TextNode.text()``. ``<pre>`` is
the one exception: its text is taken verbatim, because collapsing whitespace
destroys code indentation.
"""

import re
from collections.abc import Sequence
from dataclasses import replace
from typing import cast
from urllib.parse import urljoin, urlparse

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

from core.aggregators.services.image_store import IMAGE_REF_SCHEME
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

from .bs4_utils import get_attr_str

#: Tags whose content is purely inline, buffered into the surrounding paragraph.
INLINE_TAGS: frozenset[str] = frozenset(
    {
        "a", "b", "strong", "i", "em", "code", "span", "mark", "u", "s", "strike", "del",
        "sub", "sup", "small", "abbr", "cite", "q", "time", "label", "font", "ins", "var", "kbd",
    }
)  # fmt: skip

#: Tags dropped wholesale -- never recursed into (see the module docstring).
#: Table tags are deliberately absent: they hold real body content and are
#: flattened by ``_table_row_blocks`` instead of being dropped. ``header`` is
#: also deliberately absent: it is recursed into like any unknown wrapper, and
#: ``_header_blocks`` filters its *output* instead -- see the module docstring.
DROPPED_TAGS: frozenset[str] = frozenset(
    {
        "form", "input", "button", "select", "textarea", "script", "style",
        "noscript", "iframe", "audio", "svg", "canvas",
    }
)  # fmt: skip

_HEADING_TAGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}

#: Schemes a stored link is allowed to carry. Allowlisted, not blocklisted, so
#: `javascript:`, `data:`, `vbscript:` and `file:` are rejected without having
#: to enumerate every hostile scheme. No scheme at all (a relative or
#: scheme-relative URL) is permitted too -- those resolve against the
#: article's own URL and are how real relative links show up here.
_SAFE_URL_SCHEMES: frozenset[str] = frozenset({"http", "https", "mailto"})

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
    container = _select_container(soup)
    return _convert(container, base_url)


def _select_container(soup: BeautifulSoup) -> Tag:
    """
    Pick the root to walk: ``soup.body`` when it actually holds content,
    otherwise the whole soup.

    ``soup.body`` finds the *first* ``<body>`` tag in the tree, full document
    or not. For a genuine full document that is exactly right -- it excludes
    ``<head>`` junk like ``<title>`` that would otherwise leak into the
    article body. But sanitized article fragments can contain a stray
    ``<body>`` element that ``html.parser`` happily produces from malformed
    markup (observed mid-table, in a real article), and when that stray
    element is empty, treating it as the container silently discards the rest
    of the fragment -- total content loss with no error. So an empty
    ``<body>`` is treated the same as no ``<body>`` at all: fall back to the
    whole soup, which still contains everything (a ``<body>`` element with no
    special meaning of its own is walked like any other unknown wrapper).

    A *non-empty* ``<body>`` -- even one nested oddly inside a fragment with
    other content alongside it -- is still preferred over the whole soup. That
    keeps this a simple, predictable yes/no check (does ``<body>`` hold
    content) rather than a fuzzier "how much would we lose either way"
    comparison that risks regressing the ordinary full-document case, where
    content (``<head><title>``) always exists outside ``<body>`` too. The only
    real-world case this fixes had an empty stray ``<body>``; a non-empty one
    sitting beside sibling content is treated as an authoritative document
    boundary, same as a real document's ``<body>`` would be.
    """
    body = soup.body
    if body is not None and _has_direct_content(body):
        return body
    return soup


def _has_direct_content(tag: Tag) -> bool:
    """True if ``tag`` has a direct element child, or direct non-whitespace
    text -- markup nodes like ``Comment`` don't count as text."""
    for child in tag.children:
        if isinstance(child, Tag):
            return True
        if (
            isinstance(child, NavigableString)
            and not isinstance(child, _NON_TEXT_STRINGS)
            and child.strip()
        ):
            return True
    return False


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


def is_safe_url(url: str) -> bool:
    """
    True if ``url`` is safe to render as a clickable link.

    Used both here (to decide what gets stored as a run's ``link`` at all) and
    by ``core.blocks.render`` (to decide what gets rendered as an anchor for
    rows written before this check existed). See ``_SAFE_URL_SCHEMES``.
    """
    if not url:
        return False
    try:
        scheme = urlparse(url).scheme
    except ValueError:
        return False
    return not scheme or scheme.lower() in _SAFE_URL_SCHEMES


def _resolve_url(href: str, base_url: str) -> str:
    if href.startswith(IMAGE_REF_SCHEME):
        # Already a localized `yana-img://<hash>` ref -- not a URL scheme
        # `is_safe_url` recognizes, and re-resolving it against `base_url`
        # would be meaningless even if it were. Every already-stored image
        # ref in this pipeline goes through here (image `src`s share this
        # resolver with link `href`s -- see `_image_block`), so this must be
        # a pass-through, not a rejection.
        return href
    resolved = href
    if base_url:
        try:
            resolved = urljoin(base_url, href)
        except ValueError:
            resolved = href
    # A resolved URL with a dangerous scheme (`javascript:`, `data:`, ...) is
    # dropped here rather than stored -- these `link` values are also what a
    # future API serves to the iOS client, not just what admin renders.
    return resolved if is_safe_url(resolved) else ""


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


def _image_block(img: Tag, base_url: str) -> ImageBlock | None:
    """
    An ``<img>`` -> its block, or None when there is no usable source.

    ``src`` wins when present, then ``data-src``, then ``data-lazy-src`` --
    the same lazy-load fallback chain ``html_cleaner.remove_image_by_url`` and
    ``PageImagesStrategy`` already use elsewhere in this codebase, reused
    rather than invented fresh here. The chosen value is resolved the same
    way an ``<a href>`` is (see ``_resolve_url``): a relative path becomes
    absolute against ``base_url``, and a dangerous or unsupported scheme
    (`javascript:`, `data:`, ...) drops the image rather than storing it
    verbatim -- an already-localized ``yana-img://`` ref is the one scheme
    ``_resolve_url`` passes through untouched.
    """
    src = (
        get_attr_str(img, "src")
        or get_attr_str(img, "data-src")
        or get_attr_str(img, "data-lazy-src")
    )
    if not src:
        return None
    resolved = _resolve_url(src, base_url)
    if not resolved:
        return None
    return ImageBlock(ref=resolved)


def _has_dropped_ancestor(element: Tag, scanned: Tag) -> bool:
    """
    True if some ancestor of ``element``, strictly between it and ``scanned``,
    is a ``DROPPED_TAGS`` element.

    ``DROPPED_TAGS`` subtrees (``<noscript>`` fallbacks, ``<script>``, ...)
    never hold recoverable body content -- see the module docstring -- so an
    ``img``/``video`` a publisher tucks inside one (a ``<noscript>`` lazy-load
    fallback sitting next to the real, already-visible tag is a standard
    pattern) must not be recovered as a duplicate of the sibling that already
    is. Walks the whole chain, not just the immediate parent: the media can be
    nested arbitrarily deep inside the dropped subtree.
    """
    parent = element.parent
    while parent is not None and parent is not scanned:
        if (parent.name or "").lower() in DROPPED_TAGS:
            return True
        parent = parent.parent
    return False


def _recoverable_media(scanned: Tag) -> list[Tag]:
    """
    ``<img>``/``<video>`` descendants of ``scanned`` eligible for splitting out
    of running text, in document order -- excluding any living inside a
    ``DROPPED_TAGS`` subtree (see ``_has_dropped_ancestor``).
    """
    return [el for el in scanned.select("img, video") if not _has_dropped_ancestor(el, scanned)]


def _media_block(element: Tag, base_url: str) -> Block | None:
    """
    An ``<img>`` or ``<video>`` -> its block, dispatched by tag name.

    Shared by every path that recovers media split out of running text: the
    ``<p>`` branch, the ``INLINE_TAGS`` branch, and (via ``_convert``, since
    ``_figure_blocks`` no longer special-cases media) figures too.
    """
    tag = (element.name or "").lower()
    if tag == "img":
        return _image_block(element, base_url)
    if tag == "video":
        return _video_embed(element)
    return None


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
    """
    A ``<figure>`` -> its blocks, in document order, with any ``<figcaption>``
    reattached to the figure's own media rather than walked as a stray
    paragraph.

    A direct ``<figcaption>`` child only: a caption nested inside a figure
    *within* this figure describes that inner figure, not this one, and must
    be left for the recursive ``_convert`` call below to deal with on its own.
    """
    figcaption = _first(element, ":scope > figcaption")
    caption = _trimmed(_inline_runs(figcaption, base_url)) if figcaption is not None else []
    if figcaption is not None:
        # Pulled out of the tree before the walk below, so `_convert` doesn't
        # also emit it as a plain paragraph. `Tag.extract()` mutates the
        # parsed tree, which would be a bug in most places, but not here:
        # `blocks_from_html` parses a fresh `BeautifulSoup` per call and
        # nothing re-reads `element` after this function returns.
        figcaption.extract()

    blocks = _convert(element, base_url)

    if caption:
        # The figcaption describes the figure as a whole, but a block has one
        # caption slot each -- there is nowhere to attach a shared caption to
        # every item without duplicating it. Give it to the first image that
        # doesn't already carry one (an inner figure's own figcaption, just
        # attached by the recursive `_convert` call above, takes priority
        # over this one). If no image claims it -- a video-only figure, since
        # `EmbedBlock` has no caption slot, or a figure with no media at all
        # -- surface it as a trailing paragraph instead of losing the text.
        for block in blocks:
            if isinstance(block, ImageBlock) and not block.caption:
                block.caption = caption
                break
        else:
            blocks.append(Paragraph(runs=caption))

    return blocks


def _header_blocks(header: Tag, base_url: str) -> list[Block]:
    """
    A ``<header>`` -> its blocks, with every ``image`` block dropped at any
    depth.

    ``<header>`` is the article's dedicated hero-media slot (see
    ``content_formatter.build_header_html``): a plain image there is also
    persisted separately to ``Article.icon``, so surfacing it again here
    would duplicate it as the article's own leading body block. But a header
    is also where some aggregators put content that has nowhere else to
    live -- Reddit's YouTube/tweet facade, Tagesschau's ``<video>``/``<audio>``
    player -- and those must survive. The rule is about the ``image`` block
    *kind*, decided after conversion, not about sniffing whether a ref starts
    with ``yana-img://``: an already-localized ref and a remote one are
    dropped the same way, and an ``embed`` block is kept the same way
    regardless of what produced it.

    A nested ``<header>`` is walked by the same recursive ``_convert`` call
    this function starts with, so its own image is filtered out too, without
    any special-casing here.
    """
    return _drop_image_blocks(_convert(header, base_url))


def _drop_image_blocks(blocks: list[Block]) -> list[Block]:
    """
    Remove every ``ImageBlock``, at any depth -- see ``_header_blocks``.

    Recurses into ``ListBlock`` items and ``Blockquote`` contents, the only
    two kinds that nest further blocks; an item/quote left with nothing after
    filtering is dropped too, same as any other emptied container in this
    module.
    """
    kept: list[Block] = []
    for block in blocks:
        if isinstance(block, ImageBlock):
            continue
        if isinstance(block, ListBlock):
            items = [filtered for item in block.items if (filtered := _drop_image_blocks(item))]
            if items:
                block.items = items
                kept.append(block)
            continue
        if isinstance(block, Blockquote):
            inner = _drop_image_blocks(block.blocks)
            if inner:
                block.blocks = inner
                kept.append(block)
            continue
        kept.append(block)
    return kept


#: Separator joining a table row's cells into one paragraph -- see
#: ``_table_row_blocks``.
_TABLE_CELL_SEPARATOR = " — "


def _table_row_blocks(tr: Tag, base_url: str) -> list[Block]:
    """
    A ``<tr>`` -> its blocks: one paragraph with the row's cells joined by
    ``_TABLE_CELL_SEPARATOR`` (``<th>`` cells bolded), followed by any images
    the row's cells hold.

    There is no table block kind (see the module docstring), so a table is
    flattened rather than represented structurally. A nested ``<table>``
    inside a cell is pulled out of that cell before its text is built -- it is
    walked on its own via the ordinary recursive ``_convert``, so its rows
    become their own paragraphs (appended after this row's) instead of
    bleeding their text into this row's cell.

    Only direct ``<td>``/``<th>`` children count as this row's cells, the same
    "direct children only" rule ``_list_block`` uses for ``<li>``: a nested
    table's cells belong to its own rows, not this one.
    """
    cell_runs: list[list[InlineRun]] = []
    media_blocks: list[Block] = []
    nested_tables: list[Tag] = []

    for cell in tr.find_all(("td", "th"), recursive=False):
        for nested in cell.find_all("table"):
            nested.extract()
            nested_tables.append(nested)

        runs = _trimmed(_inline_runs(cell, base_url))
        if (cell.name or "").lower() == "th" and runs:
            runs = [replace(run, bold=True) for run in runs]
        if runs:
            cell_runs.append(runs)

        for media in _recoverable_media(cell):
            block = _media_block(media, base_url)
            if block is not None:
                media_blocks.append(block)

    combined: list[InlineRun] = []
    for index, runs in enumerate(cell_runs):
        if index:
            combined.append(InlineRun(text=_TABLE_CELL_SEPARATOR))
        combined.extend(runs)

    blocks: list[Block] = []
    if combined:
        blocks.append(Paragraph(runs=combined))
    blocks.extend(media_blocks)
    for nested in nested_tables:
        blocks.extend(_convert(nested, base_url))
    return blocks


_YOUTUBE_EMBED_ID = re.compile(r"(?:youtube\.com|youtube-nocookie\.com)/embed/([A-Za-z0-9_-]{6,})")
_YOUTUBE_WATCH_ID = re.compile(r"(?:youtube\.com/watch\?(?:.*&)?v=|youtu\.be/)([A-Za-z0-9_-]{6,})")
_DAILYMOTION_VIDEO_ID = re.compile(r"dailymotion\.com/(?:video|embed/video)/([A-Za-z0-9]+)")

#: Legacy id sources: Task 12 removed the proxy views and stopped producing
#: this markup, but articles converted before that removal have only a proxy
#: iframe in stored ``Article.content`` -- no ``data-embed``, no watch link --
#: and Task 10's backfill (plus the admin re-convert action and
#: ``convert_articles_to_blocks --force``) re-parses that stored HTML rather
#: than re-fetching from the source. Kept as the last-resort fallback in
#: ``_embed_facade``'s ``_first_match`` tuples below so that corpus keeps its
#: embeds. Safe to delete once ``Article.content`` itself is dropped (a
#: follow-up release per the spec), not before.
_YOUTUBE_PROXY_ID = re.compile(r"/api/youtube-proxy\?(?:.*&)?v=([A-Za-z0-9_-]{6,})")
_DAILYMOTION_PROXY_ID = re.compile(r"/api/dailymotion-proxy\?(?:.*&)?v=([A-Za-z0-9]+)")

_TWEET_HOST_SUFFIXES = ("twitter.com", "x.com", "fxtwitter.com")

#: Attributes an embed's class name can hide in: the sanitizer moves ``class``
#: to ``data-sanitized-class``, but not every path through the pipeline has run
#: the sanitizer by the time content is stored.
_CLASS_ATTRS = ("data-sanitized-class", "class")

#: Attributes that may carry the original player markup.
_EMBED_MARKUP_ATTRS = ("data-sanitized-data-embed-content", "data-embed", "data-sanitized-embed")


def _class_names(element: Tag) -> str:
    parts: list[str] = []
    for attr in _CLASS_ATTRS:
        value = element.get(attr)
        if isinstance(value, list):
            parts.extend(str(item) for item in value)
        elif value:
            parts.append(str(value))
    return " ".join(parts)


def _embed_markup(element: Tag) -> str:
    """Everything on this element or its descendants that could hold a video id."""
    parts: list[str] = []
    for candidate in (element, *element.find_all(True)):
        for attr in _EMBED_MARKUP_ATTRS:
            value = candidate.get(attr)
            if value:
                parts.append(str(value))
        if (candidate.name or "").lower() == "iframe":
            parts.append(str(candidate.get("src") or ""))
        if (candidate.name or "").lower() == "a":
            parts.append(str(candidate.get("href") or ""))
    return " ".join(parts)


def _first_match(patterns: Sequence[re.Pattern[str]], text: str) -> str:
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            return match.group(1)
    return ""


def _facade_thumbnail(element: Tag) -> str:
    img = _first(element, "img")
    return str(img.get("src") or "") if img is not None else ""


def _embed_facade(element: Tag) -> EmbedBlock | None:
    """
    Recognize this server's YouTube/Dailymotion embed wrappers.

    The video id is read from a stashed ``data-embed`` payload first -- that is
    what `build_youtube_facade_html`/`build_dailymotion_facade_html` emit, and
    what the current producers actually produce now that there is no proxy
    iframe -- with a descendant watch link as a fallback for content that took
    another route. The proxy-URL patterns are tried last: they are not a live
    producer any more, but articles converted before the proxy was removed
    have *only* a proxy iframe in stored ``Article.content`` (no ``data-embed``,
    no watch link), and re-parsing that stored HTML -- via Task 10's backfill,
    the admin re-convert action, or ``convert_articles_to_blocks --force`` --
    must still recover their embed. The result always carries the canonical
    public watch URL, never the proxy path.
    """
    classes = _class_names(element)
    is_youtube = "youtube-embed" in classes
    is_dailymotion = "dailymotion-embed" in classes
    if not (is_youtube or is_dailymotion):
        return None

    markup = _embed_markup(element)
    thumbnail = _facade_thumbnail(element)

    if is_youtube:
        video_id = _first_match((_YOUTUBE_EMBED_ID, _YOUTUBE_WATCH_ID, _YOUTUBE_PROXY_ID), markup)
        if video_id:
            return EmbedBlock(
                provider="youtube",
                external_url=f"https://www.youtube.com/watch?v={video_id}",
                thumbnail_ref=thumbnail,
            )
    else:
        video_id = _first_match((_DAILYMOTION_VIDEO_ID, _DAILYMOTION_PROXY_ID), markup)
        if video_id:
            return EmbedBlock(
                provider="dailymotion",
                external_url=f"https://www.dailymotion.com/video/{video_id}",
                thumbnail_ref=thumbnail,
            )
    return None


def _video_embed(element: Tag) -> EmbedBlock | None:
    """
    A ``<video>`` -> a ``video`` embed played by the client's own player.

    The stream URL comes from the first ``<source src>``, else the element's own
    ``src``; ``poster`` -- already a ``yana-img://`` ref when the aggregator
    localized it -- is the card thumbnail.
    """
    source = _first(element, "source")
    src = str(source.get("src") or "") if source is not None else ""
    if not src:
        src = str(element.get("src") or "")
    # No playable source, or an unplayable one -- `javascript:`/`data:`/etc are
    # not stream URLs, and a card with an unsafe `external_url` would be one
    # that goes nowhere, so this is "no embed", not "an embed with no link".
    if not src or not is_safe_url(src):
        return None
    return EmbedBlock(
        provider="video",
        external_url=src,
        thumbnail_ref=str(element.get("poster") or ""),
    )


def _tweet_embed(element: Tag) -> EmbedBlock | None:
    """
    A tweet card: ``build_tweet_embed_html`` renders a blockquote carrying a
    "View on X" link, so a blockquote that links to twitter/x is a tweet.
    """
    for anchor in element.find_all("a", href=True):
        href = str(anchor.get("href") or "")
        # Checked before the host match, not after: `urlparse` happily returns
        # a `twitter.com` hostname for a scheme like
        # `javascript://twitter.com/%0aalert(1)`, so the host check alone
        # cannot be trusted to keep a dangerous scheme out.
        if not is_safe_url(href):
            continue
        try:
            host = (urlparse(href).hostname or "").lower()
        except ValueError:
            continue
        if not host:
            continue
        if any(host == suffix or host.endswith(f".{suffix}") for suffix in _TWEET_HOST_SUFFIXES):
            title = element.get_text(" ", strip=True)
            return EmbedBlock(provider="tweet", external_url=href, title=title)
    return None


def _convert(container: Tag, base_url: str) -> list[Block]:
    blocks: list[Block] = []
    inline: list[InlineRun] = []
    # Media found inside an inline element (e.g. a lightbox `<a><img></a>`
    # with no `<p>`/`<figure>` ancestor) can't be spliced into `blocks`
    # immediately -- that would land it before text that is still buffering
    # in `inline` and hasn't been emitted as a paragraph yet. Queue it here
    # and let the next `flush()` place it right after the paragraph it was
    # found alongside.
    pending_media: list[Block] = []

    def flush() -> None:
        runs = _trimmed(inline)
        if runs:
            blocks.append(Paragraph(runs=runs))
        inline.clear()
        if pending_media:
            blocks.extend(pending_media)
            pending_media.clear()

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
            # _inline_runs drops media (cannot live inside a text run) --
            # recover it the same way the <p> branch does, so an image or
            # video wrapped in a lightbox anchor or other inline element
            # with no <p>/<figure> ancestor is not lost outright. Queued
            # rather than appended directly: see `pending_media` above.
            for media in _recoverable_media(node):
                block = _media_block(media, base_url)
                if block is not None:
                    pending_media.append(block)
            continue

        if tag == "br":
            inline.append(InlineRun(text="\n"))
            continue

        if tag == "p":
            flush()
            runs = _trimmed(_inline_runs(node, base_url))
            if runs:
                blocks.append(Paragraph(runs=runs))
            # _inline_runs drops media, so a paragraph that wraps it --
            # Reddit emits Giphy, gallery and inline images as exactly
            # <p><img></p>, and a <video> can appear the same way -- would
            # otherwise vanish. Split it out as its own block after the text,
            # in document order; a pure-media <p> yields just that block.
            # `_recoverable_media` also keeps a duplicate stashed in a
            # DROPPED_TAGS fallback (e.g. a <noscript> lazy-load twin) from
            # being emitted alongside the real one.
            for media in _recoverable_media(node):
                block = _media_block(media, base_url)
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
            tweet = _tweet_embed(node)
            if tweet is not None:
                blocks.append(tweet)
                continue
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
            block = _image_block(node, base_url)
            if block is not None:
                blocks.append(block)
            continue

        if tag == "video":
            flush()
            embed = _video_embed(node)
            if embed is not None:
                blocks.append(embed)
            continue

        if tag == "figure":
            flush()
            blocks.extend(_figure_blocks(node, base_url))
            continue

        if tag == "hr":
            flush()
            blocks.append(Divider())
            continue

        if tag == "tr":
            flush()
            blocks.extend(_table_row_blocks(node, base_url))
            continue

        if tag == "header":
            flush()
            blocks.extend(_header_blocks(node, base_url))
            continue

        # Unknown wrapper: an embed facade becomes an embed; otherwise walk it
        # for known blocks and discard the wrapper itself.
        flush()
        facade = _embed_facade(node)
        if facade is not None:
            blocks.append(facade)
            continue
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
