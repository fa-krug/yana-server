"""
Version 1 of the Yana content format on the wire.

Everything about this encoding is explicit, because the alternative -- Swift's
synthesized ``Codable`` output -- ties the format to compiler-internal shapes
(``{"paragraph": {"_0": [...]}}``) and an integer style bitmask that no
non-Swift client can read. Here every block carries a ``type`` discriminator,
``styles`` is a string array, and the version sits once on the envelope.

Two rules make the format extensible, and both are load-bearing on **both**
sides of the wire:

* an unknown block ``type`` is skipped, never fatal;
* an unknown style name is ignored, never fatal.

Optional values are ``null`` on the wire and ``""`` in the dataclasses.
"""

from typing import Any

from .types import (
    EMBED_PROVIDERS,
    FORMAT_VERSION,
    STYLE_NAMES,
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


class UnsupportedFormatVersion(ValueError):
    """The envelope's ``version`` is not one this build understands."""


def _or_none(value: str) -> str | None:
    return value or None


def encode_run(run: InlineRun) -> dict[str, Any]:
    return {"text": run.text, "styles": run.styles, "link": _or_none(run.link)}


def encode_block(block: Block) -> dict[str, Any]:
    match block:
        case Paragraph(runs=runs):
            return {"type": "paragraph", "runs": [encode_run(run) for run in runs]}
        case Heading(level=level, runs=runs):
            return {"type": "heading", "level": level, "runs": [encode_run(run) for run in runs]}
        case ListBlock(ordered=ordered, items=items):
            return {
                "type": "list",
                "ordered": ordered,
                "items": [[encode_block(inner) for inner in item] for item in items],
            }
        case Blockquote(blocks=blocks):
            return {"type": "blockquote", "blocks": [encode_block(inner) for inner in blocks]}
        case ImageBlock(ref=ref, caption=caption):
            return {"type": "image", "ref": ref, "caption": [encode_run(run) for run in caption]}
        case EmbedBlock(
            provider=provider, external_url=external_url, thumbnail_ref=thumbnail, title=title
        ):
            return {
                "type": "embed",
                "provider": provider,
                "thumbnailRef": _or_none(thumbnail),
                "externalURL": external_url,
                "title": _or_none(title),
            }
        case CodeBlock(text=text, language=language):
            return {"type": "codeBlock", "text": text, "language": _or_none(language)}
        case Divider():
            return {"type": "divider"}
    raise TypeError(f"not a block: {block!r}")


def encode_document(blocks: list[Block]) -> dict[str, Any]:
    """The full envelope: a version and a block array."""
    return {"version": FORMAT_VERSION, "blocks": [encode_block(block) for block in blocks]}


def _clamp_level(value: Any) -> int:
    try:
        level = int(value)
    except (TypeError, ValueError):
        return 1
    return min(max(level, 1), 6)


def decode_runs(items: Any) -> list[InlineRun]:
    runs: list[InlineRun] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        raw = item.get("styles") or []
        styles = {name for name in raw if name in STYLE_NAMES}
        runs.append(
            InlineRun(
                text=item.get("text") or "",
                bold="bold" in styles,
                italic="italic" in styles,
                code="code" in styles,
                strikethrough="strikethrough" in styles,
                link=item.get("link") or "",
            )
        )
    return runs


def decode_block(obj: Any) -> Block | None:
    """Decode one block, or ``None`` for anything unrecognized."""
    if not isinstance(obj, dict):
        return None
    match obj.get("type"):
        case "paragraph":
            return Paragraph(runs=decode_runs(obj.get("runs")))
        case "heading":
            return Heading(
                level=_clamp_level(obj.get("level", 1)), runs=decode_runs(obj.get("runs"))
            )
        case "list":
            return ListBlock(
                ordered=bool(obj.get("ordered", False)),
                items=[decode_blocks(item) for item in (obj.get("items") or [])],
            )
        case "blockquote":
            return Blockquote(blocks=decode_blocks(obj.get("blocks")))
        case "image":
            return ImageBlock(ref=obj.get("ref") or "", caption=decode_runs(obj.get("caption")))
        case "embed":
            provider = obj.get("provider") or "generic"
            return EmbedBlock(
                provider=provider if provider in EMBED_PROVIDERS else "generic",
                external_url=obj.get("externalURL") or "",
                thumbnail_ref=obj.get("thumbnailRef") or "",
                title=obj.get("title") or "",
            )
        case "codeBlock":
            return CodeBlock(text=obj.get("text") or "", language=obj.get("language") or "")
        case "divider":
            return Divider()
    return None


def decode_blocks(items: Any) -> list[Block]:
    """Decode a block array, dropping anything unrecognized."""
    decoded = (decode_block(item) for item in items or [])
    return [block for block in decoded if block is not None]


def decode_document(payload: dict[str, Any]) -> list[Block]:
    version = payload.get("version")
    if version != FORMAT_VERSION:
        raise UnsupportedFormatVersion(f"unsupported content format version: {version!r}")
    return decode_blocks(payload.get("blocks"))
