"""Block trees round-trip through rows, in a bounded number of queries."""

import logging

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
    write_blocks(
        article, [ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="a")])]])]
    )
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
    write_blocks(
        article, [ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="a")])]])]
    )
    stray = ArticleBlock.objects.get(kind="list_item")
    ArticleBlock.objects.filter(pk=stray.pk).update(kind="paragraph")
    loaded = load_blocks(article)
    assert isinstance(loaded[0], ListBlock)
    assert loaded[0].items and loaded[0].items[0]


@pytest.mark.django_db
def test_a_stray_root_list_item_is_skipped(article, caplog):
    write_blocks(article, [Paragraph(runs=[InlineRun(text="a")])])
    ArticleBlock.objects.filter(article=article).update(kind="list_item")
    # settings.py's LOGGING sets `"core": {"propagate": False}`, so records
    # from `core.blocks.storage` never reach caplog's root-attached handler
    # by propagation alone -- attach it here directly.
    storage_logger = logging.getLogger("core.blocks.storage")
    storage_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level("WARNING", logger="core.blocks.storage"):
            assert load_blocks(article) == []
    finally:
        storage_logger.removeHandler(caplog.handler)
    assert "Skipping root-level list_item row" in caplog.text


@pytest.mark.django_db
def test_a_list_keeps_its_empty_items(article):
    """An empty item -- a `list_item` row with no children -- is a real, if
    unusual, entry in `ListBlock.items` and must round-trip as `[]`, not be
    dropped. Whether an empty item should exist is the writer's/parser's call,
    not the reader's."""
    tree = [ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="a")])], []])]
    write_blocks(article, tree)
    assert load_blocks(article) == tree
