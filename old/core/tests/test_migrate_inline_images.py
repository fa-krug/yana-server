"""Tests for the inline-image backfill command."""

import base64
import hashlib
import io
import logging
import random
from io import StringIO

from django.core.management import call_command

import pytest
from PIL import Image

from core.aggregators.services.image_extraction.compression import compress_image
from core.aggregators.services.image_store import store_image_bytes
from core.models import Article, ArticleImage


def noisy_png(seed: int = 0, size: tuple[int, int] = (300, 300)) -> bytes:
    """A deterministic PNG big enough to clear compression's 5KB floor.

    A linear formula over the pixel index is exactly the kind of pattern
    PNG's row filters compress away -- it landed under 5000 bytes, the floor
    below which compress_image() skips compression entirely (see
    core/tests/test_image_store.py::noisy_png). True pseudo-random pixels
    (still seeded, so still deterministic per call) defeat that filtering and
    land comfortably over the floor.
    """
    width, height = size
    rng = random.Random(seed)
    img = Image.new("RGB", size)
    img.putdata(
        [
            (rng.randrange(256), rng.randrange(256), rng.randrange(256))
            for _ in range(width * height)
        ]
    )
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()


def data_uri(payload: bytes, content_type: str = "image/webp") -> str:
    encoded = base64.b64encode(payload).decode("ascii")
    return f"data:{content_type};base64,{encoded}"


@pytest.fixture(autouse=True)
def isolated_media_root(settings, tmp_path):
    settings.MEDIA_ROOT = str(tmp_path / "media")
    return tmp_path / "media"


def run(**kwargs) -> str:
    out = StringIO()
    call_command("migrate_inline_images", stdout=out, **kwargs)
    return out.getvalue()


@pytest.mark.django_db
class TestBackfill:
    def test_a_data_uri_becomes_a_hash_reference(self, rss_feed):
        payload = noisy_png()
        article = Article.objects.create(
            name="Inlined",
            identifier="https://example.com/1",
            raw_content="<html></html>",
            content=f'<p><img src="{data_uri(payload)}"></p>',
            feed=rss_feed,
        )

        run()

        article.refresh_from_db()
        expected_hash = hashlib.sha256(payload).hexdigest()
        assert f"yana-img://{expected_hash}" in article.content
        assert "data:image" not in article.content
        assert ArticleImage.objects.get().content_hash == expected_hash

    def test_a_backfilled_image_matches_a_freshly_stored_one(self, rss_feed):
        """The bytes in a data URI are already compression output, so the
        backfill must not re-compress: a later aggregation of the same source
        image has to land on the same row."""
        source = noisy_png(seed=3)
        compressed = compress_image(source, "image/png")
        Article.objects.create(
            name="Inlined",
            identifier="https://example.com/2",
            raw_content="",
            content=f'<p><img src="{data_uri(compressed["data"], compressed["contentType"])}"></p>',
            feed=rss_feed,
        )

        run()

        fresh_hash = store_image_bytes(source, "image/png")
        assert ArticleImage.objects.count() == 1
        assert ArticleImage.objects.get().content_hash == fresh_hash

    def test_the_same_image_in_two_articles_is_stored_once(self, rss_feed):
        payload = noisy_png(seed=5)
        for index in range(2):
            Article.objects.create(
                name=f"Inlined {index}",
                identifier=f"https://example.com/dup/{index}",
                raw_content="",
                content=f'<p><img src="{data_uri(payload)}"></p>',
                feed=rss_feed,
            )

        output = run()

        assert ArticleImage.objects.count() == 1
        # The report counts distinct content hashes, not data-URI references --
        # one row stored across two articles must say "(1 images)", not "(2 images)".
        assert "(1 images)" in output

    def test_running_twice_converts_nothing_the_second_time(self, rss_feed):
        Article.objects.create(
            name="Inlined",
            identifier="https://example.com/3",
            raw_content="",
            content=f'<p><img src="{data_uri(noisy_png(seed=7))}"></p>',
            feed=rss_feed,
        )

        run()
        output = run()

        assert "0 articles" in output
        assert ArticleImage.objects.count() == 1

    def test_a_malformed_payload_leaves_the_article_untouched(self, rss_feed, caplog):
        content = '<p><img src="data:image/png;base64,AAAA=A"></p>'
        article = Article.objects.create(
            name="Broken",
            identifier="https://example.com/4",
            raw_content="",
            content=content,
            feed=rss_feed,
        )

        # The "core" logger is configured with propagate=False (see
        # yana/settings.py LOGGING), so records never reach caplog's root
        # handler -- attach it directly to the command's logger instead.
        command_logger = logging.getLogger("core.management.commands.migrate_inline_images")
        command_logger.addHandler(caplog.handler)
        caplog.set_level(logging.WARNING, logger="core.management.commands.migrate_inline_images")
        try:
            run()
        finally:
            command_logger.removeHandler(caplog.handler)

        article.refresh_from_db()
        assert article.content == content
        assert ArticleImage.objects.count() == 0
        assert str(article.id) in caplog.text

    def test_dry_run_writes_nothing_but_reports_the_savings(self, rss_feed):
        payload = noisy_png(seed=11)
        content = f'<p><img src="{data_uri(payload)}"></p>'
        article = Article.objects.create(
            name="Inlined",
            identifier="https://example.com/5",
            raw_content="",
            content=content,
            feed=rss_feed,
        )

        output = run(dry_run=True)

        article.refresh_from_db()
        assert article.content == content
        assert ArticleImage.objects.count() == 0
        assert "1 articles" in output
        assert "would save" in output

    def test_limit_is_honored(self, rss_feed):
        for index in range(2):
            Article.objects.create(
                name=f"Inlined {index}",
                identifier=f"https://example.com/limit/{index}",
                raw_content="",
                content=f'<p><img src="{data_uri(noisy_png(seed=index + 20))}"></p>',
                feed=rss_feed,
            )

        run(limit=1)

        converted = [
            article for article in Article.objects.all() if "data:image" not in article.content
        ]
        assert len(converted) == 1

    def test_raw_content_is_left_alone(self, rss_feed):
        raw = f'<p><img src="{data_uri(noisy_png(seed=23))}"></p>'
        article = Article.objects.create(
            name="Inlined",
            identifier="https://example.com/6",
            raw_content=raw,
            content=raw,
            feed=rss_feed,
        )

        run()

        article.refresh_from_db()
        assert article.raw_content == raw
        assert "data:image" not in article.content
