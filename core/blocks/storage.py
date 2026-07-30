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
                        for block in (
                            _block_for(grandkid, children) for grandkid in children.get(kid.pk, [])
                        )
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
