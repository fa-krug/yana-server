"""
Render a block tree as plain HTML for the admin change page.

Admin is this phase's only verification surface, so this exists to make a wrong
conversion obvious by eye: a missing image, a paragraph that swallowed a
heading, chrome that survived extraction. It is not a client renderer and not a
serving path -- the client renders blocks natively.

All text goes through Django's escaping. Image refs are resolved against
``ArticleImage`` in one query so a dangling reference shows up as such rather
than as a broken image icon.
"""

from collections.abc import Sequence

from django.utils.html import escape, format_html
from django.utils.safestring import SafeString, mark_safe

from core.aggregators.services.image_store import IMAGE_REF_SCHEME
from core.models import ArticleImage

from .types import (
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


def _collect_refs(blocks: Sequence[Block], refs: set[str]) -> None:
    for block in blocks:
        match block:
            case ImageBlock(ref=ref):
                if ref.startswith(IMAGE_REF_SCHEME):
                    refs.add(ref.removeprefix(IMAGE_REF_SCHEME))
            case EmbedBlock(thumbnail_ref=thumbnail):
                if thumbnail.startswith(IMAGE_REF_SCHEME):
                    refs.add(thumbnail.removeprefix(IMAGE_REF_SCHEME))
            case ListBlock(items=items):
                for item in items:
                    _collect_refs(item, refs)
            case Blockquote(blocks=inner):
                _collect_refs(inner, refs)
            case _:
                pass


def _url_map(blocks: Sequence[Block]) -> dict[str, str]:
    refs: set[str] = set()
    _collect_refs(blocks, refs)
    if not refs:
        return {}
    return {
        image.content_hash: image.file.url
        for image in ArticleImage.objects.filter(content_hash__in=refs)
        if image.file
    }


def _resolve(ref: str, urls: dict[str, str]) -> str:
    if not ref.startswith(IMAGE_REF_SCHEME):
        return ref
    return urls.get(ref.removeprefix(IMAGE_REF_SCHEME), "")


def _render_runs(runs: Sequence[InlineRun]) -> str:
    parts: list[str] = []
    for run in runs:
        text = escape(run.text).replace("\n", "<br>")
        if run.code:
            text = f"<code>{text}</code>"
        if run.strikethrough:
            text = f"<s>{text}</s>"
        if run.italic:
            text = f"<em>{text}</em>"
        if run.bold:
            text = f"<strong>{text}</strong>"
        if run.link:
            text = (
                format_html('<a href="{}" target="_blank" rel="noopener">', run.link)
                + text
                + "</a>"
            )
        parts.append(text)
    return "".join(parts)


def _render(blocks: Sequence[Block], urls: dict[str, str]) -> str:
    parts: list[str] = []
    for block in blocks:
        match block:
            case Paragraph(runs=runs):
                parts.append(f"<p>{_render_runs(runs)}</p>")
            case Heading(level=level, runs=runs):
                parts.append(f"<h{level}>{_render_runs(runs)}</h{level}>")
            case ListBlock(ordered=ordered, items=items):
                tag = "ol" if ordered else "ul"
                inner = "".join(f"<li>{_render(item, urls)}</li>" for item in items)
                parts.append(f"<{tag}>{inner}</{tag}>")
            case Blockquote(blocks=inner_blocks):
                parts.append(
                    '<blockquote style="border-left:3px solid #ccc;margin:0;padding-left:12px;">'
                    f"{_render(inner_blocks, urls)}</blockquote>"
                )
            case ImageBlock(ref=ref, caption=caption):
                url = _resolve(ref, urls)
                if url:
                    media = format_html('<img src="{}" style="max-width:100%;height:auto;">', url)
                else:
                    media = format_html(
                        '<span style="color:#ba2121;">missing image: {}</span>', ref
                    )
                figcaption = f"<figcaption>{_render_runs(caption)}</figcaption>" if caption else ""
                parts.append(f"<figure>{media}{figcaption}</figure>")
            case EmbedBlock(
                provider=provider, external_url=external_url, thumbnail_ref=thumbnail, title=title
            ):
                poster_url = _resolve(thumbnail, urls) if thumbnail else ""
                poster = (
                    format_html(
                        '<img src="{}" style="max-height:140px;display:block;">', poster_url
                    )
                    if poster_url
                    else ""
                )
                parts.append(
                    '<div style="border:1px solid #ccc;padding:8px;margin:8px 0;">'
                    + format_html("<strong>{}</strong> embed", provider)
                    + (format_html(" &mdash; {}", title) if title else "")
                    + "<br>"
                    + format_html(
                        '<a href="{}" target="_blank" rel="noopener">{}</a>',
                        external_url,
                        external_url,
                    )
                    + poster
                    + "</div>"
                )
            case CodeBlock(text=text, language=language):
                label = format_html("<em>{}</em><br>", language) if language else ""
                parts.append(f'{label}<pre style="white-space:pre-wrap;">{escape(text)}</pre>')
            case Divider():
                parts.append("<hr>")
    return "".join(parts)


def render_blocks_html(blocks: Sequence[Block]) -> SafeString:
    """Render a block tree as simple HTML for admin inspection."""
    if not blocks:
        return mark_safe('<p style="color:#666;">No blocks stored for this article.</p>')
    body = _render(blocks, _url_map(blocks))
    return mark_safe(f'<div style="max-width:48em;">{body}</div>')
