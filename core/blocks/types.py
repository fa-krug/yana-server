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


Block = Paragraph | Heading | ListBlock | Blockquote | ImageBlock | EmbedBlock | CodeBlock | Divider
