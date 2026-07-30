"""The block backfill: batched, idempotent, resumable, and ordering-aware."""

from io import StringIO
from unittest.mock import patch

from django.core.management import call_command

import pytest

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
