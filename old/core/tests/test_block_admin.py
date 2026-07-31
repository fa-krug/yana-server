"""Admin makes block trees legible, and never lets them be hand-edited."""

from unittest.mock import patch

from django.contrib.admin.sites import AdminSite
from django.db import connection
from django.test import RequestFactory
from django.test.utils import CaptureQueriesContext

import pytest

from core.admin import ArticleAdmin, ArticleBlockInline
from core.blocks.conversion import convert_article
from core.blocks.render import render_blocks_html
from core.blocks.storage import write_blocks
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
    for expected in (
        "<h2",
        "Head",
        "<strong>Body</strong>",
        "<ol",
        "one",
        "<blockquote",
        "youtube",
        "Clip",
        "<pre",
        "x = 1",
        "<hr",
    ):
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


def test_render_refuses_to_link_an_unsafe_scheme():
    """Defense in depth: rows written before the parser rejected dangerous
    schemes (or written by anything else that skips the parser) must still
    never become a clickable anchor here."""
    html = render_blocks_html([Paragraph(runs=[InlineRun(text="t", link="javascript:alert(1)")])])
    assert "<a href" not in html
    assert "t" in html


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

    with patch.object(ArticleAdmin, "message_user", lambda *args, **kwargs: None):
        article_admin.reconvert_blocks(request, Article.objects.filter(pk=article.pk))

    assert list(ArticleBlock.objects.values_list("kind", "position")) == before


@pytest.mark.django_db
def test_inline_queryset_avoids_the_parent_n_plus_one(article, admin_user):
    """`parent` is a readonly column (see `ArticleBlockInline.fields`), and
    Django's readonly-field rendering does an uncached `getattr(obj, "parent")`
    per row -- without `select_related("parent")` that's one query per row on
    top of the base fetch, the change page's primary N+1. Bounded rather than
    exact: an unrelated admin change should not be able to break this test by
    shifting an incidental query by one."""
    tree = [
        ListBlock(
            ordered=False,
            items=[[Paragraph(runs=[InlineRun(text=f"item {i}")])] for i in range(20)],
        )
    ]
    write_blocks(article, tree)
    assert ArticleBlock.objects.filter(article=article).count() == 41

    inline = ArticleBlockInline(Article, AdminSite())
    request = RequestFactory().get("/")
    request.user = admin_user

    with CaptureQueriesContext(connection) as queries:
        rows = list(inline.get_queryset(request).filter(article=article))
        for row in rows:
            _ = row.parent  # what the readonly-field renderer touches
            inline.preview(row)

    assert len(queries) < 20


@pytest.mark.django_db
def test_referenced_images_ignores_stale_content_once_blocks_exist(
    article, article_admin, settings, tmp_path
):
    """`content` can hold a stale `yana-img://` hash left behind by an earlier
    conversion. Once the article has a block tree, blocks are the authority
    (the same rule the orphan-image reaper uses) -- admin must not report
    that stale hash as referenced, or it would show an image as safe that the
    reaper is about to delete."""
    settings.MEDIA_ROOT = tmp_path
    stale = ArticleImage.objects.create(
        content_hash="a" * 64,
        file="article_images/stale.jpg",
        content_type="image/jpeg",
        byte_size=1,
    )
    live = ArticleImage.objects.create(
        content_hash="b" * 64,
        file="article_images/live.jpg",
        content_type="image/jpeg",
        byte_size=1,
    )
    article.content = f'<img src="yana-img://{stale.content_hash}">'
    article.save()
    ArticleBlock.objects.create(
        article=article, position=0, kind="image", image_ref=f"yana-img://{live.content_hash}"
    )

    html = article_admin.referenced_images(Article.objects.get(pk=article.pk))

    assert "live.jpg" in html
    assert "stale.jpg" not in html


@pytest.mark.django_db
def test_reconvert_blocks_works_on_a_deferred_queryset(article, article_admin, rf):
    """The changelist defers `content`; re-conversion must not read an empty body."""
    article.content = "<p>a</p>"
    article.save()
    request = rf.post("/")
    queryset = article_admin.get_queryset(rf.get("/")).filter(pk=article.pk)

    with patch.object(ArticleAdmin, "message_user", lambda *args, **kwargs: None):
        article_admin.reconvert_blocks(request, queryset)

    assert ArticleBlock.objects.filter(article=article).count() == 1
