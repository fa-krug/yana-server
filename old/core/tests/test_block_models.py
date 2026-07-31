"""Relational storage for block trees: shape, ordering and cascades."""

from django.db import IntegrityError, transaction

import pytest

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
