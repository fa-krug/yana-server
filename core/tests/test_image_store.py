"""Tests for the content-addressed image store."""

import hashlib
import io
import logging
import random
from unittest.mock import patch

import pytest
from PIL import Image

from core.aggregators.services import image_store
from core.aggregators.services.image_store import (
    ImageHashCollisionError,
    build_image_ref,
    find_image_refs,
    store_image_bytes,
    store_image_from_url,
    store_image_ref_from_url,
)
from core.models import ArticleImage


def noisy_png(seed: int = 0, size: tuple[int, int] = (300, 300)) -> bytes:
    """A deterministic PNG big enough to clear compression's 5KB floor.

    A linear formula over the pixel index (the originally-drafted version of
    this helper) is exactly the kind of pattern PNG's row filters compress
    away -- every seed/size combination used below landed under 5000 bytes,
    the floor below which compress_image() skips compression entirely. True
    pseudo-random pixels (still seeded, so still deterministic per call) defeat
    that filtering and land comfortably over the floor.
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


@pytest.fixture(autouse=True)
def isolated_media_root(settings, tmp_path):
    """Never write test images into the repository's media/ directory."""
    settings.MEDIA_ROOT = str(tmp_path / "media")
    return tmp_path / "media"


class TestReferenceFormat:
    def test_build_image_ref_uses_the_ios_scheme(self):
        assert build_image_ref("a" * 64) == f"yana-img://{'a' * 64}"

    def test_find_image_refs_extracts_every_hash(self):
        html = f'<img src="yana-img://{"a" * 64}"><img src="yana-img://{"b" * 64}">'

        assert find_image_refs(html) == {"a" * 64, "b" * 64}

    def test_find_image_refs_ignores_malformed_references(self):
        assert find_image_refs('<img src="yana-img://short">') == set()

    def test_find_image_refs_tolerates_empty_content(self):
        assert find_image_refs("") == set()


@pytest.mark.django_db
class TestStoreImageBytes:
    def test_the_same_bytes_stored_twice_yield_one_row(self):
        data = noisy_png()

        first = store_image_bytes(data, "image/png")
        second = store_image_bytes(data, "image/png")

        assert first == second
        assert ArticleImage.objects.count() == 1

    def test_different_bytes_yield_two_rows(self):
        first = store_image_bytes(noisy_png(seed=1), "image/png")
        second = store_image_bytes(noisy_png(seed=200), "image/png")

        assert first != second
        assert ArticleImage.objects.count() == 2

    def test_the_hash_is_over_the_stored_bytes(self):
        """Content addressing is a lie unless the hash matches the file on disk."""
        content_hash = store_image_bytes(noisy_png(), "image/png")

        image = ArticleImage.objects.get(content_hash=content_hash)
        with image.file.open("rb") as handle:
            stored = handle.read()

        assert hashlib.sha256(stored).hexdigest() == content_hash
        assert image.byte_size == len(stored)

    def test_compression_is_deterministic_so_dedup_works(self):
        """Same source, two independent calls, one row -- the property the
        whole scheme rests on. Hashing the original instead would re-compress
        on every encounter."""
        source = noisy_png(seed=5)

        first = store_image_bytes(source, "image/png")
        ArticleImage.objects.all().delete()
        second = store_image_bytes(source, "image/png")

        assert first == second

    def test_metadata_is_populated(self):
        content_hash = store_image_bytes(noisy_png(size=(300, 200)), "image/png")

        image = ArticleImage.objects.get(content_hash=content_hash)
        assert image.content_type == "image/webp"
        assert image.width == 300
        assert image.height == 200
        assert image.byte_size > 0

    def test_a_racing_writer_does_not_create_a_second_row(self, isolated_media_root):
        """Two runs hashing the same image collide on the unique constraint
        rather than writing two rows -- and the loser leaves no stray file.

        Patching _existing_row simulates the pre-check missing a row another
        writer inserted a moment later.
        """
        data = noisy_png(seed=9)
        first = store_image_bytes(data, "image/png")

        with patch.object(image_store, "_existing_row", return_value=None):
            second = store_image_bytes(data, "image/png")

        assert second == first
        assert ArticleImage.objects.count() == 1
        assert len(list(isolated_media_root.rglob("*.webp"))) == 1

    def test_compression_failure_stores_the_original_bytes(self, caplog):
        """A stored-but-large image beats a missing one."""
        data = noisy_png(seed=11)

        # The "core" logger is configured with propagate=False (see
        # yana/settings.py LOGGING), so records never reach caplog's root
        # handler -- attach it directly to image_store's logger instead.
        store_logger = logging.getLogger("core.aggregators.services.image_store")
        store_logger.addHandler(caplog.handler)
        caplog.set_level(logging.WARNING, logger="core.aggregators.services.image_store")
        try:
            with patch.object(image_store, "compress_image", return_value=None):
                content_hash = store_image_bytes(data, "image/png")
        finally:
            store_logger.removeHandler(caplog.handler)

        assert content_hash == hashlib.sha256(data).hexdigest()
        image = ArticleImage.objects.get(content_hash=content_hash)
        assert image.content_type == "image/png"
        assert image.width is None
        assert "storing the original bytes" in caplog.text

    def test_compress_false_skips_compression_entirely(self):
        """The backfill stores already-compressed payloads verbatim."""
        data = noisy_png(seed=13)

        with patch.object(image_store, "compress_image") as mock_compress:
            content_hash = store_image_bytes(data, "image/webp", compress=False)

        mock_compress.assert_not_called()
        assert content_hash == hashlib.sha256(data).hexdigest()

    def test_empty_bytes_store_nothing(self):
        assert store_image_bytes(b"", "image/png") is None
        assert ArticleImage.objects.count() == 0

    def test_a_hash_collision_on_different_content_is_a_hard_error(self):
        """Cryptographically implausible for SHA-256 -- but never silently
        overwrite one image with another."""
        data = noisy_png(seed=17)
        content_hash = store_image_bytes(data, "image/png")
        ArticleImage.objects.filter(content_hash=content_hash).update(byte_size=999_999)

        with pytest.raises(ImageHashCollisionError):
            store_image_bytes(data, "image/png")


@pytest.mark.django_db
class TestStoreFromUrl:
    def test_a_fetched_image_is_stored_and_referenced(self):
        data = noisy_png(seed=21)

        with patch.object(
            image_store,
            "fetch_single_image",
            return_value={"imageData": data, "contentType": "image/png"},
        ):
            ref = store_image_ref_from_url("https://example.com/a.png", is_header=True)

        content_hash = ArticleImage.objects.get().content_hash
        assert ref == f"yana-img://{content_hash}"

    def test_a_fetch_failure_stores_nothing_and_returns_none(self):
        with patch.object(image_store, "fetch_single_image", return_value=None):
            assert store_image_from_url("https://example.com/gone.png") is None
            assert store_image_ref_from_url("https://example.com/gone.png") is None

        assert ArticleImage.objects.count() == 0
