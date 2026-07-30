# Yana Content Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store article bodies as the Yana content format — typed block trees in `ArticleBlock` /
`ArticleInlineRun` rows, pinned by an explicit versioned JSON schema — instead of relying on
`Article.content` HTML.

**Architecture:** Three layers that do not import each other sideways. `core/blocks/types.py` holds
plain dataclasses (`Paragraph`, `Heading`, `ListBlock`, …, `InlineRun`) with no HTML, no ORM and no
I/O. `core/blocks/schema.py` encodes and decodes those dataclasses to the pinned wire JSON
(`{"version": 1, "blocks": [...]}`, explicit `type` discriminator, string style names).
`core/blocks/storage.py` writes and reads them as rows. `core/aggregators/utils/block_parser.py` is
the Python port of iOS's `BlockParser` — sanitized HTML in, dataclasses out. One entry point,
`core/blocks/conversion.py::convert_article`, glues parse → store → `plain_text` and is called from
every article-persisting path plus a backfill command and an admin action. Admin gains a read-only
block inline and a rendered preview, because admin is this phase's only verification surface.

**Tech Stack:** Python 3.13, Django 6.0, SQLite (custom tuned backend), BeautifulSoup 4
(`html.parser`) where iOS uses SwiftSoup, pytest + pytest-django.

**Spec:** `docs/superpowers/specs/2026-07-29-yana-content-format-design.md` (Spec 5)
**Direction:** `docs/superpowers/specs/2026-07-29-client-server-remigration-direction.md`
**Depends on:** Spec 4 (image hosting — landed; `yana-img://<sha256>` is what `image_ref` holds)
**Swift reference:** `../yana-ios/Yana/Aggregators/Utils/BlockParser.swift` (332 lines),
`../yana-ios/Yana/Reader/Block.swift` (74 lines)

## Global Constraints

- Python 3.13+, Django 6.0. SQLite only, via the custom backend — no other engine.
- Line length 100. Double quotes. `uv run ruff check core/ --fix`, `uv run ruff format core/`,
  `uv run mypy core/`, `uv run pytest` must all pass before a task is done.
- Every command runs through `uv run` — no venv activation, no bare `python`.
- Format version is `1`, on the envelope only, never per block.
- Wire keys are exactly as pinned: `type`, `runs`, `level`, `ordered`, `items`, `blocks`, `ref`,
  `caption`, `provider`, `thumbnailRef`, `externalURL`, `title`, `text`, `language`. Note the
  camelCase on `thumbnailRef` / `externalURL`, and that the code-block wire type is `codeBlock`
  while its storage kind is `code_block`.
- `styles` is a **string array** — valid members `bold`, `italic`, `code`, `strikethrough`. Never an
  int bitmask.
- `provider` is one of `youtube`, `dailymotion`, `video`, `tweet`, `generic`.
- Heading `level` is clamped 1–6 by the producer.
- Unknown block `type` on decode is **skipped, not fatal**. Unknown style names are ignored. This is
  what makes adding a block kind later a non-breaking change.
- Image references are exactly `yana-img://<64 lowercase hex>` — Spec 4's scheme, unchanged.
- `Article.date` semantics are untouched (feed publish time, never rewritten). `created_at` remains
  the ordering/retention key.
- `Article.content` and `Article.raw_content` are **kept and still populated**. Dropping `content` is
  a follow-up once blocks are trusted, explicitly out of scope here.
- Blocks are **derived data**: read-only in admin, rebuilt wholesale on re-conversion, never
  hand-edited.
- Tests live in `core/tests/test_*.py` and use `core/tests/conftest.py` fixtures (`user`,
  `rss_feed`, `article`, `articles_batch`, …). Coverage target >80%.
- Tests that write image files must isolate `MEDIA_ROOT` via `settings`/`tmp_path`. Never write into
  the repo's `media/`.
- Commit messages: `<type>(<scope>): <Description>` — e.g. `feat(blocks): Add the ArticleBlock model`.

## Out of scope / handoff

- **The iOS side of Part 1** (explicit `init(from:)` / `encode(to:)` for `Block`, `Embed`,
  `InlineRun`, `InlineStyle`, plus a `BlockMigration` sweep for already-stored `Article.blockData`)
  lands in the **iOS repo**, not here. This plan's deliverable for that contract is the golden
  fixture `core/tests/fixtures/blocks_golden_v1.json` (Task 1) — the artifact both sides test
  against.
- The API that serves blocks (its own spec), dropping `Article.content`, new block kinds (tables,
  footnotes), server-side block → HTML rendering for clients, and FTS5 over `plain_text`.

---

## Deviations from the spec (deliberate, reviewed)

1. **The embed facade on the server is not iOS's facade.** Spec 5 describes reading the video id from
   a `data-embed` attribute, because that is what iOS's `EmbedRewriter` emits. This server emits
   `<div class="youtube-embed-container"><iframe src="{BASE_URL}/api/youtube-proxy?v=<id>">` (see
   `core/aggregators/utils/youtube.py::create_youtube_embed_html`, `mein_mmo/embed_processors.py`,
   `mein_mmo/content_extraction.py::process_dailymotion_blocks`), and
   `html_cleaner.sanitize_html_attributes` deliberately **keeps** iframes whose `src` contains
   `/api/youtube-proxy` or `/api/dailymotion-proxy` while dropping all others. So the parser reads
   the id from the proxy URL first, then from `data-embed` / `data-sanitized-data-embed-content`,
   then from a descendant watch link. All three are implemented; the proxy path is the one that
   actually fires today.
2. **The proxy *URL* outlives the proxy *view*.** Task 12 deletes `youtube_proxy_view` /
   `dailymotion_proxy_view` and their routes as the spec requires, but leaves
   `create_youtube_embed_html`, `get_youtube_proxy_url`, the Dailymotion equivalent and the
   `html_cleaner` iframe allowlist alone. That markup is now a pure internal marker between
   extraction and block conversion — never fetched, because the parser rewrites it to a canonical
   `https://www.youtube.com/watch?v=<id>` before anything stores it. Rewriting the producers instead
   would touch five aggregators and ~13 tests for no behavioral gain.
3. **`<pre>` keeps its whitespace.** iOS's `codeBlock` text comes from SwiftSoup's `text()`, which
   collapses whitespace — that destroys code indentation. The Python port uses BeautifulSoup's
   `get_text()` for `<pre>` only, preserving it. Whitespace *is* normalized everywhere else, to match
   SwiftSoup's `TextNode.text()`.
4. **An empty `list` is not persisted.** Swift appends `.list` unconditionally even with zero items;
   Spec 5's error-handling section says empty blocks are not persisted. The spec wins: empty items are
   dropped and a list with no surviving items is skipped.
5. **`prune_orphaned_images` keeps a content-scan fallback.** The spec calls for rewriting it against
   the `image_ref` index. It is rewritten — but the referenced-hash set is the union of
   `ArticleBlock.image_ref`, `ArticleBlock.embed_thumbnail_ref` (also a `yana-img://` ref, which the
   spec's note omits) **and** a `content` scan restricted to articles that have no blocks. Without
   that last part, an article whose conversion failed would have its images reaped while `content`
   still references them.
6. **`convert_articles_to_blocks` gains `--force`.** The spec's command skips articles that already
   have blocks. Re-converting the whole corpus after a parser change is the real iteration loop, and
   the admin action only covers hand-picked rows, so an explicit opt-in flag is included. Default
   behavior is exactly as specced.
7. **`core/blocks/__init__.py` stays empty.** `conversion.py` imports the parser, the parser imports
   `core.blocks.types`, and importing any submodule executes the package `__init__` — so re-exporting
   `conversion` from `__init__` would be a genuine import cycle. Every consumer imports the submodule
   directly.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `core/blocks/__init__.py` | Package docstring only (see deviation 7) |
| `core/blocks/types.py` | The dataclasses + `FORMAT_VERSION`, `STYLE_NAMES`, `EMBED_PROVIDERS`, `BLOCK_KINDS`. No imports beyond `dataclasses`/`typing` |
| `core/blocks/schema.py` | Pinned wire JSON: `encode_document`, `encode_block`, `decode_document`, `decode_block` |
| `core/blocks/storage.py` | Rows ↔ dataclasses: `write_blocks`, `load_blocks`, `load_blocks_for_articles` |
| `core/blocks/conversion.py` | `convert_article(article)` — the one parse → store → `plain_text` entry point |
| `core/blocks/render.py` | `render_blocks_html(blocks)` — the admin preview |
| `core/aggregators/utils/block_parser.py` | `blocks_from_html(html, base_url)`, `plain_text(blocks)` |
| `core/management/commands/convert_articles_to_blocks.py` | Backfill |
| `core/migrations/0035_*.py` | `ArticleBlock`, `ArticleInlineRun`, `Article.plain_text` |
| `core/tests/fixtures/blocks_golden_v1.json` | The shared cross-language contract fixture |
| `core/tests/test_block_schema.py`, `test_block_parser.py`, `test_block_models.py`, `test_block_storage.py`, `test_block_conversion.py`, `test_block_admin.py`, `test_convert_articles_to_blocks.py` | Tests |

**Modified**

| File | Change |
|---|---|
| `core/models.py` | `ArticleBlock`, `ArticleInlineRun`, `Article.plain_text` |
| `core/aggregators/utils/__init__.py` | Export `blocks_from_html`, `plain_text` |
| `core/aggregators/utils/content_formatter.py` | Stop emitting the `<footer>` |
| `core/services/aggregator_service.py` | Convert on create and on forced update |
| `core/services/article_service.py` | Convert after `reload_article` |
| `core/management/commands/test_aggregator.py` | Convert on save |
| `core/management/commands/prune_orphaned_images.py` | Reference lookup via the block index |
| `core/admin.py` | Block inline, rendered preview, `plain_text`, "Re-convert blocks" |
| `core/views/default.py`, `core/views/__init__.py`, `core/urls/default.py` | Delete the two proxy views + routes |
| `core/tests/test_default_views.py` | Drop the proxy tests |
| `core/tests/test_prune_orphaned_images.py` | Cover block-sourced references |
| `CLAUDE.md`, `core/aggregators/README.md` | Documentation |

---

## Task 1: Block types and the pinned wire schema

**Files:**
- Create: `core/blocks/__init__.py`, `core/blocks/types.py`, `core/blocks/schema.py`
- Create: `core/tests/fixtures/blocks_golden_v1.json`
- Test: `core/tests/test_block_schema.py`

**Interfaces:**
- Consumes: nothing.
- Produces — every later task depends on these exact names:
  - `core.blocks.types`: `FORMAT_VERSION: int` (= 1), `STYLE_NAMES: tuple[str, ...]`,
    `EMBED_PROVIDERS: tuple[str, ...]`, `BLOCK_KINDS: tuple[str, ...]`,
    `InlineRun(text, bold=False, italic=False, code=False, strikethrough=False, link="")` with a
    `.styles -> list[str]` property, `Paragraph(runs)`, `Heading(level, runs)`,
    `ListBlock(ordered, items)`, `Blockquote(blocks)`, `ImageBlock(ref, caption)`,
    `EmbedBlock(provider, external_url, thumbnail_ref="", title="")`,
    `CodeBlock(text, language="")`, `Divider()`, the union alias `Block`, and `KIND: ClassVar[str]`
    on each block class (`"paragraph"`, `"heading"`, `"list"`, `"blockquote"`, `"image"`, `"embed"`,
    `"code_block"`, `"divider"`).
  - `core.blocks.schema`: `encode_document(blocks) -> dict`, `encode_block(block) -> dict`,
    `decode_document(payload) -> list[Block]`, `decode_blocks(items) -> list[Block]`,
    `decode_block(obj) -> Block | None`, `UnsupportedFormatVersion(ValueError)`.

- [ ] **Step 1: Write the failing schema tests**

Create `core/tests/test_block_schema.py`:

```python
"""The pinned wire format: version 1 of the Yana content format."""

import json
from pathlib import Path

import pytest

from core.blocks.schema import (
    UnsupportedFormatVersion,
    decode_block,
    decode_document,
    encode_block,
    encode_document,
)
from core.blocks.types import (
    FORMAT_VERSION,
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

GOLDEN = Path(__file__).parent / "fixtures" / "blocks_golden_v1.json"

EVERY_KIND = [
    Paragraph(runs=[InlineRun(text="Hi", bold=True, link="https://example.com/a")]),
    Heading(level=2, runs=[InlineRun(text="Title")]),
    ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="one")])], []]),
    Blockquote(blocks=[Paragraph(runs=[InlineRun(text="quoted", italic=True)])]),
    ImageBlock(ref="yana-img://" + "a" * 64, caption=[InlineRun(text="cap")]),
    EmbedBlock(
        provider="youtube",
        external_url="https://www.youtube.com/watch?v=abc123",
        thumbnail_ref="yana-img://" + "b" * 64,
        title="A video",
    ),
    CodeBlock(text="print('x')"),
    Divider(),
]


def test_every_kind_round_trips():
    payload = encode_document(EVERY_KIND)
    assert payload["version"] == FORMAT_VERSION
    assert decode_document(payload) == EVERY_KIND


def test_document_survives_a_json_round_trip():
    assert decode_document(json.loads(json.dumps(encode_document(EVERY_KIND)))) == EVERY_KIND


def test_styles_encode_as_a_string_array():
    run = InlineRun(text="x", bold=True, strikethrough=True)
    encoded = encode_block(Paragraph(runs=[run]))
    assert encoded["runs"][0]["styles"] == ["bold", "strikethrough"]


def test_unknown_style_name_is_ignored_not_fatal():
    decoded = decode_block({"type": "paragraph", "runs": [{"text": "x", "styles": ["bold", "wat"]}]})
    assert decoded == Paragraph(runs=[InlineRun(text="x", bold=True)])


def test_unknown_block_type_is_skipped_and_neighbours_survive():
    payload = {
        "version": 1,
        "blocks": [
            {"type": "divider"},
            {"type": "table", "rows": []},
            {"type": "paragraph", "runs": [{"text": "after"}]},
        ],
    }
    assert decode_document(payload) == [Divider(), Paragraph(runs=[InlineRun(text="after")])]


def test_missing_optional_keys_decode_with_defaults():
    assert decode_block({"type": "codeBlock", "text": "x"}) == CodeBlock(text="x", language="")
    assert decode_block({"type": "embed", "externalURL": "https://x/"}) == EmbedBlock(
        provider="generic", external_url="https://x/", thumbnail_ref="", title=""
    )
    assert decode_block({"type": "paragraph"}) == Paragraph(runs=[])


def test_optional_strings_encode_as_null():
    encoded = encode_block(CodeBlock(text="x"))
    assert encoded == {"type": "codeBlock", "text": "x", "language": None}
    embed = encode_block(EmbedBlock(provider="tweet", external_url="https://x.com/a/status/1"))
    assert embed["thumbnailRef"] is None
    assert embed["title"] is None
    assert encode_block(Paragraph(runs=[InlineRun(text="x")]))["runs"][0]["link"] is None


def test_code_block_wire_type_is_camel_case():
    assert encode_block(CodeBlock(text="x"))["type"] == "codeBlock"


def test_heading_level_is_clamped_on_decode():
    assert decode_block({"type": "heading", "level": 9, "runs": []}).level == 6
    assert decode_block({"type": "heading", "level": 0, "runs": []}).level == 1


def test_unknown_provider_falls_back_to_generic():
    decoded = decode_block({"type": "embed", "provider": "vimeo", "externalURL": "https://v/1"})
    assert decoded.provider == "generic"


def test_unsupported_version_raises():
    with pytest.raises(UnsupportedFormatVersion):
        decode_document({"version": 99, "blocks": []})


def test_golden_fixture_decodes_to_the_expected_tree():
    """The shared contract check -- the iOS side tests against this same file."""
    payload = json.loads(GOLDEN.read_text())
    assert decode_document(payload) == EVERY_KIND


def test_golden_fixture_matches_what_we_encode():
    assert json.loads(GOLDEN.read_text()) == encode_document(EVERY_KIND)
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_block_schema.py -q
```

Expected: collection error — `ModuleNotFoundError: No module named 'core.blocks'`.

- [ ] **Step 3: Write `core/blocks/__init__.py`**

```python
"""
The Yana content format: typed article-body blocks.

Deliberately empty of re-exports. ``conversion`` imports the block parser, the
parser imports ``core.blocks.types``, and importing any submodule executes this
file first -- so re-exporting ``conversion`` here would be a real import cycle.
Import the submodules directly.
"""
```

- [ ] **Step 4: Write `core/blocks/types.py`**

```python
"""
The Yana content format's block dataclasses.

The server-side twin of iOS's ``Block`` / ``InlineRun`` / ``Embed``
(``../yana-ios/Yana/Reader/Block.swift``). Plain data: no HTML, no ORM, no I/O,
so the parser, the wire schema and the relational writer can each depend on
this module without depending on each other.

Empty strings stand in for Swift's optionals -- ``link=""`` means "no link",
``language=""`` means "unknown". The wire encoder turns them into JSON ``null``
(see ``schema.py``); the database columns store them as ``""`` (see
``core/models.py``). Nothing in the pipeline carries ``None`` for these.
"""

from dataclasses import dataclass, field
from typing import ClassVar

FORMAT_VERSION = 1

#: Inline style names, in the order the wire's ``styles`` array uses.
STYLE_NAMES: tuple[str, ...] = ("bold", "italic", "code", "strikethrough")

#: Recognized embed providers. Anything else decodes to ``generic``.
EMBED_PROVIDERS: tuple[str, ...] = ("youtube", "dailymotion", "video", "tweet", "generic")

#: Storage kinds. ``list_item`` is the one synthetic kind -- it encodes a list's
#: ``[[Block]]`` shape as rows and never appears on the wire.
BLOCK_KINDS: tuple[str, ...] = (
    "paragraph",
    "heading",
    "list",
    "list_item",
    "blockquote",
    "image",
    "embed",
    "code_block",
    "divider",
)


@dataclass(frozen=True)
class InlineRun:
    """A styled span of text inside a paragraph, heading or image caption."""

    text: str
    bold: bool = False
    italic: bool = False
    code: bool = False
    strikethrough: bool = False
    link: str = ""

    @property
    def styles(self) -> list[str]:
        """Set style names, in ``STYLE_NAMES`` order."""
        return [name for name in STYLE_NAMES if getattr(self, name)]


@dataclass
class Paragraph:
    KIND: ClassVar[str] = "paragraph"
    runs: list[InlineRun] = field(default_factory=list)


@dataclass
class Heading:
    KIND: ClassVar[str] = "heading"
    level: int = 1
    runs: list[InlineRun] = field(default_factory=list)


@dataclass
class ListBlock:
    KIND: ClassVar[str] = "list"
    ordered: bool = False
    #: Each item is its own block sequence, so an item can hold paragraphs,
    #: nested lists, and so on.
    items: list[list["Block"]] = field(default_factory=list)


@dataclass
class Blockquote:
    KIND: ClassVar[str] = "blockquote"
    blocks: list["Block"] = field(default_factory=list)


@dataclass
class ImageBlock:
    KIND: ClassVar[str] = "image"
    #: ``yana-img://<sha256>`` into the content-addressed store, or a remote URL.
    ref: str = ""
    caption: list[InlineRun] = field(default_factory=list)


@dataclass
class EmbedBlock:
    KIND: ClassVar[str] = "embed"
    provider: str = "generic"
    #: Where a tap navigates, or -- for ``video`` -- the direct stream URL.
    external_url: str = ""
    thumbnail_ref: str = ""
    title: str = ""


@dataclass
class CodeBlock:
    KIND: ClassVar[str] = "code_block"
    text: str = ""
    language: str = ""


@dataclass
class Divider:
    KIND: ClassVar[str] = "divider"


Block = (
    Paragraph | Heading | ListBlock | Blockquote | ImageBlock | EmbedBlock | CodeBlock | Divider
)
```

- [ ] **Step 5: Write `core/blocks/schema.py`**

```python
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
```

- [ ] **Step 6: Write the golden fixture**

Create `core/tests/fixtures/blocks_golden_v1.json` exactly as below. It is the artifact the iOS side
tests against, so it is hand-written and checked against the encoder, not generated by it.

```json
{
  "version": 1,
  "blocks": [
    {
      "type": "paragraph",
      "runs": [{"text": "Hi", "styles": ["bold"], "link": "https://example.com/a"}]
    },
    {
      "type": "heading",
      "level": 2,
      "runs": [{"text": "Title", "styles": [], "link": null}]
    },
    {
      "type": "list",
      "ordered": false,
      "items": [
        [{"type": "paragraph", "runs": [{"text": "one", "styles": [], "link": null}]}],
        []
      ]
    },
    {
      "type": "blockquote",
      "blocks": [
        {"type": "paragraph", "runs": [{"text": "quoted", "styles": ["italic"], "link": null}]}
      ]
    },
    {
      "type": "image",
      "ref": "yana-img://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "caption": [{"text": "cap", "styles": [], "link": null}]
    },
    {
      "type": "embed",
      "provider": "youtube",
      "thumbnailRef": "yana-img://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "externalURL": "https://www.youtube.com/watch?v=abc123",
      "title": "A video"
    },
    {"type": "codeBlock", "text": "print('x')", "language": null},
    {"type": "divider"}
  ]
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_block_schema.py -q
```

Expected: PASS, 14 tests.

- [ ] **Step 8: Lint, format and type-check**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
```

Expected: clean. If mypy objects to `decode_block(...).level` in the clamp test, that is the test's
`Block | None` return — assert on `decode_block(...)` into a local typed as the concrete class, or
add an `assert isinstance(decoded, Heading)` before the attribute access.

- [ ] **Step 9: Commit**

```bash
git add core/blocks core/tests/test_block_schema.py core/tests/fixtures/blocks_golden_v1.json && git commit -m "feat(blocks): Pin the Yana content format as a versioned JSON schema"
```

---

## Task 2: Parser core — text, inline runs, headings, drop-vs-recurse, `plain_text`

**Files:**
- Create: `core/aggregators/utils/block_parser.py`
- Modify: `core/aggregators/utils/__init__.py`
- Test: `core/tests/test_block_parser.py`

**Interfaces:**
- Consumes: everything from `core.blocks.types` (Task 1).
- Produces: `blocks_from_html(html: str, base_url: str = "") -> list[Block]` and
  `plain_text(blocks: Sequence[Block]) -> str`, both exported from `core.aggregators.utils`.
  Tasks 3 and 4 extend the same module's `_convert` dispatch.

**Background the implementer needs:**
- The Swift original is `../yana-ios/Yana/Aggregators/Utils/BlockParser.swift`. Read it. Its structure
  translates directly; the differences are BeautifulSoup vs. SwiftSoup and this plan's deviations.
- One quirk in the Swift **not** to port: `inlineTags` does not contain `"br"`, so the
  `if tag == "br"` branch inside the `if inlineTags.contains(tag)` block is unreachable dead code.
  Only the `switch` case matters.
- SwiftSoup's `TextNode.text()` collapses runs of whitespace to a single space. BeautifulSoup does
  not, so the port normalizes explicitly. `<pre>` is the deliberate exception (deviation 3).
- `Comment`, `Doctype`, `CData`, `Declaration` and `ProcessingInstruction` are all `NavigableString`
  **subclasses** in bs4. Checking `isinstance(node, NavigableString)` first would turn an HTML comment
  into body text. Check the non-text subclasses first.

- [ ] **Step 1: Write the failing parser tests**

Create `core/tests/test_block_parser.py`:

```python
"""HTML -> blocks: the Python port of iOS's BlockParser."""

from core.aggregators.utils.block_parser import blocks_from_html, plain_text
from core.blocks.types import Divider, Heading, InlineRun, Paragraph


def test_empty_and_blank_html_yields_nothing():
    assert blocks_from_html("") == []
    assert blocks_from_html("   \n  ") == []


def test_paragraph_becomes_a_paragraph_block():
    assert blocks_from_html("<p>Hello</p>") == [Paragraph(runs=[InlineRun(text="Hello")])]


def test_bare_text_is_buffered_into_a_paragraph():
    assert blocks_from_html("Loose text") == [Paragraph(runs=[InlineRun(text="Loose text")])]


def test_whitespace_is_normalized_like_swiftsoup():
    assert blocks_from_html("<p>a\n\n   b</p>") == [Paragraph(runs=[InlineRun(text="a b")])]


def test_headings_map_to_their_level():
    blocks = blocks_from_html("<h1>a</h1><h3>b</h3>")
    assert blocks == [
        Heading(level=1, runs=[InlineRun(text="a")]),
        Heading(level=3, runs=[InlineRun(text="b")]),
    ]


def test_all_six_heading_levels_map_exactly():
    for level in range(1, 7):
        blocks = blocks_from_html(f"<h{level}>a</h{level}>")
        assert blocks == [Heading(level=level, runs=[InlineRun(text="a")])], level


def test_a_bogus_heading_tag_is_treated_as_an_unknown_wrapper():
    """There is no <h7>, so it recurses like any other unknown tag rather than
    producing an out-of-range heading. Level clamping itself is enforced on
    decode (schema) and on write (storage), where out-of-range input is
    actually reachable."""
    assert blocks_from_html("<h7>a</h7>") == [Paragraph(runs=[InlineRun(text="a")])]


def test_inline_tags_buffer_into_one_paragraph():
    blocks = blocks_from_html("<p>plain <strong>bold</strong> <em>it</em></p>")
    assert blocks == [
        Paragraph(
            runs=[
                InlineRun(text="plain "),
                InlineRun(text="bold", bold=True),
                InlineRun(text=" "),
                InlineRun(text="it", italic=True),
            ]
        )
    ]


def test_nested_styles_combine_on_one_run():
    blocks = blocks_from_html("<p><b><i>both</i></b></p>")
    assert blocks == [Paragraph(runs=[InlineRun(text="both", bold=True, italic=True)])]


def test_code_and_strikethrough_map_to_their_flags():
    blocks = blocks_from_html("<p><code>c</code><del>d</del></p>")
    assert blocks == [
        Paragraph(runs=[InlineRun(text="c", code=True), InlineRun(text="d", strikethrough=True)])
    ]


def test_br_becomes_a_newline_run():
    blocks = blocks_from_html("<p>a<br>b</p>")
    assert blocks == [
        Paragraph(runs=[InlineRun(text="a"), InlineRun(text="\n"), InlineRun(text="b")])
    ]


def test_links_become_runs_with_an_absolute_url():
    blocks = blocks_from_html(
        '<p><a href="/rel">here</a></p>', base_url="https://example.com/news/story"
    )
    assert blocks == [Paragraph(runs=[InlineRun(text="here", link="https://example.com/rel")])]


def test_link_without_base_url_is_left_alone():
    blocks = blocks_from_html('<p><a href="/rel">here</a></p>')
    assert blocks == [Paragraph(runs=[InlineRun(text="here", link="/rel")])]


def test_style_carries_through_a_link():
    blocks = blocks_from_html('<p><a href="https://x/"><b>bl</b></a></p>')
    assert blocks == [Paragraph(runs=[InlineRun(text="bl", bold=True, link="https://x/")])]


def test_dropped_tags_produce_nothing_and_neither_do_their_children():
    """Table cells must not leak in as stray paragraphs -- that is the whole
    reason drop-vs-recurse exists."""
    html = "<table><tbody><tr><td><p>cell</p></td></tr></tbody></table><p>real</p>"
    assert blocks_from_html(html) == [Paragraph(runs=[InlineRun(text="real")])]


def test_every_dropped_tag_is_dropped():
    for tag in ("form", "button", "select", "textarea", "noscript", "iframe", "audio", "canvas"):
        assert blocks_from_html(f"<{tag}><p>x</p></{tag}>") == [], tag


def test_unknown_wrappers_are_recursed_into():
    html = "<div><section><p>deep</p></section></div>"
    assert blocks_from_html(html) == [Paragraph(runs=[InlineRun(text="deep")])]


def test_comments_are_not_body_text():
    assert blocks_from_html("<!-- hidden --><p>shown</p>") == [
        Paragraph(runs=[InlineRun(text="shown")])
    ]


def test_empty_paragraphs_and_headings_are_omitted():
    assert blocks_from_html("<p></p><p>   </p><h2></h2>") == []


def test_hr_is_a_divider():
    assert blocks_from_html("<hr>") == [Divider()]


def test_plain_text_flattens_in_document_order():
    blocks = blocks_from_html("<h2>Title</h2><p>One</p><p>Two</p>")
    assert plain_text(blocks) == "Title\n\nOne\n\nTwo"


def test_plain_text_skips_empty_segments_and_dividers():
    assert plain_text(blocks_from_html("<p>a</p><hr><p>  </p><p>b</p>")) == "a\n\nb"


def test_plain_text_of_nothing_is_empty():
    assert plain_text([]) == ""
```

Note: `test_hr_is_a_divider` is here rather than in Task 3 because `hr` needs no helper — implement
it in this task's `_convert`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_block_parser.py -q
```

Expected: collection error — `No module named 'core.aggregators.utils.block_parser'`.

- [ ] **Step 3: Write `core/aggregators/utils/block_parser.py`**

```python
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
    return list(container.children)


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
            continue

        if tag in _HEADING_TAGS:
            flush()
            runs = _trimmed(_inline_runs(node, base_url))
            if runs:
                blocks.append(Heading(level=_HEADING_TAGS[tag], runs=runs))
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
```

`Blockquote`, `CodeBlock`, `EmbedBlock`, `ImageBlock` and `ListBlock` are imported for `plain_text`'s
match statement even though the tag branches that produce them arrive in Tasks 3–4 — ruff will not
flag them, because `plain_text` uses all five.

- [ ] **Step 4: Export from `core/aggregators/utils/__init__.py`**

Add the import in isort order (after `from .bs4_utils import ...`):

```python
from .block_parser import blocks_from_html, plain_text
```

and add `"blocks_from_html"` and `"plain_text"` to `__all__`, keeping its alphabetical ordering.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_block_parser.py -q
```

Expected: PASS, 22 tests.

- [ ] **Step 6: Lint, format, type-check and run the full suite**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest -q
```

Expected: clean, and no pre-existing test regresses (the new module is not wired into anything yet).

- [ ] **Step 7: Commit**

```bash
git add core/aggregators/utils/block_parser.py core/aggregators/utils/__init__.py core/tests/test_block_parser.py && git commit -m "feat(blocks): Port BlockParser's text, inline and recursion walk to Python"
```

---

## Task 3: Parser — lists, blockquotes, `pre`, images and figures

**Files:**
- Modify: `core/aggregators/utils/block_parser.py`
- Test: `core/tests/test_block_parser.py` (append)

**Interfaces:**
- Consumes: `_convert`, `_inline_runs`, `_trimmed` from Task 2.
- Produces: `_list_block`, `_image_block`, `_figure_blocks`, `_first` helpers used by Task 4.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/test_block_parser.py` (and extend the import line at the top to add
`Blockquote`, `CodeBlock`, `ImageBlock`, `ListBlock`):

```python
def test_unordered_and_ordered_lists():
    blocks = blocks_from_html("<ul><li>a</li></ul><ol><li>b</li></ol>")
    assert blocks == [
        ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="a")])]]),
        ListBlock(ordered=True, items=[[Paragraph(runs=[InlineRun(text="b")])]]),
    ]


def test_nested_lists_round_trip_through_items():
    blocks = blocks_from_html("<ul><li>outer<ul><li>inner</li></ul></li></ul>")
    assert blocks == [
        ListBlock(
            ordered=False,
            items=[
                [
                    Paragraph(runs=[InlineRun(text="outer")]),
                    ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="inner")])]]),
                ]
            ],
        )
    ]


def test_only_direct_li_children_become_items():
    blocks = blocks_from_html("<ul><div><li>nested-away</li></div><li>direct</li></ul>")
    assert blocks == [ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="direct")])]])]


def test_empty_lists_and_empty_items_are_omitted():
    assert blocks_from_html("<ul></ul>") == []
    assert blocks_from_html("<ul><li></li><li>  </li></ul>") == []
    assert blocks_from_html("<ul><li></li><li>kept</li></ul>") == [
        ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="kept")])]])
    ]


def test_ordinary_blockquote_wraps_its_blocks():
    blocks = blocks_from_html("<blockquote><p>quoted</p></blockquote>")
    assert blocks == [Blockquote(blocks=[Paragraph(runs=[InlineRun(text="quoted")])])]


def test_empty_blockquote_is_omitted():
    assert blocks_from_html("<blockquote>  </blockquote>") == []


def test_pre_becomes_a_code_block_with_whitespace_intact():
    blocks = blocks_from_html("<pre>def f():\n    return 1\n</pre>")
    assert blocks == [CodeBlock(text="def f():\n    return 1\n", language="")]


def test_empty_pre_is_omitted():
    assert blocks_from_html("<pre>   </pre>") == []


def test_standalone_img_becomes_an_image_block():
    ref = "yana-img://" + "c" * 64
    assert blocks_from_html(f'<img src="{ref}">') == [ImageBlock(ref=ref)]


def test_img_without_src_is_dropped():
    assert blocks_from_html('<img alt="nothing">') == []


def test_paragraph_wrapping_only_an_image_yields_the_image():
    """The Reddit/Giphy regression guard: inline-run extraction drops images, so
    a <p><img></p> would otherwise vanish entirely."""
    ref = "yana-img://" + "d" * 64
    assert blocks_from_html(f'<p><img src="{ref}"></p>') == [ImageBlock(ref=ref)]


def test_paragraph_with_text_and_an_image_yields_text_then_image():
    ref = "yana-img://" + "e" * 64
    blocks = blocks_from_html(f'<p>caption text<img src="{ref}"></p>')
    assert blocks == [Paragraph(runs=[InlineRun(text="caption text")]), ImageBlock(ref=ref)]


def test_figure_pairs_an_image_with_its_figcaption():
    ref = "yana-img://" + "f" * 64
    blocks = blocks_from_html(f'<figure><img src="{ref}"><figcaption>Shot</figcaption></figure>')
    assert blocks == [ImageBlock(ref=ref, caption=[InlineRun(text="Shot")])]


def test_figure_without_an_image_is_recursed():
    assert blocks_from_html("<figure><p>text only</p></figure>") == [
        Paragraph(runs=[InlineRun(text="text only")])
    ]


def test_plain_text_walks_lists_quotes_captions_and_code():
    html = (
        "<ul><li>item</li></ul>"
        "<blockquote><p>quote</p></blockquote>"
        '<figure><img src="yana-img://a"><figcaption>cap</figcaption></figure>'
        "<pre>code</pre>"
    )
    assert plain_text(blocks_from_html(html)) == "item\n\nquote\n\ncap\n\ncode"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_block_parser.py -q
```

Expected: the new tests fail — lists/quotes/`pre`/images currently fall through to the unknown-wrapper
branch, so e.g. `<ul><li>a</li></ul>` yields a bare `Paragraph` instead of a `ListBlock`.

- [ ] **Step 3: Add the helpers to `block_parser.py`**

```python
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
```

- [ ] **Step 4: Extend the `_convert` dispatch**

Insert these branches into `_convert`, immediately after the `tag in _HEADING_TAGS` branch and before
the `hr` branch:

```python
        if tag in ("ul", "ol"):
            flush()
            block = _list_block(node, ordered=tag == "ol", base_url=base_url)
            if block is not None:
                blocks.append(block)
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
```

Then replace the existing `p` branch with the image-splitting version:

```python
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
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_block_parser.py -q
```

Expected: PASS, 37 tests.

- [ ] **Step 6: Lint, format, type-check**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
```

- [ ] **Step 7: Commit**

```bash
git add core/aggregators/utils/block_parser.py core/tests/test_block_parser.py && git commit -m "feat(blocks): Convert lists, quotes, code blocks, images and figures"
```

---

## Task 4: Parser — embeds (proxy facades, `<video>`, tweet blockquotes)

**Files:**
- Modify: `core/aggregators/utils/block_parser.py`
- Test: `core/tests/test_block_parser.py` (append)

**Interfaces:**
- Consumes: `_convert`, `_first`, `_inline_runs` from Tasks 2–3.
- Produces: `_embed_facade(element) -> EmbedBlock | None`, `_video_embed(element) -> EmbedBlock | None`,
  `_tweet_embed(element) -> EmbedBlock | None`. Nothing downstream calls these directly.

**Background the implementer needs — read this before writing code:**

The server's embed markup is **not** iOS's (deviation 1). What actually reaches the parser:

| Source | Markup |
|---|---|
| `utils/youtube.py::create_youtube_embed_html` | `<div class="youtube-embed-container"><iframe src="{BASE_URL}/api/youtube-proxy?v=<id>" …></iframe></div>` |
| `mein_mmo/embed_processors.py` | `<div data-sanitized-class="youtube-embed"><iframe src="…/api/youtube-proxy?v=<id>"></iframe><p>caption</p></div>` |
| `mein_mmo/content_extraction.py::process_dailymotion_blocks` | `<div class="dailymotion-embed-container"><iframe src="…/api/dailymotion-proxy?v=<id>"></iframe></div>` |
| `tagesschau/media_processor.py` | `<header class="media-header"><div class="media-player"><video controls poster="…"><source src="…" type="…">fallback</video></div></header>` |
| `utils/twitter.py::build_tweet_embed_html` | `<blockquote …><p><strong>@who</strong> · <a href="https://x.com/who/status/1">View on X</a></p>…</blockquote>` |

Two things follow. First, `html_cleaner.sanitize_html_attributes` moves `class` to
`data-sanitized-class` but **keeps** iframes whose `src` contains `/api/youtube-proxy` or
`/api/dailymotion-proxy` — so both attribute spellings must be checked, and the iframe is present
even though `iframe` is in `DROPPED_TAGS` (dropping happens in `_convert`, after facade detection).
Second, TikTok and Bluesky wrappers (`data-sanitized-class="tiktok-embed"` / `"bluesky-embed"`) are
deliberately **not** recognized as facades: their iframes are not on the proxy allowlist and get
stripped, so those wrappers recurse and contribute their caption text, exactly as they do on iOS.

The tweet facade discards the tweet's own images, matching iOS: the card opens externally and the
client renders no inline media for it.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/test_block_parser.py` (add `EmbedBlock` to the import line):

```python
YOUTUBE_FACADE = (
    '<div data-sanitized-class="youtube-embed-container">'
    '<iframe src="https://yana.example/api/youtube-proxy?v=dQw4w9WgXcQ"></iframe>'
    "</div>"
)


def test_youtube_proxy_facade_becomes_a_youtube_embed():
    assert blocks_from_html(YOUTUBE_FACADE) == [
        EmbedBlock(
            provider="youtube",
            external_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        )
    ]


def test_youtube_facade_is_found_through_an_unsanitized_class():
    html = YOUTUBE_FACADE.replace("data-sanitized-class", "class")
    assert blocks_from_html(html)[0].provider == "youtube"


def test_youtube_facade_is_found_inside_a_header_wrapper():
    html = f'<header style="x">{YOUTUBE_FACADE}</header>'
    assert blocks_from_html(html)[0].provider == "youtube"


def test_youtube_facade_external_url_never_points_at_the_proxy():
    """Task 12 deletes the proxy views; nothing stored may reference them."""
    embed = blocks_from_html(YOUTUBE_FACADE)[0]
    assert "youtube-proxy" not in embed.external_url
    assert embed.external_url.startswith("https://www.youtube.com/watch?v=")


def test_youtube_facade_takes_its_thumbnail_from_a_poster_image():
    ref = "yana-img://" + "1" * 64
    html = (
        '<div data-sanitized-class="youtube-embed">'
        f'<img src="{ref}">'
        '<iframe src="/api/youtube-proxy?v=abcdefghijk"></iframe>'
        "</div>"
    )
    assert blocks_from_html(html)[0].thumbnail_ref == ref


def test_youtube_facade_falls_back_to_a_data_embed_attribute():
    html = (
        '<div data-sanitized-class="youtube-embed" '
        'data-sanitized-data-embed-content="https://www.youtube.com/embed/abcdefghijk"></div>'
    )
    assert blocks_from_html(html) == [
        EmbedBlock(provider="youtube", external_url="https://www.youtube.com/watch?v=abcdefghijk")
    ]


def test_youtube_facade_falls_back_to_a_watch_link():
    html = (
        '<div data-sanitized-class="youtube-embed">'
        '<a href="https://www.youtube.com/watch?v=abcdefghijk">watch</a>'
        "</div>"
    )
    assert blocks_from_html(html)[0].external_url == "https://www.youtube.com/watch?v=abcdefghijk"


def test_dailymotion_proxy_facade_becomes_a_dailymotion_embed():
    html = (
        '<div data-sanitized-class="dailymotion-embed-container">'
        '<iframe src="https://yana.example/api/dailymotion-proxy?v=x8abcde"></iframe>'
        "</div>"
    )
    assert blocks_from_html(html) == [
        EmbedBlock(
            provider="dailymotion", external_url="https://www.dailymotion.com/video/x8abcde"
        )
    ]


def test_unrecognizable_facade_recurses_instead_of_vanishing():
    html = '<div data-sanitized-class="youtube-embed"><p>Caption survives</p></div>'
    assert blocks_from_html(html) == [Paragraph(runs=[InlineRun(text="Caption survives")])]


def test_tiktok_and_bluesky_wrappers_recurse():
    for cls in ("tiktok-embed", "bluesky-embed"):
        html = f'<div data-sanitized-class="{cls}"><p>cap</p></div>'
        assert blocks_from_html(html) == [Paragraph(runs=[InlineRun(text="cap")])], cls


def test_video_with_a_source_becomes_a_video_embed():
    poster = "yana-img://" + "2" * 64
    html = (
        f'<video controls poster="{poster}">'
        '<source src="https://v.example/clip.mp4" type="video/mp4">'
        "Your browser does not support the video element."
        "</video>"
    )
    assert blocks_from_html(html) == [
        EmbedBlock(
            provider="video", external_url="https://v.example/clip.mp4", thumbnail_ref=poster
        )
    ]


def test_video_falls_back_to_its_own_src():
    html = '<video src="https://v.example/clip.m3u8"></video>'
    assert blocks_from_html(html)[0].external_url == "https://v.example/clip.m3u8"


def test_video_without_a_playable_source_is_dropped():
    assert blocks_from_html("<video controls>no source</video>") == []


def test_video_fallback_text_never_leaks_into_a_paragraph():
    html = "<p>before</p><video><source src='https://v/x.mp4'>Your browser…</video>"
    blocks = blocks_from_html(html)
    assert [type(block) for block in blocks] == [Paragraph, EmbedBlock]
    assert "browser" not in plain_text(blocks)


def test_tagesschau_style_video_header_is_found_through_its_wrappers():
    html = (
        '<header data-sanitized-class="media-header">'
        '<div data-sanitized-class="media-player">'
        '<video controls><source src="https://v/x.mp4" type="video/mp4"></video>'
        "</div></header>"
    )
    assert blocks_from_html(html)[0].provider == "video"


def test_tweet_blockquote_becomes_a_tweet_embed():
    html = (
        "<blockquote><p><strong>@who</strong> · "
        '<a href="https://x.com/who/status/1">View on X</a></p>'
        "<p>the tweet body</p></blockquote>"
    )
    embed = blocks_from_html(html)[0]
    assert embed.provider == "tweet"
    assert embed.external_url == "https://x.com/who/status/1"
    assert "the tweet body" in embed.title


def test_twitter_and_fxtwitter_hosts_are_recognized():
    for host in ("twitter.com", "mobile.twitter.com", "api.fxtwitter.com"):
        html = f'<blockquote><a href="https://{host}/w/status/1">t</a></blockquote>'
        assert blocks_from_html(html)[0].provider == "tweet", host


def test_blockquote_linking_elsewhere_stays_a_blockquote():
    html = '<blockquote><p><a href="https://example.com/a">link</a></p></blockquote>'
    assert isinstance(blocks_from_html(html)[0], Blockquote)


def test_plain_text_uses_an_embed_title():
    html = (
        "<blockquote><p>tweet text</p>"
        '<a href="https://x.com/w/status/1">View on X</a></blockquote>'
    )
    assert "tweet text" in plain_text(blocks_from_html(html))
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_block_parser.py -q
```

Expected: the new tests fail — facades currently recurse into nothing (the iframe is dropped), and
`<video>` falls through to the unknown-wrapper branch.

- [ ] **Step 3: Add the embed helpers to `block_parser.py`**

```python
_YOUTUBE_PROXY_ID = re.compile(r"/api/youtube-proxy\?(?:.*&)?v=([A-Za-z0-9_-]{6,})")
_DAILYMOTION_PROXY_ID = re.compile(r"/api/dailymotion-proxy\?(?:.*&)?v=([A-Za-z0-9]+)")
_YOUTUBE_EMBED_ID = re.compile(r"(?:youtube\.com|youtube-nocookie\.com)/embed/([A-Za-z0-9_-]{6,})")
_YOUTUBE_WATCH_ID = re.compile(r"(?:youtube\.com/watch\?(?:.*&)?v=|youtu\.be/)([A-Za-z0-9_-]{6,})")
_DAILYMOTION_VIDEO_ID = re.compile(r"dailymotion\.com/(?:video|embed/video)/([A-Za-z0-9]+)")

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

    The video id is read from the proxy iframe's ``src`` first, because that is
    what the pipeline actually emits (see the module docstring and the plan's
    deviation 1); a stashed ``data-embed`` payload and a descendant watch link
    are fallbacks for content that took another route. The result carries the
    canonical public watch URL, never the proxy path -- the proxy endpoints do
    not exist any more, and nothing stored may point at them.
    """
    classes = _class_names(element)
    is_youtube = "youtube-embed" in classes
    is_dailymotion = "dailymotion-embed" in classes
    if not (is_youtube or is_dailymotion):
        return None

    markup = _embed_markup(element)
    thumbnail = _facade_thumbnail(element)

    if is_youtube:
        video_id = _first_match(
            (_YOUTUBE_PROXY_ID, _YOUTUBE_EMBED_ID, _YOUTUBE_WATCH_ID), markup
        )
        if video_id:
            return EmbedBlock(
                provider="youtube",
                external_url=f"https://www.youtube.com/watch?v={video_id}",
                thumbnail_ref=thumbnail,
            )
    else:
        video_id = _first_match((_DAILYMOTION_PROXY_ID, _DAILYMOTION_VIDEO_ID), markup)
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
    if not src:
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
```

Add `urlparse` to the existing `urllib.parse` import: `from urllib.parse import urljoin, urlparse`.

- [ ] **Step 4: Extend the `_convert` dispatch**

Replace the `blockquote` branch from Task 3 with:

```python
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
```

Add a `video` branch next to the `img` branch:

```python
        if tag == "video":
            flush()
            embed = _video_embed(node)
            if embed is not None:
                blocks.append(embed)
            continue
```

And replace the unknown-wrapper fallthrough at the end of the loop with:

```python
        # Unknown wrapper: an embed facade becomes an embed; otherwise walk it
        # for known blocks and discard the wrapper itself.
        flush()
        facade = _embed_facade(node)
        if facade is not None:
            blocks.append(facade)
            continue
        blocks.extend(_convert(node, base_url))
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_block_parser.py -q
```

Expected: PASS, 55 tests.

- [ ] **Step 6: Sanity-check against a real fixture**

The parser is not wired into anything yet, so exercise it directly on a real captured page:

```bash
uv run python -c "
from pathlib import Path
from core.aggregators.utils.block_parser import blocks_from_html, plain_text
html = Path('core/tests/fixtures/mactechnews.html').read_text()
blocks = blocks_from_html(html, base_url='https://www.mactechnews.de/')
from collections import Counter
print(Counter(type(b).__name__ for b in blocks))
print(plain_text(blocks)[:400])
"
```

Expected: a mix of `Paragraph`/`Heading`/`ImageBlock` counts and readable prose — not an empty list,
and no table debris. This is a smoke check, not an assertion; note anything surprising in the commit
message or raise it at review.

- [ ] **Step 7: Lint, format, type-check, full suite**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest -q
```

- [ ] **Step 8: Commit**

```bash
git add core/aggregators/utils/block_parser.py core/tests/test_block_parser.py && git commit -m "feat(blocks): Convert video, tweet and proxy-backed player embeds"
```

---

## Task 5: `ArticleBlock`, `ArticleInlineRun` and `Article.plain_text`

**Files:**
- Modify: `core/models.py`
- Create: `core/migrations/0035_articleblock_articleinlinerun_article_plain_text.py` (generated)
- Test: `core/tests/test_block_models.py`

**Interfaces:**
- Consumes: `BLOCK_KINDS` from `core.blocks.types`.
- Produces: `core.models.ArticleBlock` (related names `article.blocks`, `block.children`,
  `block.runs`), `core.models.ArticleInlineRun`, `Article.plain_text`.

- [ ] **Step 1: Write the failing model tests**

Create `core/tests/test_block_models.py`:

```python
"""Relational storage for block trees: shape, ordering and cascades."""

import pytest
from django.db import IntegrityError, transaction

from core.models import Article, ArticleBlock, ArticleInlineRun


def _block(article, kind="paragraph", parent=None, position=0, **kwargs):
    return ArticleBlock.objects.create(
        article=article, parent=parent, position=position, kind=kind, **kwargs
    )


@pytest.mark.django_db
def test_article_has_a_plain_text_column(article):
    article.plain_text = "flattened body"
    article.save(update_fields=["plain_text"])
    assert Article.objects.get(pk=article.pk).plain_text == "flattened body"


@pytest.mark.django_db
def test_plain_text_defaults_to_empty(article):
    assert article.plain_text == ""


@pytest.mark.django_db
def test_blocks_are_ordered_by_position(article):
    _block(article, position=2)
    _block(article, position=0)
    _block(article, position=1)
    assert [block.position for block in article.blocks.all()] == [0, 1, 2]


@pytest.mark.django_db
def test_children_relate_to_their_parent(article):
    parent = _block(article, kind="list")
    item = _block(article, kind="list_item", parent=parent)
    assert list(parent.children.all()) == [item]


@pytest.mark.django_db
def test_sibling_position_is_unique_under_a_parent(article):
    parent = _block(article, kind="list")
    _block(article, kind="list_item", parent=parent, position=0)
    with pytest.raises(IntegrityError), transaction.atomic():
        _block(article, kind="list_item", parent=parent, position=0)


@pytest.mark.django_db
def test_root_positions_are_not_protected_by_the_constraint(article):
    """SQLite treats NULLs as distinct in a unique index, so root ordering is
    the writer's job -- documented, not pretended away."""
    _block(article, position=0)
    _block(article, position=0)
    assert article.blocks.filter(position=0).count() == 2


@pytest.mark.django_db
def test_runs_are_ordered_by_position(article):
    block = _block(article)
    ArticleInlineRun.objects.create(block=block, position=1, text="b")
    ArticleInlineRun.objects.create(block=block, position=0, text="a")
    assert [run.text for run in block.runs.all()] == ["a", "b"]


@pytest.mark.django_db
def test_run_styles_are_independent_boolean_fields(article):
    block = _block(article)
    run = ArticleInlineRun.objects.create(
        block=block, position=0, text="x", bold=True, strikethrough=True
    )
    run.refresh_from_db()
    assert (run.bold, run.italic, run.code, run.strikethrough) == (True, False, False, True)


@pytest.mark.django_db
def test_deleting_an_article_cascades_to_blocks_and_runs(article):
    block = _block(article)
    ArticleInlineRun.objects.create(block=block, position=0, text="x")
    article.delete()
    assert ArticleBlock.objects.count() == 0
    assert ArticleInlineRun.objects.count() == 0


@pytest.mark.django_db
def test_deleting_a_list_cascades_to_its_item_subtree(article):
    keep = _block(article, position=0)
    parent = _block(article, kind="list", position=1)
    item = _block(article, kind="list_item", parent=parent)
    _block(article, kind="paragraph", parent=item)
    parent.delete()
    assert list(ArticleBlock.objects.all()) == [keep]


@pytest.mark.django_db
def test_str_names_the_kind_and_position(article):
    assert "paragraph" in str(_block(article, position=3))
    block = _block(article)
    assert "x" in str(ArticleInlineRun.objects.create(block=block, position=0, text="x"))
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_block_models.py -q
```

Expected: `ImportError: cannot import name 'ArticleBlock' from 'core.models'`.

- [ ] **Step 3: Add the models**

In `core/models.py`, add `plain_text` to `Article` immediately after `content`:

```python
    plain_text = models.TextField(
        blank=True,
        default="",
        help_text="Block tree flattened to visible text, for search",
    )
```

and add these two models directly after the `Article` class (before `ArticleImage`):

```python
class ArticleBlock(models.Model):
    """
    One node of an article body in the Yana content format.

    Bodies are stored as typed rows rather than HTML or an opaque JSON document,
    so the database understands them: ``image_ref`` is indexed (which turns
    orphan-image pruning into a JOIN) and ``embed_provider`` is indexed (which
    makes "articles containing video" answerable).

    ``list_item`` is the one synthetic kind. A ``list``'s children are
    ``list_item`` rows and each item's children are its actual content blocks --
    the row shape for ``[[Block]]``. It never appears on the wire.

    Derived data: rebuilt wholesale from ``Article.content`` on every
    conversion, and read-only in admin for that reason.
    """

    article = models.ForeignKey(Article, on_delete=models.CASCADE, related_name="blocks")
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.CASCADE, related_name="children"
    )
    position = models.PositiveIntegerField()
    kind = models.CharField(max_length=20, choices=[(kind, kind) for kind in BLOCK_KINDS])

    level = models.PositiveSmallIntegerField(null=True, blank=True)  # heading
    ordered = models.BooleanField(null=True, blank=True)  # list
    text = models.TextField(blank=True, default="")  # code_block
    language = models.CharField(max_length=50, blank=True, default="")  # code_block
    image_ref = models.TextField(blank=True, default="")  # image

    embed_provider = models.CharField(max_length=20, blank=True, default="")
    embed_thumbnail_ref = models.TextField(blank=True, default="")
    embed_external_url = models.TextField(blank=True, default="")
    embed_title = models.TextField(blank=True, default="")

    class Meta:
        verbose_name = "Article Block"
        verbose_name_plural = "Article Blocks"
        ordering = ["position"]
        constraints = [
            # Sibling ordering is unambiguous for nested blocks only: SQLite
            # treats NULLs as distinct in a unique index, so root-level rows
            # (parent IS NULL) are NOT covered. core/blocks/storage.py is what
            # keeps root positions unique.
            models.UniqueConstraint(
                fields=["article", "parent", "position"], name="uniq_block_position"
            ),
        ]
        indexes = [
            models.Index(fields=["article", "parent", "position"]),
            models.Index(fields=["image_ref"]),
            models.Index(fields=["embed_provider"]),
        ]

    def __str__(self):
        return f"{self.kind} #{self.position}"


class ArticleInlineRun(models.Model):
    """
    A styled span of text inside a paragraph, heading or image caption.

    Styles are four real booleans rather than a bitmask int: the whole reason to
    choose rows over a JSON document is that the database understands the data,
    and an opaque integer would hand that back.
    """

    block = models.ForeignKey(ArticleBlock, on_delete=models.CASCADE, related_name="runs")
    position = models.PositiveIntegerField()
    text = models.TextField()
    # One field per style. Never write `bold = italic = ... = BooleanField(...)`:
    # chained assignment binds one field instance to four names and Django
    # mishandles it.
    bold = models.BooleanField(default=False)
    italic = models.BooleanField(default=False)
    code = models.BooleanField(default=False)
    strikethrough = models.BooleanField(default=False)
    link = models.TextField(blank=True, default="")

    class Meta:
        verbose_name = "Article Inline Run"
        verbose_name_plural = "Article Inline Runs"
        ordering = ["position"]
        indexes = [models.Index(fields=["block", "position"])]

    def __str__(self):
        return self.text[:60]
```

Add the import at the top of `core/models.py`, after `from .choices import AGGREGATOR_CHOICES`:

```python
from .blocks.types import BLOCK_KINDS
```

- [ ] **Step 4: Generate and inspect the migration**

```bash
uv run python manage.py makemigrations core
```

Expected: one new migration creating both models and adding `article.plain_text`. Read it before
moving on — it must contain no unrelated field alterations. If `makemigrations` wants to change
anything else, stop and report it.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_block_models.py -q
```

Expected: PASS, 11 tests.

- [ ] **Step 6: Apply the migration and check the indexes exist**

```bash
uv run python manage.py migrate && uv run python manage.py verify_sqlite_optimizations
```

- [ ] **Step 7: Lint, format, type-check, full suite**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest -q
```

- [ ] **Step 8: Commit**

```bash
git add core/models.py core/migrations/ core/tests/test_block_models.py && git commit -m "feat(blocks): Add the ArticleBlock and ArticleInlineRun models"
```

---

## Task 6: Relational storage — write and read block trees

**Files:**
- Create: `core/blocks/storage.py`
- Test: `core/tests/test_block_storage.py`

**Interfaces:**
- Consumes: `core.blocks.types` (Task 1), `core.models.ArticleBlock` / `ArticleInlineRun` (Task 5).
- Produces:
  - `write_blocks(article: Article, blocks: Sequence[Block]) -> int` — replaces the article's stored
    tree, returns rows written.
  - `load_blocks(article: Article) -> list[Block]`
  - `load_blocks_for_articles(article_ids: Sequence[int]) -> dict[int, list[Block]]` — **two queries
    total**, regardless of nesting depth.

- [ ] **Step 1: Write the failing storage tests**

Create `core/tests/test_block_storage.py`:

```python
"""Block trees round-trip through rows, in a bounded number of queries."""

import pytest

from core.blocks.storage import load_blocks, load_blocks_for_articles, write_blocks
from core.blocks.types import (
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
from core.models import ArticleBlock, ArticleInlineRun

TREE = [
    Heading(level=3, runs=[InlineRun(text="Head", bold=True)]),
    Paragraph(runs=[InlineRun(text="Body "), InlineRun(text="link", link="https://x/")]),
    ListBlock(
        ordered=True,
        items=[
            [Paragraph(runs=[InlineRun(text="one")])],
            [
                Paragraph(runs=[InlineRun(text="two")]),
                ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="deep")])]]),
            ],
        ],
    ),
    Blockquote(blocks=[Paragraph(runs=[InlineRun(text="quoted", italic=True)])]),
    ImageBlock(ref="yana-img://" + "a" * 64, caption=[InlineRun(text="cap")]),
    EmbedBlock(
        provider="video",
        external_url="https://v/x.mp4",
        thumbnail_ref="yana-img://" + "b" * 64,
        title="Clip",
    ),
    CodeBlock(text="x = 1\n"),
    Divider(),
]


@pytest.mark.django_db
def test_a_tree_reads_back_identical(article):
    write_blocks(article, TREE)
    assert load_blocks(article) == TREE


@pytest.mark.django_db
def test_writing_returns_the_row_count(article):
    written = write_blocks(article, TREE)
    assert written == ArticleBlock.objects.filter(article=article).count()


@pytest.mark.django_db
def test_nesting_is_stored_as_list_item_rows(article):
    write_blocks(article, [ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="a")])]])])
    kinds = list(ArticleBlock.objects.values_list("kind", flat=True))
    assert sorted(kinds) == ["list", "list_item", "paragraph"]


@pytest.mark.django_db
def test_children_get_their_parent_pk(article):
    """bulk_create must return primary keys, or nesting silently flattens."""
    write_blocks(article, [Blockquote(blocks=[Paragraph(runs=[InlineRun(text="a")])])])
    child = ArticleBlock.objects.get(kind="paragraph")
    assert child.parent_id == ArticleBlock.objects.get(kind="blockquote").pk


@pytest.mark.django_db
def test_root_positions_are_sequential(article):
    write_blocks(article, TREE)
    roots = ArticleBlock.objects.filter(article=article, parent__isnull=True).order_by("position")
    assert [root.position for root in roots] == list(range(len(TREE)))


@pytest.mark.django_db
def test_rewriting_replaces_the_previous_tree(article):
    write_blocks(article, TREE)
    write_blocks(article, [Divider()])
    assert load_blocks(article) == [Divider()]
    assert ArticleBlock.objects.filter(article=article).count() == 1
    assert ArticleInlineRun.objects.count() == 0


@pytest.mark.django_db
def test_writing_nothing_clears_the_tree(article):
    write_blocks(article, TREE)
    assert write_blocks(article, []) == 0
    assert load_blocks(article) == []


@pytest.mark.django_db
def test_reading_many_articles_is_two_queries_regardless_of_depth(
    django_assert_num_queries, articles_batch
):
    for item in articles_batch:
        write_blocks(item, TREE)
    ids = [item.pk for item in articles_batch]
    with django_assert_num_queries(2):
        loaded = load_blocks_for_articles(ids)
    assert all(loaded[article_id] == TREE for article_id in ids)


@pytest.mark.django_db
def test_loading_an_unknown_article_id_yields_an_empty_list(article):
    assert load_blocks_for_articles([article.pk + 999]) == {article.pk + 999: []}


@pytest.mark.django_db
def test_a_list_whose_children_are_not_items_still_reads_back(article):
    """Malformed nesting tolerance: a stray content block under a list is read
    as a single-block item rather than being dropped."""
    write_blocks(article, [ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="a")])]])])
    stray = ArticleBlock.objects.get(kind="list_item")
    ArticleBlock.objects.filter(pk=stray.pk).update(kind="paragraph")
    loaded = load_blocks(article)
    assert isinstance(loaded[0], ListBlock)
    assert loaded[0].items and loaded[0].items[0]


@pytest.mark.django_db
def test_a_stray_root_list_item_is_skipped(article):
    write_blocks(article, [Paragraph(runs=[InlineRun(text="a")])])
    ArticleBlock.objects.filter(article=article).update(kind="list_item")
    assert load_blocks(article) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_block_storage.py -q
```

Expected: `No module named 'core.blocks.storage'`.

- [ ] **Step 3: Write `core/blocks/storage.py`**

```python
"""
Block trees to rows and back.

Writing goes level by level: every depth is one ``bulk_create``, because
children need their parent's primary key. Reading is **two queries total**,
regardless of nesting depth -- one for the rows, one prefetch for the runs --
and the tree is reassembled in Python by grouping on ``parent_id``. No
recursive CTE, no N+1.

Nothing here parses HTML or touches ``Article.content``; that is
``conversion.py``'s job.
"""

import logging
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field

from core.models import Article, ArticleBlock, ArticleInlineRun

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

logger = logging.getLogger(__name__)


@dataclass
class _ListItem:
    """
    The storage-only wrapper for one entry of a ``list``'s ``[[Block]]``.

    A list holds *sequences*, not blocks, so the row model needs a node for
    "one item". It exists between ``write_blocks`` and the ``list_item`` row and
    nowhere else -- never in ``types.py``, never on the wire.
    """

    blocks: list[Block] = field(default_factory=list)


def _row_for(
    article: Article, block: Block | _ListItem, parent: ArticleBlock | None, position: int
) -> ArticleBlock:
    row = ArticleBlock(article=article, parent=parent, position=position)
    match block:
        case _ListItem():
            row.kind = "list_item"
        case Paragraph():
            row.kind = "paragraph"
        case Heading(level=level):
            row.kind = "heading"
            row.level = min(max(level, 1), 6)
        case ListBlock(ordered=ordered):
            row.kind = "list"
            row.ordered = ordered
        case Blockquote():
            row.kind = "blockquote"
        case ImageBlock(ref=ref):
            row.kind = "image"
            row.image_ref = ref
        case EmbedBlock(
            provider=provider, external_url=external_url, thumbnail_ref=thumbnail, title=title
        ):
            row.kind = "embed"
            row.embed_provider = provider
            row.embed_external_url = external_url
            row.embed_thumbnail_ref = thumbnail
            row.embed_title = title
        case CodeBlock(text=text, language=language):
            row.kind = "code_block"
            row.text = text
            row.language = language
        case Divider():
            row.kind = "divider"
        case _:
            raise TypeError(f"not a block: {block!r}")
    return row


def _runs_for(row: ArticleBlock, block: Block | _ListItem) -> list[ArticleInlineRun]:
    match block:
        case Paragraph(runs=runs) | Heading(runs=runs) | ImageBlock(caption=runs):
            source = runs
        case _:
            return []
    return [
        ArticleInlineRun(
            block=row,
            position=position,
            text=run.text,
            bold=run.bold,
            italic=run.italic,
            code=run.code,
            strikethrough=run.strikethrough,
            link=run.link,
        )
        for position, run in enumerate(source)
    ]


def _children_of(
    block: Block | _ListItem, row: ArticleBlock
) -> list[tuple[Block | _ListItem, ArticleBlock, int]]:
    match block:
        case ListBlock(items=items):
            children: Sequence[Block | _ListItem] = [_ListItem(blocks=item) for item in items]
        case _ListItem(blocks=inner) | Blockquote(blocks=inner):
            children = inner
        case _:
            return []
    return [(child, row, position) for position, child in enumerate(children)]


def write_blocks(article: Article, blocks: Sequence[Block]) -> int:
    """
    Replace ``article``'s stored block tree with ``blocks``.

    Root ordering is enforced here, not by the database: the
    ``uniq_block_position`` constraint cannot cover ``parent IS NULL`` rows on
    SQLite, so sequential root positions are this function's contract.
    """
    ArticleBlock.objects.filter(article=article).delete()

    written = 0
    pending_runs: list[ArticleInlineRun] = []
    level: list[tuple[Block | _ListItem, ArticleBlock | None, int]] = [
        (block, None, position) for position, block in enumerate(blocks)
    ]

    while level:
        rows = [_row_for(article, block, parent, position) for block, parent, position in level]
        ArticleBlock.objects.bulk_create(rows)
        written += len(rows)

        next_level: list[tuple[Block | _ListItem, ArticleBlock | None, int]] = []
        for (block, _parent, _position), row in zip(level, rows, strict=True):
            pending_runs.extend(_runs_for(row, block))
            next_level.extend(_children_of(block, row))
        level = next_level

    if pending_runs:
        ArticleInlineRun.objects.bulk_create(pending_runs)
    return written


def _runs_of(row: ArticleBlock) -> list[InlineRun]:
    return [
        InlineRun(
            text=run.text,
            bold=run.bold,
            italic=run.italic,
            code=run.code,
            strikethrough=run.strikethrough,
            link=run.link,
        )
        for run in row.runs.all()
    ]


def _block_for(row: ArticleBlock, children: dict[int, list[ArticleBlock]]) -> Block | None:
    kids = children.get(row.pk, [])
    match row.kind:
        case "paragraph":
            return Paragraph(runs=_runs_of(row))
        case "heading":
            return Heading(level=row.level or 1, runs=_runs_of(row))
        case "list":
            items: list[list[Block]] = []
            for kid in kids:
                if kid.kind == "list_item":
                    item = [
                        block
                        for block in (_block_for(grandkid, children) for grandkid in children.get(kid.pk, []))
                        if block is not None
                    ]
                else:
                    # Malformed nesting: wrap the stray in an item rather than
                    # dropping content.
                    stray = _block_for(kid, children)
                    item = [stray] if stray is not None else []
                if item:
                    items.append(item)
            return ListBlock(ordered=bool(row.ordered), items=items)
        case "blockquote":
            inner = [
                block for block in (_block_for(kid, children) for kid in kids) if block is not None
            ]
            return Blockquote(blocks=inner)
        case "image":
            return ImageBlock(ref=row.image_ref, caption=_runs_of(row))
        case "embed":
            return EmbedBlock(
                provider=row.embed_provider or "generic",
                external_url=row.embed_external_url,
                thumbnail_ref=row.embed_thumbnail_ref,
                title=row.embed_title,
            )
        case "code_block":
            return CodeBlock(text=row.text, language=row.language)
        case "divider":
            return Divider()
    logger.warning("Skipping block row %s with unexpected kind %r", row.pk, row.kind)
    return None


def load_blocks_for_articles(article_ids: Sequence[int]) -> dict[int, list[Block]]:
    """
    Load block trees for several articles at once.

    Two queries: the rows, plus one prefetch for their runs. Grouping happens in
    Python, so depth costs nothing extra.
    """
    rows = list(
        ArticleBlock.objects.filter(article_id__in=article_ids)
        .prefetch_related("runs")
        .order_by("article_id", "parent_id", "position")
    )

    children: dict[int, list[ArticleBlock]] = defaultdict(list)
    roots: dict[int, list[ArticleBlock]] = defaultdict(list)
    for row in rows:
        if row.parent_id is None:
            roots[row.article_id].append(row)
        else:
            children[row.parent_id].append(row)

    result: dict[int, list[Block]] = {}
    for article_id in article_ids:
        blocks: list[Block] = []
        for row in roots.get(article_id, []):
            if row.kind == "list_item":
                # A list_item only means anything under a list.
                logger.warning("Skipping root-level list_item row %s", row.pk)
                continue
            block = _block_for(row, children)
            if block is not None:
                blocks.append(block)
        result[article_id] = blocks
    return result


def load_blocks(article: Article) -> list[Block]:
    """The block tree for one article."""
    return load_blocks_for_articles([article.pk])[article.pk]
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_block_storage.py -q
```

Expected: PASS, 11 tests. If `test_children_get_their_parent_pk` fails with `parent_id is None`, this
build's `bulk_create` is not returning primary keys — stop and report it rather than working around
it; the fix is a different write strategy, not a patch.

- [ ] **Step 5: Lint, format, type-check, full suite**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest -q
```

- [ ] **Step 6: Commit**

```bash
git add core/blocks/storage.py core/tests/test_block_storage.py && git commit -m "feat(blocks): Store and reload block trees as rows"
```

---

## Task 7: Stop emitting the source-link footer

**Files:**
- Modify: `core/aggregators/utils/content_formatter.py:61-114`
- Test: `core/tests/test_content_formatter.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `format_article_content(...)` with an unchanged signature and no `<footer>` in its output.

**Why:** converted naively, that footer becomes a junk paragraph holding a bare URL at the end of
every article. With GReader gone nothing renders `Article.content` directly, so the footer has no
audience, and the article URL is already on `Article.identifier`. The `url` parameter stays — six
aggregators pass it and `build_header_html` callers keep the call shape — but it no longer renders
anything.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_content_formatter.py`:

```python
"""format_article_content: sections in, no source-link footer out."""

from core.aggregators.utils import format_article_content


def test_no_footer_is_emitted():
    html = format_article_content("<p>body</p>", title="T", url="https://example.com/a")
    assert "<footer" not in html
    assert "Source:" not in html


def test_the_article_url_does_not_leak_into_the_body():
    url = "https://example.com/very-specific-path"
    assert url not in format_article_content("<p>body</p>", title="T", url=url)


def test_the_content_section_survives():
    html = format_article_content("<p>body</p>", title="T", url="https://example.com/a")
    assert '<section data-sanitized-class="article-content"><p>body</p></section>' in html


def test_a_header_still_renders_before_the_content():
    html = format_article_content(
        "<p>body</p>",
        title="T",
        url="https://example.com/a",
        header_image_url="yana-img://" + "a" * 64,
    )
    assert html.index("<header") < html.index("article-content")


def test_comments_still_render_after_the_content():
    html = format_article_content(
        "<p>body</p>", title="T", url="https://example.com/a", comments_content="<p>c</p>"
    )
    assert html.index("article-content") < html.index("article-comments")


def test_a_prebuilt_header_is_used_verbatim():
    html = format_article_content(
        "<p>body</p>", title="T", url="https://example.com/a", header_html="<header>HI</header>"
    )
    assert "<header>HI</header>" in html
```

- [ ] **Step 2: Run the tests to verify the footer ones fail**

```bash
uv run pytest core/tests/test_content_formatter.py -q
```

Expected: `test_no_footer_is_emitted` and `test_the_article_url_does_not_leak_into_the_body` FAIL; the
other four pass.

- [ ] **Step 3: Remove the footer**

In `core/aggregators/utils/content_formatter.py`, delete these lines from
`format_article_content`:

```python
    # Footer section
    parts.append(
        f'<footer><p>Source: <a href="{url}" target="_blank" rel="noopener">{url}</a></p></footer>'
    )
```

and update the docstring: change the summary line to
`Format article content with an optional header, the main content, and optional comments.` and replace
the `url` argument line with:

```
        url: Article URL. Retained for call-site compatibility only -- no longer
            rendered. The source link used to live in a <footer> here, which
            block conversion turned into a junk paragraph holding a bare URL at
            the end of every article. Nothing renders Article.content directly
            any more, and Article.identifier already carries the URL.
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_content_formatter.py -q
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full suite — some aggregator tests may assert on content length**

```bash
uv run pytest -q
```

Expected: PASS. If an aggregator test fails on a byte count or an exact-HTML comparison, update that
expectation — the footer's removal is intended. Do **not** restore the footer.

- [ ] **Step 6: Lint, format, type-check**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
```

- [ ] **Step 7: Commit**

```bash
git add core/aggregators/utils/content_formatter.py core/tests/test_content_formatter.py && git commit -m "fix(aggregators): Stop appending the source-link footer to article bodies"
```

---

## Task 8: `convert_article` and the save-path wiring

**Files:**
- Create: `core/blocks/conversion.py`
- Modify: `core/services/aggregator_service.py:98-118`
- Modify: `core/services/article_service.py:99-108`
- Modify: `core/management/commands/test_aggregator.py:336-368`
- Test: `core/tests/test_block_conversion.py`

**Interfaces:**
- Consumes: `blocks_from_html` / `plain_text` (Task 2–4), `write_blocks` (Task 6).
- Produces: `convert_article(article: Article) -> int` — the single conversion entry point, used by
  Tasks 9, 10 and both services.

**Where conversion runs:** at save time, once, in the article-persisting path — mirroring iOS, where
`ArticleUpsert` converts at import and the render path never does.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_block_conversion.py`:

```python
"""convert_article: the one parse -> store -> plain_text entry point."""

from unittest.mock import patch

import pytest

from core.blocks.conversion import convert_article
from core.blocks.storage import load_blocks
from core.blocks.types import Heading, ImageBlock, InlineRun, Paragraph
from core.models import Article, ArticleBlock

BODY = '<h2>Head</h2><p>Body <a href="/rel">link</a></p>'


@pytest.mark.django_db
def test_converting_stores_the_tree(article):
    article.content = BODY
    article.identifier = "https://example.com/news/story"
    article.save()

    written = convert_article(article)

    assert written == 2
    assert load_blocks(article) == [
        Heading(level=2, runs=[InlineRun(text="Head")]),
        Paragraph(
            runs=[
                InlineRun(text="Body "),
                InlineRun(text="link", link="https://example.com/rel"),
            ]
        ),
    ]


@pytest.mark.django_db
def test_converting_populates_plain_text(article):
    article.content = BODY
    article.save()
    convert_article(article)
    assert Article.objects.get(pk=article.pk).plain_text == "Head\n\nBody link"


@pytest.mark.django_db
def test_links_resolve_against_the_article_identifier(article):
    article.content = '<p><a href="/x">l</a></p>'
    article.identifier = "https://example.com/a/b"
    article.save()
    convert_article(article)
    assert load_blocks(article)[0].runs[0].link == "https://example.com/x"


@pytest.mark.django_db
def test_converting_twice_is_idempotent(article):
    article.content = BODY
    article.save()
    convert_article(article)
    first = load_blocks(article)
    convert_article(article)
    assert load_blocks(article) == first
    assert ArticleBlock.objects.filter(article=article).count() == 2


@pytest.mark.django_db
def test_empty_content_stores_nothing_and_clears_plain_text(article):
    article.content = ""
    article.plain_text = "stale"
    article.save()
    assert convert_article(article) == 0
    assert Article.objects.get(pk=article.pk).plain_text == ""


@pytest.mark.django_db
def test_a_parser_failure_leaves_the_article_blockless_and_does_not_raise(article, caplog):
    article.content = BODY
    article.save()
    with patch(
        "core.blocks.conversion.blocks_from_html", side_effect=RuntimeError("boom")
    ):
        assert convert_article(article) == 0
    assert load_blocks(article) == []
    assert str(article.pk) in caplog.text


@pytest.mark.django_db
def test_the_footer_no_longer_produces_a_trailing_url_paragraph(article):
    """Task 7's removal, verified end to end."""
    from core.aggregators.utils import format_article_content

    article.content = format_article_content(
        "<p>body</p>", title="T", url="https://example.com/story"
    )
    article.save()
    convert_article(article)
    assert load_blocks(article) == [Paragraph(runs=[InlineRun(text="body")])]


@pytest.mark.django_db
def test_a_hosted_image_reference_lands_in_image_ref(article):
    ref = "yana-img://" + "a" * 64
    article.content = f'<header><img src="{ref}" alt="T"></header><p>body</p>'
    article.save()
    convert_article(article)
    assert load_blocks(article)[0] == ImageBlock(ref=ref)
    assert ArticleBlock.objects.filter(image_ref=ref).exists()
```

Also create `core/tests/test_block_save_paths.py`:

```python
"""Every path that persists an article converts its blocks."""

from unittest.mock import patch

import pytest

from core.models import Article


@pytest.mark.django_db
def test_aggregation_converts_a_newly_created_article(rss_feed):
    from core.services.aggregator_service import AggregatorService

    articles_data = [
        {
            "identifier": "https://example.com/new",
            "name": "New",
            "raw_content": "<html></html>",
            "content": "<p>fresh body</p>",
            "author": "",
        }
    ]
    with patch("core.services.aggregator_service.get_aggregator") as get_aggregator:
        get_aggregator.return_value.aggregate.return_value = articles_data
        result = AggregatorService.trigger_by_feed_id(rss_feed.id)

    assert result["success"]
    article = Article.objects.get(identifier="https://example.com/new")
    assert [block.kind for block in article.blocks.all()] == ["paragraph"]
    assert article.plain_text == "fresh body"


@pytest.mark.django_db
def test_a_forced_update_reconverts(rss_feed, article):
    from core.services.aggregator_service import AggregatorService

    article.content = "<p>old</p>"
    article.save()
    articles_data = [
        {
            "identifier": article.identifier,
            "name": article.name,
            "raw_content": article.raw_content,
            "content": "<p>new</p>",
            "author": "",
        }
    ]
    with patch("core.services.aggregator_service.get_aggregator") as get_aggregator:
        get_aggregator.return_value.aggregate.return_value = articles_data
        AggregatorService.trigger_by_feed_id(article.feed_id, force_update=True)

    article.refresh_from_db()
    assert article.plain_text == "new"
```

Adjust the two `AggregatorService` tests to whatever mocking style
`core/tests/test_aggregator_service.py` already uses — read it first and follow it rather than
inventing a second convention.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_block_conversion.py core/tests/test_block_save_paths.py -q
```

Expected: `No module named 'core.blocks.conversion'`.

- [ ] **Step 3: Write `core/blocks/conversion.py`**

```python
"""
The single article -> blocks conversion entry point.

Runs at save time, once, in every article-persisting path -- aggregation, the
`test_aggregator` command, article reload, the admin re-convert action and the
backfill command all come through here, so there is exactly one place that
decides what a stored body looks like.

It never raises for a bad body. An unparseable article is stored with zero
blocks and a warning naming its id: an article with no body beats a failed
aggregation run.
"""

import logging

from django.db import transaction

from core.aggregators.utils.block_parser import blocks_from_html, plain_text
from core.models import Article

from .storage import write_blocks

logger = logging.getLogger(__name__)


def convert_article(article: Article) -> int:
    """
    Convert ``article.content`` to blocks, store them and refresh
    ``article.plain_text``. Returns the number of block rows written.
    """
    try:
        blocks = blocks_from_html(article.content or "", base_url=article.identifier or "")
    except Exception:
        logger.warning(
            "Block conversion failed for article %s; storing no blocks", article.pk, exc_info=True
        )
        blocks = []

    with transaction.atomic():
        written = write_blocks(article, blocks)
        article.plain_text = plain_text(blocks)
        article.save(update_fields=["plain_text", "updated_at"])
    return written
```

- [ ] **Step 4: Wire `core/services/aggregator_service.py`**

Add the import near the existing ones:

```python
from ..blocks.conversion import convert_article
```

In the `force_update` branch, after `article.save()` / `updated_count += 1`:

```python
                            if updated:
                                article.save()
                                convert_article(article)
                                updated_count += 1
```

In the create branch, after the `header_data` handling block (so a header image is stored before its
`yana-img://` reference is read out of `content`):

```python
                        convert_article(article)
```

- [ ] **Step 5: Wire `core/services/article_service.py`**

Add `from ..blocks.conversion import convert_article` to the imports, and call it right after the
existing save in `reload_article`:

```python
            article.save(update_fields=["raw_content", "content", "icon"])
            convert_article(article)
```

- [ ] **Step 6: Wire `core/management/commands/test_aggregator.py`**

Add `from core.blocks.conversion import convert_article` to the imports, and inside `_save_articles`,
replace the created/updated counting with:

```python
                if was_created:
                    created += 1
                else:
                    updated += 1
                if was_created or not article.blocks.exists():
                    convert_article(article)
```

The `blocks.exists()` check is the same idempotency rule the backfill uses: an article that already
has a tree is left alone, one that does not gets one.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_block_conversion.py core/tests/test_block_save_paths.py -q
```

Expected: PASS.

- [ ] **Step 8: Lint, format, type-check, full suite**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest -q
```

- [ ] **Step 9: Commit**

```bash
git add core/blocks/conversion.py core/services/ core/management/commands/test_aggregator.py core/tests/test_block_conversion.py core/tests/test_block_save_paths.py && git commit -m "feat(blocks): Convert article bodies to blocks at save time"
```

---

## Task 9: Admin — the verification surface

**Files:**
- Create: `core/blocks/render.py`
- Modify: `core/admin.py:616-737`
- Test: `core/tests/test_block_admin.py`

**Interfaces:**
- Consumes: `load_blocks` (Task 6), `convert_article` (Task 8), `core.blocks.types`.
- Produces: `render_blocks_html(blocks) -> SafeString`; `ArticleBlockInline`; `ArticleAdmin` gains
  `block_preview`, `plain_text` and the `reconvert_blocks` action.

**Why this task is not optional:** this phase has no client. Without a legible tree in admin,
"collect and store the data correctly" is unverifiable — a missing image, a paragraph that swallowed a
heading, or leftover chrome is obvious at a glance in a rendered preview and invisible in a row dump.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_block_admin.py`:

```python
"""Admin makes block trees legible, and never lets them be hand-edited."""

import pytest
from django.contrib.admin.sites import AdminSite
from django.test import RequestFactory

from core.admin import ArticleAdmin, ArticleBlockInline
from core.blocks.conversion import convert_article
from core.blocks.render import render_blocks_html
from core.blocks.types import (
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
from core.models import Article, ArticleBlock, ArticleImage


@pytest.fixture
def article_admin():
    return ArticleAdmin(Article, AdminSite())


def test_render_covers_every_kind():
    html = render_blocks_html(
        [
            Heading(level=2, runs=[InlineRun(text="Head")]),
            Paragraph(runs=[InlineRun(text="Body", bold=True)]),
            ListBlock(ordered=True, items=[[Paragraph(runs=[InlineRun(text="one")])]]),
            Blockquote(blocks=[Paragraph(runs=[InlineRun(text="quoted")])]),
            EmbedBlock(provider="youtube", external_url="https://youtu.be/x", title="Clip"),
            CodeBlock(text="x = 1"),
            Divider(),
        ]
    )
    for expected in ("<h2", "Head", "<strong>Body</strong>", "<ol", "one", "<blockquote", "youtube",
                     "Clip", "<pre", "x = 1", "<hr"):
        assert expected in html, expected


def test_render_escapes_text():
    html = render_blocks_html([Paragraph(runs=[InlineRun(text="<script>x</script>")])])
    assert "<script>" not in html
    assert "&lt;script&gt;" in html


def test_render_turns_a_newline_run_into_a_break():
    assert "<br>" in render_blocks_html([Paragraph(runs=[InlineRun(text="\n")])])


def test_render_links_a_run():
    html = render_blocks_html([Paragraph(runs=[InlineRun(text="t", link="https://x/")])])
    assert 'href="https://x/"' in html


@pytest.mark.django_db
def test_render_resolves_a_stored_image(settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path
    image = ArticleImage.objects.create(
        content_hash="c" * 64, file="article_images/x.jpg", content_type="image/jpeg", byte_size=1
    )
    html = render_blocks_html([ImageBlock(ref=f"yana-img://{image.content_hash}")])
    assert image.file.url in html


@pytest.mark.django_db
def test_render_flags_a_missing_image_reference():
    html = render_blocks_html([ImageBlock(ref="yana-img://" + "d" * 64)])
    assert "missing" in html.lower()


def test_render_of_nothing_says_so():
    assert "No blocks" in render_blocks_html([])


@pytest.mark.django_db
def test_the_change_page_preview_renders_the_stored_tree(article, article_admin):
    article.content = "<h2>Head</h2><p>Body</p>"
    article.save()
    convert_article(article)
    html = article_admin.block_preview(Article.objects.get(pk=article.pk))
    assert "Head" in html
    assert "Body" in html


@pytest.mark.django_db
def test_blocks_are_read_only_in_admin(article):
    inline = ArticleBlockInline(Article, AdminSite())
    request = RequestFactory().get("/")
    assert inline.has_add_permission(request, article) is False
    assert inline.has_change_permission(request, article) is False
    assert inline.has_delete_permission(request, article) is False


@pytest.mark.django_db
def test_the_inline_previews_each_row(article):
    article.content = '<p>Some text</p><img src="yana-img://a"><hr>'
    article.save()
    convert_article(article)
    inline = ArticleBlockInline(Article, AdminSite())
    previews = [inline.preview(row) for row in ArticleBlock.objects.order_by("position")]
    assert previews[0].startswith("Some text")
    assert "yana-img://a" in previews[1]


@pytest.mark.django_db
def test_reconvert_blocks_rebuilds_the_tree_identically(article, article_admin, rf):
    article.content = "<p>a</p><p>b</p>"
    article.save()
    convert_article(article)
    before = list(ArticleBlock.objects.values_list("kind", "position"))

    ArticleBlock.objects.all().delete()
    request = rf.post("/")
    request._messages = _DummyMessages()
    article_admin.reconvert_blocks(request, Article.objects.filter(pk=article.pk))

    assert list(ArticleBlock.objects.values_list("kind", "position")) == before


@pytest.mark.django_db
def test_reconvert_blocks_works_on_a_deferred_queryset(article, article_admin, rf):
    """The changelist defers `content`; re-conversion must not read an empty body."""
    article.content = "<p>a</p>"
    article.save()
    request = rf.post("/")
    request._messages = _DummyMessages()
    queryset = article_admin.get_queryset(rf.get("/")).filter(pk=article.pk)
    article_admin.reconvert_blocks(request, queryset)
    assert ArticleBlock.objects.filter(article=article).count() == 1


class _DummyMessages:
    def __init__(self):
        self.added = []

    def add(self, level, message, extra_tags=""):
        self.added.append((level, message))
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_block_admin.py -q
```

Expected: `No module named 'core.blocks.render'`.

- [ ] **Step 3: Write `core/blocks/render.py`**

```python
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
            text = format_html('<a href="{}" target="_blank" rel="noopener">', run.link) + text + "</a>"
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
                    format_html('<img src="{}" style="max-height:140px;display:block;">', poster_url)
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
```

`mark_safe` is used only on strings assembled from `escape`d text and `format_html` output — never on
raw model data. Keep it that way.

- [ ] **Step 4: Add the inline, fields and action to `core/admin.py`**

Add the imports alongside the existing ones:

```python
from .blocks.conversion import convert_article
from .blocks.render import render_blocks_html
from .blocks.storage import load_blocks
from .models import ArticleBlock  # add to the existing models import
```

Add the inline directly above `ArticleAdmin`:

```python
class ArticleBlockInline(admin.TabularInline):
    """
    The stored block tree, flat and read-only.

    Blocks are derived data: hand-editing one would be silently overwritten on
    the next aggregation and invites inconsistent trees, so add, change and
    delete are all off. Nested rows are shown too, with their parent, so the
    tree's shape is legible without a second screen.
    """

    model = ArticleBlock
    fk_name = "article"
    extra = 0
    max_num = 0
    can_delete = False
    fields = ["parent", "position", "kind", "level", "ordered", "preview"]
    readonly_fields = fields
    ordering = ["parent_id", "position"]
    verbose_name_plural = "Blocks (read-only)"

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_queryset(self, request):
        return super().get_queryset(request).prefetch_related("runs")

    @admin.display(description="Preview")
    def preview(self, obj):
        if obj.kind == "image":
            return obj.image_ref or "-"
        if obj.kind == "embed":
            return f"{obj.embed_provider}: {obj.embed_external_url}"
        if obj.kind == "code_block":
            return obj.text[:120]
        text = "".join(run.text for run in obj.runs.all())[:120]
        return text or "-"
```

In `ArticleAdmin`:

```python
    inlines = [ArticleBlockInline]
    readonly_fields = ["created_at", "updated_at", "referenced_images", "block_preview", "plain_text"]
    actions = ["reload_selected_articles", "reconvert_blocks", "force_delete_selected"]
```

Add a `Blocks` fieldset between `Content` and `Images`:

```python
        ("Blocks", {"fields": ("block_preview", "plain_text")}),
```

Extend the changelist defer — `plain_text` is only needed on the change page, exactly like `content`:

```python
    def get_queryset(self, request):
        qs = super().get_queryset(request)
        return qs.defer("content", "raw_content", "plain_text")
```

Add the preview display and the action:

```python
    @admin.display(description="Rendered blocks")
    def block_preview(self, obj):
        """The block tree rendered as simple HTML -- this is what makes a wrong
        conversion obvious at a glance."""
        if not obj or not obj.pk:
            return "-"
        return render_blocks_html(load_blocks(obj))

    @admin.action(description="Re-convert blocks")
    def reconvert_blocks(self, request, queryset):
        """Rebuild the block tree from Article.content. The iteration loop for
        tuning the parser: change the parser, re-convert, look."""
        # The changelist queryset defers `content`; re-read undeferred so
        # conversion sees the real body.
        articles = Article.objects.filter(pk__in=queryset.values("pk"))
        converted = 0
        blocks_written = 0
        for article in articles:
            blocks_written += convert_article(article)
            converted += 1
        self.message_user(
            request,
            f"Re-converted {converted} article(s), {blocks_written} block(s) written.",
            messages.SUCCESS,
        )
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_block_admin.py -q
```

Expected: PASS.

- [ ] **Step 6: Check the admin pages actually load**

```bash
uv run pytest core/tests/test_article_image_admin.py -q && uv run python manage.py check
```

Expected: PASS and `System check identified no issues`. A malformed inline surfaces here as an
`admin.E***` error.

- [ ] **Step 7: Lint, format, type-check, full suite**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest -q
```

- [ ] **Step 8: Commit**

```bash
git add core/blocks/render.py core/admin.py core/tests/test_block_admin.py && git commit -m "feat(admin): Make block trees inspectable and re-convertible"
```

---

## Task 10: The `convert_articles_to_blocks` backfill

**Files:**
- Create: `core/management/commands/convert_articles_to_blocks.py`
- Test: `core/tests/test_convert_articles_to_blocks.py`

**Interfaces:**
- Consumes: `convert_article` (Task 8).
- Produces: the management command. No Python API.

**Ordering, which the help text must state:** run this **after** `migrate_inline_images`, so bodies
already carry `yana-img://` refs instead of base64 blobs. Converting first would embed a data URI into
`image_ref`. The command enforces it — an article whose `content` still holds `data:image` is reported
and skipped, not converted.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_convert_articles_to_blocks.py`:

```python
"""The block backfill: batched, idempotent, resumable, and ordering-aware."""

from io import StringIO
from unittest.mock import patch

import pytest
from django.core.management import call_command

from core.models import Article, ArticleBlock


def run(*args):
    out = StringIO()
    call_command("convert_articles_to_blocks", *args, stdout=out, stderr=out)
    return out.getvalue()


@pytest.mark.django_db
def test_converts_an_article_with_content(article):
    article.content = "<p>body</p>"
    article.save()
    run()
    assert [block.kind for block in article.blocks.all()] == ["paragraph"]
    assert Article.objects.get(pk=article.pk).plain_text == "body"


@pytest.mark.django_db
def test_is_idempotent_across_two_runs(article):
    article.content = "<p>body</p>"
    article.save()
    run()
    first = list(ArticleBlock.objects.values_list("pk", flat=True))
    output = run()
    assert list(ArticleBlock.objects.values_list("pk", flat=True)) == first
    assert "0" in output


@pytest.mark.django_db
def test_dry_run_writes_nothing(article):
    article.content = "<p>body</p>"
    article.save()
    output = run("--dry-run")
    assert ArticleBlock.objects.count() == 0
    assert Article.objects.get(pk=article.pk).plain_text == ""
    assert "would convert" in output.lower()


@pytest.mark.django_db
def test_dry_run_reports_a_block_count_distribution(articles_batch):
    for index, item in enumerate(articles_batch):
        item.content = "<p>a</p>" * (index + 1)
        item.save()
    output = run("--dry-run")
    assert "block" in output.lower()


@pytest.mark.django_db
def test_limit_stops_early(articles_batch):
    for item in articles_batch:
        item.content = "<p>a</p>"
        item.save()
    run("--limit", "2")
    assert Article.objects.exclude(plain_text="").count() == 2


@pytest.mark.django_db
def test_articles_without_content_are_skipped(article):
    article.content = ""
    article.save()
    run()
    assert ArticleBlock.objects.count() == 0


@pytest.mark.django_db
def test_an_article_still_holding_a_data_uri_is_reported_and_skipped(article):
    article.content = '<p><img src="data:image/png;base64,AAAA"></p>'
    article.save()
    output = run()
    assert ArticleBlock.objects.count() == 0
    assert "migrate_inline_images" in output
    assert str(article.pk) in output


@pytest.mark.django_db
def test_a_parse_failure_leaves_that_article_blockless_and_continues(articles_batch):
    from core.blocks.conversion import convert_article as real_convert
    from core.management.commands import convert_articles_to_blocks as command_module

    for item in articles_batch:
        item.content = "<p>a</p>"
        item.save()
    target = articles_batch[0].pk

    def explode_on_target(article):
        if article.pk == target:
            raise RuntimeError("boom")
        return real_convert(article)

    with patch.object(command_module, "convert_article", side_effect=explode_on_target):
        output = run()

    assert not ArticleBlock.objects.filter(article_id=target).exists()
    assert ArticleBlock.objects.exclude(article_id=target).exists()
    assert str(target) in output


@pytest.mark.django_db
def test_force_reconverts_articles_that_already_have_blocks(article):
    article.content = "<p>body</p>"
    article.save()
    run()
    first = list(ArticleBlock.objects.values_list("pk", flat=True))
    run("--force")
    assert list(ArticleBlock.objects.values_list("pk", flat=True)) != first
    assert ArticleBlock.objects.count() == 1
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_convert_articles_to_blocks.py -q
```

Expected: `CommandError: Unknown command: 'convert_articles_to_blocks'`.

- [ ] **Step 3: Write the command**

```python
"""
Backfill: convert existing ``Article.content`` HTML into stored block trees.

ORDERING: run this **after** ``migrate_inline_images``. That command rewrites
inline ``data:image/...;base64,...`` payloads into ``yana-img://<hash>``
references; converting first would embed a whole data URI into
``ArticleBlock.image_ref``. Articles whose content still holds a data URI are
reported and skipped rather than silently mangled.

Batched, idempotent and resumable: articles that already have blocks are skipped
(use ``--force`` to rebuild them anyway), each article converts on its own, and a
parse failure logs the article id and moves on instead of aborting the run.

Usage:
    python manage.py convert_articles_to_blocks --dry-run
    python manage.py convert_articles_to_blocks --limit 100
    python manage.py convert_articles_to_blocks
    python manage.py convert_articles_to_blocks --force
"""

import logging
from collections import Counter

from django.core.management.base import BaseCommand

from core.aggregators.utils.block_parser import blocks_from_html
from core.blocks.conversion import convert_article
from core.models import Article

logger = logging.getLogger(__name__)

DEFAULT_BATCH_SIZE = 200
DATA_URI_MARKER = "data:image"
REPORT_LIMIT = 20


class Command(BaseCommand):
    help = (
        "Convert Article.content HTML into ArticleBlock trees. Run AFTER "
        "migrate_inline_images, so bodies carry yana-img:// references rather "
        "than inline base64 data URIs."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be converted without writing anything",
        )
        parser.add_argument("--limit", type=int, default=0, help="Convert at most this many articles")
        parser.add_argument(
            "--batch-size",
            type=int,
            default=DEFAULT_BATCH_SIZE,
            help=f"Articles fetched per batch (default: {DEFAULT_BATCH_SIZE})",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="Re-convert articles that already have blocks (use after a parser change)",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        limit = options["limit"]
        force = options["force"]
        batch_size = options["batch_size"]

        queryset = Article.objects.exclude(content="").order_by("pk")
        if not force:
            queryset = queryset.filter(blocks__isnull=True)

        converted = 0
        failed: list[int] = []
        skipped_data_uri: list[int] = []
        distribution: Counter[int] = Counter()

        for article in queryset.iterator(chunk_size=batch_size):
            if limit and converted >= limit:
                break

            if DATA_URI_MARKER in article.content:
                skipped_data_uri.append(article.pk)
                continue

            if dry_run:
                try:
                    count = len(blocks_from_html(article.content, base_url=article.identifier or ""))
                except Exception:
                    logger.warning("Parse failed for article %s", article.pk, exc_info=True)
                    failed.append(article.pk)
                    continue
            else:
                try:
                    count = convert_article(article)
                except Exception:
                    logger.warning("Conversion failed for article %s", article.pk, exc_info=True)
                    failed.append(article.pk)
                    continue

            distribution[count] += 1
            converted += 1

        verb = "would convert" if dry_run else "converted"
        self.stdout.write(self.style.SUCCESS(f"{verb} {converted} article(s)"))

        if distribution:
            summary = ", ".join(
                f"{blocks} block(s): {count} article(s)"
                for blocks, count in sorted(distribution.items())
            )
            self.stdout.write(f"Block-count distribution -- {summary}")

        if skipped_data_uri:
            shown = ", ".join(str(pk) for pk in skipped_data_uri[:REPORT_LIMIT])
            suffix = "" if len(skipped_data_uri) <= REPORT_LIMIT else ", ..."
            self.stdout.write(
                self.style.WARNING(
                    f"{len(skipped_data_uri)} article(s) skipped: content still holds an inline "
                    f"data URI -- run migrate_inline_images first. IDs: {shown}{suffix}"
                )
            )

        if failed:
            shown = ", ".join(str(pk) for pk in failed[:REPORT_LIMIT])
            suffix = "" if len(failed) <= REPORT_LIMIT else ", ..."
            self.stdout.write(
                self.style.WARNING(
                    f"{len(failed)} article(s) left blockless after a failure. IDs: {shown}{suffix}"
                )
            )
```

Note on `--force`: it re-converts, and `convert_article` → `write_blocks` deletes the old rows first,
so the row count stays right and the PKs change. That is what
`test_force_reconverts_articles_that_already_have_blocks` asserts.

Note on `blocks__isnull=True`: this is a `LEFT JOIN` filter on a reverse FK, which can duplicate rows
when combined with other joins. It does not here (no other join, and `blocks` is `NULL`-only by
definition of the filter), but if a future edit adds a join, add `.distinct()`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_convert_articles_to_blocks.py -q
```

Expected: PASS, 9 tests. Simplify `test_a_parse_failure_leaves_that_article_blockless_and_continues`
if the patch plumbing fights you — what must be asserted is: the failing article ends up blockless,
every other article still converts, and the failing id appears in the output.

- [ ] **Step 5: Exercise it against the real database**

```bash
uv run python manage.py convert_articles_to_blocks --dry-run
```

Expected: a count and a block-count distribution. If it reports articles skipped for data URIs, run
`uv run python manage.py migrate_inline_images` first, then repeat.

- [ ] **Step 6: Lint, format, type-check, full suite**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest -q
```

- [ ] **Step 7: Commit**

```bash
git add core/management/commands/convert_articles_to_blocks.py core/tests/test_convert_articles_to_blocks.py && git commit -m "feat(blocks): Add the convert_articles_to_blocks backfill command"
```

---

## Task 11: Prune orphaned images via the block index

**Files:**
- Modify: `core/management/commands/prune_orphaned_images.py:1-21,147-158`
- Test: `core/tests/test_prune_orphaned_images.py` (append)

**Interfaces:**
- Consumes: `ArticleBlock.image_ref` / `.embed_thumbnail_ref` (Task 5), populated by Task 8.
- Produces: no API change — same command, same flags, same output shape.

**Why:** the command's own docstring says it scans every `Article.content` for `yana-img://` hashes
"until Spec 5 lands", and that this becomes a JOIN once `ArticleBlock.image_ref` exists and is indexed.
It now exists and is indexed. Two corrections to the spec's one-line description (deviation 5):
`embed_thumbnail_ref` also holds `yana-img://` references and must be counted, and articles that have
no blocks — a conversion failure, or content written before the backfill ran — still carry their
references only in `content`, so a scan restricted to those articles stays as a safety net.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/test_prune_orphaned_images.py` (match the module's existing fixture and helper
style — read it first):

```python
@pytest.mark.django_db
def test_an_image_referenced_only_by_a_block_is_kept(settings, tmp_path, article):
    settings.MEDIA_ROOT = tmp_path
    image = _stored_image("a" * 64)
    _age(image)
    article.content = ""
    article.save()
    ArticleBlock.objects.create(
        article=article,
        position=0,
        kind="image",
        image_ref=f"yana-img://{image.content_hash}",
    )
    call_command("prune_orphaned_images")
    assert ArticleImage.objects.filter(pk=image.pk).exists()


@pytest.mark.django_db
def test_an_embed_thumbnail_reference_is_counted(settings, tmp_path, article):
    settings.MEDIA_ROOT = tmp_path
    image = _stored_image("b" * 64)
    _age(image)
    article.content = ""
    article.save()
    ArticleBlock.objects.create(
        article=article,
        position=0,
        kind="embed",
        embed_provider="youtube",
        embed_external_url="https://youtu.be/x",
        embed_thumbnail_ref=f"yana-img://{image.content_hash}",
    )
    call_command("prune_orphaned_images")
    assert ArticleImage.objects.filter(pk=image.pk).exists()


@pytest.mark.django_db
def test_a_blockless_articles_content_reference_is_still_honoured(settings, tmp_path, article):
    """A conversion failure must not turn into image loss."""
    settings.MEDIA_ROOT = tmp_path
    image = _stored_image("c" * 64)
    _age(image)
    article.content = f'<p><img src="yana-img://{image.content_hash}"></p>'
    article.save()
    assert not article.blocks.exists()
    call_command("prune_orphaned_images")
    assert ArticleImage.objects.filter(pk=image.pk).exists()


@pytest.mark.django_db
def test_an_unreferenced_image_is_still_deleted(settings, tmp_path, article):
    settings.MEDIA_ROOT = tmp_path
    image = _stored_image("d" * 64)
    _age(image)
    article.content = ""
    article.save()
    convert_article(article)
    call_command("prune_orphaned_images")
    assert not ArticleImage.objects.filter(pk=image.pk).exists()


@pytest.mark.django_db
def test_content_of_an_article_that_has_blocks_is_not_scanned(settings, tmp_path, article):
    """Once an article has a tree, its blocks are the authority: a stale hash
    left behind in content must not keep an image alive forever."""
    settings.MEDIA_ROOT = tmp_path
    image = _stored_image("e" * 64)
    _age(image)
    article.content = f'<p>stale <img src="yana-img://{image.content_hash}"></p>'
    article.save()
    ArticleBlock.objects.create(article=article, position=0, kind="divider")
    call_command("prune_orphaned_images")
    assert not ArticleImage.objects.filter(pk=image.pk).exists()
```

If `core/tests/test_prune_orphaned_images.py` already has equivalents of `_stored_image` / `_age`,
reuse them. Otherwise add these two helpers to the module, plus the imports the new tests need
(`ArticleBlock`, `core.blocks.conversion.convert_article`, `timedelta`, `django.utils.timezone`):

```python
def _stored_image(content_hash: str) -> ArticleImage:
    """An ArticleImage with a real file on disk under the test's MEDIA_ROOT."""
    image = ArticleImage.objects.create(
        content_hash=content_hash,
        content_type="image/jpeg",
        byte_size=4,
    )
    image.file.save(f"{content_hash[:12]}.jpg", ContentFile(b"\xff\xd8\xff\xd9"), save=True)
    return image


def _age(image: ArticleImage, days: int = 30) -> None:
    """Backdate past the seven-day --min-age default. `created_at` is
    auto_now_add, so it has to be written with an UPDATE."""
    ArticleImage.objects.filter(pk=image.pk).update(
        created_at=timezone.now() - timedelta(days=days)
    )
```

`ContentFile` comes from `django.core.files.base`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_prune_orphaned_images.py -q
```

Expected: the block-reference tests fail — the current `_referenced_hashes` only reads
`Article.content`, so a block-only reference is treated as an orphan and deleted.

- [ ] **Step 3: Rewrite `_referenced_hashes`**

```python
    @staticmethod
    def _referenced_hashes() -> set[str]:
        """
        Every hash any article still references.

        Blocks are the authority: ``image_ref`` and ``embed_thumbnail_ref`` are
        both ``yana-img://`` references and ``image_ref`` is indexed, which is
        what turns this from a full-text scan of every article body into an
        index read.

        Articles with **no** blocks are the exception and still get scanned. A
        conversion failure or a body written before the backfill ran keeps its
        references only in ``content``, and reaping those images would be
        permanent data loss for a recoverable problem. Once an article has a
        tree, its ``content`` is deliberately ignored -- a hash left behind
        there by an earlier conversion is stale, not a reference.
        """
        referenced: set[str] = set()

        for column in ("image_ref", "embed_thumbnail_ref"):
            values = (
                ArticleBlock.objects.exclude(**{column: ""})
                .values_list(column, flat=True)
                .distinct()
                .iterator(chunk_size=SCAN_CHUNK_SIZE)
            )
            for value in values:
                referenced |= find_image_refs(value)

        contents = (
            Article.objects.filter(blocks__isnull=True)
            .exclude(content="")
            .values_list("content", flat=True)
            .iterator(chunk_size=SCAN_CHUNK_SIZE)
        )
        for content in contents:
            referenced |= find_image_refs(content)

        return referenced
```

Add `ArticleBlock` to the models import:

```python
from core.models import Article, ArticleBlock, ArticleImage
```

- [ ] **Step 4: Update the module docstring**

Replace the whole `EFFICIENCY CAVEAT (temporary)` paragraph with:

```
References live in ``ArticleBlock.image_ref`` and ``ArticleBlock.embed_thumbnail_ref``,
and ``image_ref`` is indexed -- so finding them is an index read rather than a
full-text scan of every article body. Articles that have no blocks at all (a
failed conversion, or content predating the backfill) are the one exception:
their ``content`` is still scanned, because their references exist nowhere else.
```

and change the "The command also reports rows whose file is gone" paragraph's lead-in only if it reads
oddly next to the new text. Also update the two comments inside `handle` that say "one more full pass
over Article.content" — the re-snapshot is still correct and still needed for the same race, but it is
no longer a content scan. Keep the race explanation; fix the mechanism description.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_prune_orphaned_images.py -q
```

Expected: PASS, including every pre-existing test in the module.

- [ ] **Step 6: Lint, format, type-check, full suite**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest -q
```

- [ ] **Step 7: Commit**

```bash
git add core/management/commands/prune_orphaned_images.py core/tests/test_prune_orphaned_images.py && git commit -m "perf(images): Find image references through the block index"
```

---

## Task 12: Delete the embed proxy views and routes

**Files:**
- Modify: `core/views/default.py` (delete `youtube_proxy_view`, `dailymotion_proxy_view` and their
  private helpers)
- Modify: `core/views/__init__.py`, `core/urls/default.py`
- Test: `core/tests/test_default_views.py` (drop the three proxy tests, add route-gone assertions)

**Interfaces:**
- Consumes: the guarantee from Task 4 that no `embed` block's `external_url` points at a proxy path.
- Produces: `core.views` exporting `health_check` only.

**What stays, and why (deviation 2):** `create_youtube_embed_html`, `get_youtube_proxy_url`,
`process_dailymotion_blocks`'s proxy URL and `html_cleaner`'s iframe allowlist all stay. That markup is
now purely an internal marker between extraction and block conversion — the parser reads the video id
out of it and writes a canonical `https://www.youtube.com/watch?v=<id>`, so nothing stored or served
ever points at a proxy path. `Article.content` (kept for one release) will contain iframes whose `src`
now 404s; nothing renders it.

- [ ] **Step 1: Confirm nothing stored references a proxy path**

```bash
uv run python -c "
import django, os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'yana.settings')
django.setup()
from core.models import ArticleBlock
bad = ArticleBlock.objects.filter(embed_external_url__contains='-proxy')
print('embed blocks pointing at a proxy:', bad.count())
for block in bad[:5]:
    print(' ', block.pk, block.embed_external_url)
"
```

Expected: `0`. If it is not 0, **stop** — the parser is emitting proxy URLs and Task 4 needs fixing
before anything is deleted.

- [ ] **Step 2: Write the failing tests**

In `core/tests/test_default_views.py`, delete `test_youtube_proxy_view_missing_id`,
`test_youtube_proxy_view_success` and `test_youtube_proxy_view_params`, and add:

```python
class TestProxyViewsRemoved:
    """The embed proxies served HTML players for the GReader-era article body.
    Embeds are typed blocks now and the client plays them itself."""

    def test_the_youtube_proxy_route_is_gone(self, client):
        assert client.get("/api/youtube-proxy?v=abc").status_code in (301, 302, 404)

    def test_the_dailymotion_proxy_route_is_gone(self, client):
        assert client.get("/api/dailymotion-proxy?v=abc").status_code in (301, 302, 404)

    def test_the_views_are_no_longer_exported(self):
        import core.views

        assert not hasattr(core.views, "youtube_proxy_view")
        assert not hasattr(core.views, "dailymotion_proxy_view")

    def test_health_check_still_works(self, client):
        assert client.get("/health/").status_code == 200
```

The status-code tuple is deliberate: `yana/urls.py` has a catch-all redirect to admin, so an unrouted
path may 302 rather than 404. Assert the route is *not* serving a player, not a specific code.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_default_views.py -q
```

Expected: the removal tests fail (the routes still serve 200 and the attributes still exist).

- [ ] **Step 4: Delete the views**

From `core/views/default.py`, delete `youtube_proxy_view`, `dailymotion_proxy_view`,
`_generate_embed_html`, `_generate_dailymotion_embed_html` and `_error_response` (all four helpers
exist only for the proxies — check with `grep -n "_error_response\|_generate_" core/` before deleting,
and keep anything `health_check` uses). Drop the now-unused imports: `urlencode`,
`xframe_options_exempt`, and `HttpResponse` if nothing else uses it. Update the module docstring to
`"""Default views for health checks."""`.

- [ ] **Step 5: Update the exports and routes**

`core/views/__init__.py`:

```python
"""Core application views."""

from .default import health_check

__all__ = [
    "health_check",
]
```

`core/urls/default.py`:

```python
"""Default URL configuration for core app."""

from django.urls import path

from core import views

urlpatterns = [
    path("health/", views.health_check, name="health_check"),
]
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_default_views.py -q && uv run python manage.py check
```

Expected: PASS and no system-check issues. A leftover `reverse("youtube_proxy")` anywhere would show
up here — `grep -rn "youtube_proxy\|dailymotion_proxy" core/ yana/` should only match
`get_youtube_proxy_url`, the Dailymotion URL literal in `mein_mmo/content_extraction.py`, and
`html_cleaner`'s allowlist.

- [ ] **Step 7: Note why the markup outlives the endpoint**

Add a short comment above `get_youtube_proxy_url` in `core/aggregators/utils/youtube.py`:

```python
# The /api/youtube-proxy endpoint no longer exists. This URL survives as the
# internal marker the block parser reads the video id out of: it rewrites the
# embed to a canonical https://www.youtube.com/watch?v=<id> before anything is
# stored, so nothing ever fetches this path. See
# core/aggregators/utils/block_parser.py::_embed_facade.
```

and an equivalent one above the `proxy_url` assignment in
`core/aggregators/mein_mmo/content_extraction.py` and above the iframe allowlist in
`core/aggregators/utils/html_cleaner.py::sanitize_html_attributes`.

- [ ] **Step 8: Lint, format, type-check, full suite**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest -q
```

- [ ] **Step 9: Commit**

```bash
git add core/views/ core/urls/default.py core/aggregators/utils/youtube.py core/aggregators/utils/html_cleaner.py core/aggregators/mein_mmo/content_extraction.py core/tests/test_default_views.py && git commit -m "refactor(views): Delete the YouTube and Dailymotion embed proxies"
```

---

## Task 13: End-to-end verification through admin, and documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `core/aggregators/README.md`
- No new tests — this task verifies what the previous twelve built and records it.

**Interfaces:** none. This is the task that decides whether the route actually works.

- [ ] **Step 1: Migrate and aggregate a rich article**

```bash
uv run python manage.py migrate
```

Then find a MeinMMO feed id and run it — MeinMMO is the reference implementation and produces images,
embeds and lists in one article:

```bash
uv run python manage.py test_aggregator mein_mmo --first 1 --verbose
```

Expected: articles saved, no conversion warnings in the output.

- [ ] **Step 2: Inspect that article in admin**

```bash
uv run python manage.py runserver
```

Open `http://localhost:8000/admin/core/article/`, open the newest MeinMMO article, and check all five:

1. The **Blocks (read-only)** inline shows a sensible tree — paragraphs, headings, an image, a list —
   with parents on the nested rows.
2. The **Rendered blocks** preview reads like the article.
3. There is **no trailing paragraph holding a bare URL** (the footer is gone).
4. **Plain text** is populated and readable.
5. Nothing meaningful is missing versus the **Content** field, which is still populated this release.

Record what you checked. If the preview is missing an image or has swallowed a heading, that is a
parser bug — fix it in `block_parser.py` with a new failing test in `test_block_parser.py` first, then
use **Re-convert blocks** on the article and look again.

- [ ] **Step 3: Verify the Reddit/Giphy image case specifically**

```bash
uv run python manage.py test_aggregator <a reddit feed id> --first 3 --verbose
```

Open a Giphy or direct-image post in admin and confirm an `image` block is present. This is the
`<p><img></p>` regression the parser exists to handle; a missing image here means
`test_paragraph_wrapping_only_an_image_yields_the_image` is passing on a case the real markup does not
match.

- [ ] **Step 4: Verify an embed and a video**

Open a MeinMMO article with a YouTube embed and a Tagesschau article with video. Confirm an `embed`
block with the right `provider`, a canonical `externalURL`, and — for the video — a thumbnail.

- [ ] **Step 5: Backfill the whole table**

```bash
uv run python manage.py migrate_inline_images --dry-run
uv run python manage.py convert_articles_to_blocks --dry-run
uv run python manage.py convert_articles_to_blocks
```

Then spot-check several articles across different aggregators in admin — at minimum one RSS, one
YouTube, one podcast and one comic feed, since those four take different content paths.

- [ ] **Step 6: Exercise "Re-convert blocks"**

Select one article in the changelist, run **Re-convert blocks**, and confirm the tree is rebuilt
identically (same kinds, same positions, same preview).

- [ ] **Step 7: Prune, now that blocks carry the references**

```bash
uv run python manage.py prune_orphaned_images --dry-run
```

Expected: the referenced count is at least as high as before the backfill, and the "would delete"
count is not suspiciously large. **If it wants to delete a lot, stop** — that is the signature of a
reference the block index is missing, and running it for real would be permanent loss.

- [ ] **Step 8: Update `CLAUDE.md`**

Four edits:

1. **HTTP Surface table** — delete the `/api/youtube-proxy`, `/api/dailymotion-proxy` row and its
   "(interim)" note. Add a `plain_text`/blocks note to the paragraph above if it helps, and update the
   sentence about the Google Reader API to also mention that embed proxies are gone.
2. **Key Models table** — add:

   | `ArticleBlock` | article, parent, position, kind, level, ordered, text, image_ref, embed_* | Block tree rows; `list_item` is storage-only |
   | `ArticleInlineRun` | block, position, text, bold/italic/code/strikethrough, link | Styled spans; one boolean per style |

   and add `plain_text` to `Article`'s field list.
3. **Project Structure** — add under `core/`:

   ```
   ├── blocks/                    # The Yana content format
   │   ├── types.py              # Block dataclasses
   │   ├── schema.py             # Pinned wire JSON (version 1)
   │   ├── storage.py            # Blocks <-> rows
   │   ├── conversion.py         # convert_article() -- the one entry point
   │   └── render.py             # Admin preview rendering
   ```

   plus `block_parser.py` under `aggregators/utils/` and `convert_articles_to_blocks.py` under
   `management/commands/`.
4. Add a subsection after **Article images**:

   ```markdown
   **Article bodies:** bodies are stored as the *Yana content format* -- typed `ArticleBlock` /
   `ArticleInlineRun` rows, the same block model the iOS reader renders. HTML remains internal
   pipeline state between extraction and block conversion; `Article.content` is still populated but
   is no longer a contract and is slated for removal once blocks are trusted. Conversion happens once
   at save time via `core/blocks/conversion.py::convert_article`, never on a read path. The wire
   format is pinned in `core/blocks/schema.py` (version 1) and its golden fixture,
   `core/tests/fixtures/blocks_golden_v1.json`, is the contract the iOS client tests against too.
   `convert_articles_to_blocks` backfills existing articles -- **after** `migrate_inline_images`.
   ```

- [ ] **Step 9: Update `core/aggregators/README.md`**

Add a short section noting that (a) `format_article_content` no longer appends a source-link footer,
and (b) whatever HTML an aggregator produces is converted to blocks at save time, so a new aggregator
should be checked in admin's rendered-block preview and not only by reading `content`. Point at
`core/aggregators/utils/block_parser.py` for the tag → block mapping, and mention the drop-vs-recurse
rule so a new scraper's wrapper markup is written with it in mind.

- [ ] **Step 10: Full check**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

Expected: all green, coverage still above 80%. Report the actual numbers, not "looks fine".

- [ ] **Step 11: Commit**

```bash
git add CLAUDE.md core/aggregators/README.md && git commit -m "docs(blocks): Document the Yana content format and the block pipeline"
```

---

## Self-review notes

Checked against the spec, section by section:

| Spec section | Covered by |
|---|---|
| Part 1 — the pinned schema | Task 1 |
| Part 1 — iOS-side work | Out of scope, handed off; contract artifact is Task 1's golden fixture |
| Part 2 — tag handling table | Tasks 2–4 (every row: `p`, `h1`–`h6`, `ul`/`ol`, `blockquote`, `pre`, `hr`, `img`, `video`, `figure`, `br`, default recursion) |
| Part 2 — `<p><img></p>` | Task 3, step 4 + its two tests |
| Part 2 — drop vs. recurse | Task 2 (`DROPPED_TAGS`, unknown-wrapper branch, and the table-cell leak test) |
| Part 2 — `plain_text` | Task 2 |
| Part 2 — conversion at save time | Task 8 |
| Part 2 — the footer | Task 7 |
| Part 3 — models | Task 5 |
| Part 3 — `list_item` design note | Task 5 docstring, Task 6 `_ListItem` |
| Part 3 — root-ordering caveat | Task 5 (constraint comment + test), Task 6 (`write_blocks` contract) |
| Part 3 — indexed `image_ref` → prune rewrite | Task 11 |
| Part 3 — bounded read query count | Task 6 (`django_assert_num_queries(2)`) |
| Part 3 — `bulk_create` per depth | Task 6 |
| Part 3 — `Article.content` survives one release | Global constraints; untouched everywhere |
| Backfill | Task 10 (all five requirements, plus the data-URI ordering guard) |
| Admin | Task 9 (inline, rendered preview, `plain_text`, read-only, re-convert action) |
| Error handling — unparseable HTML | Task 8 (`convert_article`'s except, and its test) |
| Error handling — unknown tag | Task 2 |
| Error handling — unknown block type | Task 1 |
| Error handling — malformed list nesting | Task 6 (`_block_for`'s stray-child wrap, and its test) |
| Error handling — empty blocks not persisted | Tasks 2–3 (paragraph, heading, list, blockquote, `pre`, `img` all guarded) |
| Error handling — cascades | Task 5 |
| Testing — parser / schema / storage / backfill | Tasks 1–4, 6, 10 |
| Verification via admin (9 steps) | Task 13 |
| Revisiting the embed proxies | Task 12 |

Two spec details deliberately answered differently, both recorded in **Deviations** with reasons: the
embed facade's real shape on this server (1, 2), and the reference set `prune_orphaned_images` builds
(5). One spec silence filled in: where the schema and storage modules live (`core/blocks/`, with the
parser at the path the spec names).
