"""Tests for the content-addressed image store."""

import hashlib
import io
import logging
import os
import random
from unittest.mock import patch

from django.core.files.storage import default_storage

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


def tiny_png(size: tuple[int, int], color: tuple[int, int, int] = (255, 0, 0)) -> bytes:
    """A real, tiny PNG at exactly ``size`` pixels.

    Real tracking pixels (VG Wort's included) are this small -- well under
    compress_image's 5KB compression floor, so this exercises the same
    "compression skipped" path a live tracker hits, not a synthetic shortcut.
    """
    img = Image.new("RGB", size, color)
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    data = buffer.getvalue()
    assert len(data) < 5000, "tiny_png must stay under the compression floor to be a useful fixture"
    return data


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

    def test_a_missing_file_is_rewritten_when_the_bytes_are_stored_again(self):
        """A restored DB backup without media/ (or a cleared directory) leaves
        rows whose file is gone. Re-encountering the same source image must
        repair the file in place rather than silently doing nothing forever."""
        data = noisy_png(seed=29)
        content_hash = store_image_bytes(data, "image/png")
        image = ArticleImage.objects.get(content_hash=content_hash)
        file_path = image.file.path
        os.remove(file_path)
        assert not os.path.exists(file_path)

        second_hash = store_image_bytes(data, "image/png")

        assert second_hash == content_hash
        assert ArticleImage.objects.count() == 1
        assert os.path.exists(file_path)
        with open(file_path, "rb") as handle:
            assert hashlib.sha256(handle.read()).hexdigest() == content_hash

    def test_a_racing_file_repair_does_not_leave_a_stray_file(self, isolated_media_root):
        """If another writer recreates the missing file between our exists()
        check and the repair save, storage disambiguates with a suffixed name
        instead of overwriting -- the repair must not silently discard that
        outcome and leave the stray, unreferenced file behind."""
        data = noisy_png(seed=33)
        content_hash = store_image_bytes(data, "image/png")
        image = ArticleImage.objects.get(content_hash=content_hash)
        os.remove(image.file.path)

        real_save = default_storage.save

        def racing_save(name, content, max_length=None):
            # Simulate a concurrent writer already having recreated the file
            # at this exact name -- the storage backend disambiguates rather
            # than overwriting it.
            return real_save(f"{name}.racing", content, max_length=max_length)

        with patch.object(default_storage, "save", side_effect=racing_save):
            second_hash = store_image_bytes(data, "image/png")

        assert second_hash == content_hash
        assert not list(isolated_media_root.rglob("*.racing"))

    def test_a_blank_file_name_skips_the_repair_check(self):
        """A row with a blank file name (however it got that way) must still
        return its hash, exactly like the pre-repair code did -- attempting
        storage.save("") raises SuspiciousFileOperation, so the repair path
        must never be reached for one."""
        data = noisy_png(seed=37)
        content_hash = store_image_bytes(data, "image/png")
        ArticleImage.objects.filter(content_hash=content_hash).update(file="")

        second_hash = store_image_bytes(data, "image/png")

        assert second_hash == content_hash
        assert ArticleImage.objects.count() == 1

    def test_a_hash_collision_on_different_content_is_a_hard_error(self):
        """Cryptographically implausible for SHA-256 -- but never silently
        overwrite one image with another."""
        data = noisy_png(seed=17)
        content_hash = store_image_bytes(data, "image/png")
        ArticleImage.objects.filter(content_hash=content_hash).update(byte_size=999_999)

        with pytest.raises(ImageHashCollisionError):
            store_image_bytes(data, "image/png")


@pytest.mark.django_db
class TestTrackingPixelRejection:
    """VG Wort-style counting pixels (and any other 1x1 beacon) are not
    content -- they must not be stored and must not produce a usable ref,
    without raising, so the rest of an article is unaffected."""

    def test_a_1x1_image_is_not_stored(self):
        assert store_image_bytes(tiny_png((1, 1)), "image/png") is None
        assert ArticleImage.objects.count() == 0

    def test_the_threshold_boundary_is_pinned_by_the_constant(self):
        """Both sides of TRACKING_PIXEL_MAX_DIMENSION, derived from the
        constant itself so a future change to its value cannot silently
        desync from what this test actually checks."""
        limit = image_store.TRACKING_PIXEL_MAX_DIMENSION

        just_rejected = tiny_png((limit, limit))
        assert store_image_bytes(just_rejected, "image/png") is None
        assert ArticleImage.objects.count() == 0

        just_accepted = tiny_png((limit + 1, limit + 1))
        accepted_hash = store_image_bytes(just_accepted, "image/png")
        assert accepted_hash is not None
        assert ArticleImage.objects.count() == 1

    def test_a_normal_sized_image_is_stored_exactly_as_before(self):
        """Regression guard: the tracking-pixel check must not touch the
        path for ordinary content images."""
        data = noisy_png(seed=43)

        content_hash = store_image_bytes(data, "image/png")

        image = ArticleImage.objects.get(content_hash=content_hash)
        assert image.width == 300
        assert image.height == 300
        assert image.content_type == "image/webp"

    def test_rejection_does_not_raise(self):
        """Skipping a tracking pixel is normal control flow, not an error."""
        try:
            result = store_image_bytes(tiny_png((1, 1)), "image/png")
        except Exception as exc:  # pragma: no cover - the assertion below fails first
            pytest.fail(f"store_image_bytes raised for a tracking pixel: {exc}")
        assert result is None


@pytest.mark.django_db
class TestArticleBodyMixedContent:
    def test_a_tracking_pixel_alongside_real_content_only_the_pixel_is_skipped(self):
        """The scenario that motivated this fix: a caschys_blog article body
        carrying a VG Wort tracking pixel next to a real content image.
        Storing must not blow up on the pixel, and the real image must be
        entirely unaffected by its presence."""
        pixel_bytes = tiny_png((1, 1))
        real_bytes = noisy_png(seed=47)
        fetched = {
            "https://vgwort.example/beacon": {"imageData": pixel_bytes, "contentType": "image/png"},
            "https://example.com/real.png": {"imageData": real_bytes, "contentType": "image/png"},
        }

        with patch.object(
            image_store, "fetch_single_image", side_effect=lambda url, **_: fetched[url]
        ):
            pixel_ref = store_image_ref_from_url("https://vgwort.example/beacon")
            real_ref = store_image_ref_from_url("https://example.com/real.png")

        assert pixel_ref is None
        assert real_ref is not None
        assert ArticleImage.objects.count() == 1
        assert ArticleImage.objects.get().content_hash in real_ref


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
