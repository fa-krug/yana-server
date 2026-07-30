"""convert_article: the one parse -> store -> plain_text entry point."""

import logging
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
    # settings.py's LOGGING sets `"core": {"propagate": False}`, so records
    # from `core.blocks.conversion` never reach caplog's root-attached handler
    # by propagation alone -- attach it here directly.
    conversion_logger = logging.getLogger("core.blocks.conversion")
    conversion_logger.addHandler(caplog.handler)
    try:
        with (
            caplog.at_level("WARNING", logger="core.blocks.conversion"),
            patch("core.blocks.conversion.blocks_from_html", side_effect=RuntimeError("boom")),
        ):
            assert convert_article(article) == 0
    finally:
        conversion_logger.removeHandler(caplog.handler)
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
