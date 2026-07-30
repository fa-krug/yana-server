# Image Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop inlining base64 data URIs into `Article.content`; store every image once as a
content-addressed `ArticleImage` file and reference it from article content as
`yana-img://<sha256-hex>`.

**Architecture:** A new service, `core/aggregators/services/image_store.py`, is the single place
that turns image bytes into a stored row: compress (existing `compress_image`) → `sha256` of the
**compressed** bytes → `ArticleImage` row keyed on that hash → return the hash. Everything that used
to produce a data URI (the four header-element strategies, the domain-override path, Reddit's
header inliner, Oglaf's comic encoder) now calls that service and renders
`yana-img://<hash>` as the image `src`. Two management commands close the loop: a backfill that
rewrites existing inline data URIs, and a reaper that deletes unreferenced images. Admin registers
`ArticleImage` so the data is verifiable by eye, which is the only verification surface this phase
has.

**Tech Stack:** Python 3.13, Django 6.0, SQLite (custom tuned backend), Pillow 11, `FileField` on
local disk under `MEDIA_ROOT`, pytest + pytest-django.

**Spec:** `docs/superpowers/specs/2026-07-29-image-hosting-design.md` (Spec 4)
**Direction:** `docs/superpowers/specs/2026-07-29-client-server-remigration-direction.md`
**Depends on:** Spec 2 (landed on this branch — the five former base64 call sites are the same ones
the scraper fixes touched)

## Global Constraints

- Python 3.13+, Django 6.0. SQLite only, via the custom backend — no other engine.
- Line length 100. Double quotes. `ruff check core/ --fix`, `ruff format core/`, `mypy core/`,
  `uv run pytest` must all pass before a task is done.
- Every command runs through `uv run` — no venv activation, no bare `python`.
- Reference format is exactly `yana-img://<sha256-hex>` — lowercase hex, 64 chars, no port, no host,
  no scheme variants. It is iOS's existing scheme; the client's resolution path already works.
- The hash is SHA-256 over the **stored (compressed)** bytes, never over the original download.
- Compression behavior is unchanged: `compress_image()` keeps its current settings. Only the
  destination changes.
- `Article.date` semantics are untouched (feed publish time; never rewritten). `created_at` remains
  the ordering/retention key.
- Test coverage target >80%; tests live in `core/tests/test_*.py` and use `core/tests/conftest.py`
  fixtures (`user`, `user_with_settings`, `rss_feed`, `reddit_feed`, `article`, …).
- Commit messages: `<type>(<scope>): <Description>` — e.g. `feat(images): Add the ArticleImage model`.
- Tests that write image files must isolate `MEDIA_ROOT` (a `settings`/`tmp_path` fixture). Never
  let a test write into the repo's `media/` directory.

---

## Deviations from the spec (deliberate, reviewed)

1. **The spec's compression numbers describe dead configuration.** Spec 4 says "reuse the existing
   compression … 600×600 standard, 1200×1200 header, quality 65". Those values live in
   `core/aggregators/services/config.py`, which **nothing imports**; the values that actually run
   are `compression.py`'s own module constants (quality 95, and non-header images are re-encoded but
   never downscaled). This plan changes no compression behavior and does not rewire `config.py`.
   The only `config.py` edit is deleting `ENABLE_BASE64_ENCODING`, which the spec requires.
2. **`HeaderElementData` gains an `image_ref` property** alongside the `content_hash` field the spec
   names. All five former call sites need the reference string, not the bare hash; a property keeps
   them one-liners instead of repeating `f"yana-img://{...}"` five times.
3. **Reddit's failed header download still degrades to the remote URL.** Spec 4's error handling says
   a `None` hash means "omit the image", and that is what the header-element path now does (a
   strategy that cannot store returns `None`, so no header renders). Reddit's separate inliner is the
   exception: `core/tests/test_reddit_aggregator.py::test_failed_download_still_renders_the_header_from_the_original_url`
   asserts the remote-URL fallback as *deliberately kept* server behavior from Spec 2's A5 fix.
   Silently deleting that guarantee here would undo a reviewed decision, so the fallback stays.
4. **`compress_and_encode_image()` and `create_image_element()` are deleted**, not merely left
   unused. The spec's removal list names only `ENABLE_BASE64_ENCODING` and Oglaf's inline encoding,
   but those two helpers exist solely to emit `data:…;base64,…`, and leaving them is a regression
   landmine. A guard test replaces them (Task 6).
5. **`store_image_bytes(..., compress=False)` exists for the backfill.** Existing inline data URIs
   already hold compression *output*; re-compressing them would produce a different hash than a
   future aggregation of the same source image, defeating deduplication. The backfill stores the
   decoded bytes verbatim.
6. **The backfill rewrites `content` only, not `raw_content`.** `raw_content` is the untouched source
   HTML; any `data:` URI in it came from the publisher, not from us.
7. **`Article.icon` (`ImageField`) is left alone.** It is written by `HeaderElementFileHandler` and is
   not part of article *content*. Migrating icons/logos into `ArticleImage` is named as a follow-up in
   the direction doc, not a dependency.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `core/aggregators/services/image_store.py` | The whole storage contract: compress → hash → `ArticleImage`, plus `yana-img://` build/parse/scan helpers |
| `core/migrations/0032_articleimage.py` | The `ArticleImage` table |
| `core/migrations/0033_drop_oglaf_convert_to_base64.py` | Data migration dropping the retired option key from `Feed.options` |
| `core/management/commands/migrate_inline_images.py` | Backfill: inline data URIs → stored images + refs |
| `core/management/commands/prune_orphaned_images.py` | Reaper: unreferenced images, plus the missing-file report |
| `core/templates/admin/core/articleimage/change_list.html` | Byte-size total above the changelist |
| `core/tests/image_refs.py` | Shared assertion helper used by all five aggregator tests |
| `core/tests/test_article_image_model.py` | Model-level tests |
| `core/tests/test_image_store.py` | Storage/dedup/determinism/failure tests |
| `core/tests/test_hosted_header_images.py` | The five former base64 call sites, uniformly |
| `core/tests/test_oglaf_aggregator.py` | Oglaf's comic image + the retired option |
| `core/tests/test_no_inline_base64.py` | Guard: nothing in production encodes images as base64 |
| `core/tests/test_migrate_inline_images.py` | Backfill command tests |
| `core/tests/test_prune_orphaned_images.py` | Pruning command tests |
| `core/tests/test_article_image_admin.py` | Admin verification surface tests |

**Modified**

| File | Change |
|---|---|
| `core/models.py` | Add `ArticleImage` |
| `core/aggregators/services/header_element/context.py` | `base64_data_uri` → `content_hash`, add `image_ref` |
| `core/aggregators/services/header_element/strategies.py` | Three strategies store instead of encoding |
| `core/aggregators/services/header_element/extractor.py` | Domain-override path stores instead of encoding |
| `core/aggregators/website.py:202` | `header_data.image_ref` |
| `core/aggregators/heise/aggregator.py:227` | `header_data.image_ref` |
| `core/aggregators/mein_mmo/aggregator.py:187` | `header_data.image_ref` |
| `core/aggregators/mactechnews/aggregator.py:211` | `header_data.image_ref` |
| `core/aggregators/reddit/aggregator.py:544,641-659` | `header_data.image_ref`; `_inline_header_image` → `_store_header_image` |
| `core/aggregators/oglaf/aggregator.py` | Drop `convert_to_base64` + `import base64`; store via the shared path |
| `core/aggregators/services/image_extraction/compression.py` | Delete `compress_and_encode_image`, `create_image_element`, `import base64` |
| `core/aggregators/services/image_extraction/__init__.py` | Drop the deleted exports |
| `core/aggregators/services/config.py` | Delete `ENABLE_BASE64_ENCODING` |
| `core/admin.py` | Register `ArticleImage`; add `referenced_images` to `ArticleAdmin` |
| `core/tests/test_domain_image_overrides.py` | Patch the store, assert the hash |
| `core/tests/test_caschys_blog_aggregator.py` | `HeaderElementData(content_hash=…)` |
| `core/tests/test_reddit_aggregator.py` | Patch the store, assert the ref |
| `README.md`, `CLAUDE.md`, `core/aggregators/README.md` | Document the store, the refs, the commands |

---

## Task 1: The `ArticleImage` model

**Files:**
- Modify: `core/models.py` (append after `Article`, before `UserSettings`)
- Create: `core/migrations/0032_articleimage.py` (generated)
- Test: `core/tests/test_article_image_model.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `core.models.ArticleImage` with fields `content_hash: str` (64-char SHA-256 hex, unique,
  indexed), `file: FileField` (`upload_to="article_images/%Y/%m/"`), `content_type: str`,
  `width: int | None`, `height: int | None`, `byte_size: int`, `created_at: datetime`. Every later
  task uses these exact names.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_article_image_model.py`:

```python
"""Tests for the content-addressed ArticleImage model."""

from django.db.utils import IntegrityError

import pytest

from core.models import ArticleImage


@pytest.mark.django_db
class TestArticleImage:
    def test_content_hash_is_unique(self):
        """The unique constraint is what makes concurrent stores safe."""
        ArticleImage.objects.create(
            content_hash="a" * 64,
            file="article_images/2026/07/a.webp",
            content_type="image/webp",
            byte_size=10,
        )

        with pytest.raises(IntegrityError):
            ArticleImage.objects.create(
                content_hash="a" * 64,
                file="article_images/2026/07/b.webp",
                content_type="image/webp",
                byte_size=20,
            )

    def test_dimensions_are_optional(self):
        """Compression is skipped for small files, which yields no dimensions."""
        image = ArticleImage.objects.create(
            content_hash="b" * 64,
            file="article_images/2026/07/b.webp",
            content_type="image/gif",
            byte_size=42,
        )

        assert image.width is None
        assert image.height is None

    def test_newest_first_ordering(self):
        older = ArticleImage.objects.create(
            content_hash="c" * 64,
            file="article_images/2026/07/c.webp",
            content_type="image/webp",
            byte_size=1,
        )
        newer = ArticleImage.objects.create(
            content_hash="d" * 64,
            file="article_images/2026/07/d.webp",
            content_type="image/webp",
            byte_size=1,
        )

        assert list(ArticleImage.objects.all()) == [newer, older]

    def test_str_shows_the_short_hash_type_and_size(self):
        image = ArticleImage(content_hash="e" * 64, content_type="image/webp", byte_size=1234)

        assert str(image) == f"{'e' * 12} (image/webp, 1234 B)"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_article_image_model.py -v
```

Expected: collection error — `ImportError: cannot import name 'ArticleImage' from 'core.models'`.

- [ ] **Step 3: Add the model**

In `core/models.py`, after the `Article` class:

```python
class ArticleImage(models.Model):
    """
    A content-addressed image referenced from article content.

    Article bodies reference images as ``yana-img://<content_hash>`` instead of
    inlining a base64 data URI: one row per distinct byte sequence, so the same
    image across ten articles is stored once. The hash is SHA-256 over the
    *stored* (compressed) bytes -- see
    ``core/aggregators/services/image_store.py``.
    """

    content_hash = models.CharField(
        max_length=64,
        unique=True,
        db_index=True,
        help_text="SHA-256 hex digest of the stored bytes",
    )
    file = models.FileField(upload_to="article_images/%Y/%m/")
    content_type = models.CharField(max_length=100)
    width = models.PositiveIntegerField(null=True, blank=True)
    height = models.PositiveIntegerField(null=True, blank=True)
    byte_size = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "Article Image"
        verbose_name_plural = "Article Images"
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["-created_at"])]

    def __str__(self):
        return f"{self.content_hash[:12]} ({self.content_type}, {self.byte_size} B)"
```

- [ ] **Step 4: Generate the migration**

```bash
uv run python manage.py makemigrations core
```

Expected: `core/migrations/0032_articleimage.py` creating the model. Read the generated file and
confirm it depends on `0031_alter_feed_aggregator` and adds no unrelated operations.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_article_image_model.py -v
```

Expected: 4 passed.

- [ ] **Step 6: Apply the migration and check the suite**

```bash
uv run python manage.py migrate && uv run pytest core/tests/test_models.py core/tests/test_performance_indexes.py -q
```

Expected: migration applies; both modules pass.

- [ ] **Step 7: Lint, type-check, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
```

```bash
git add core/models.py core/migrations/0032_articleimage.py core/tests/test_article_image_model.py
git commit -m "feat(images): Add the content-addressed ArticleImage model"
```

---

## Task 2: The image store service

**Files:**
- Create: `core/aggregators/services/image_store.py`
- Test: `core/tests/test_image_store.py`

**Interfaces:**
- Consumes: `core.models.ArticleImage` (Task 1);
  `core.aggregators.services.image_extraction.compression.compress_image(image_data, content_type, is_header=False) -> dict | None`
  with keys `data`, `contentType`, `size`, `width`, `height`;
  `core.aggregators.services.image_extraction.fetcher.fetch_single_image(url) -> dict | None`
  with keys `imageData`, `contentType`.
- Produces (every later task imports from here):
  - `IMAGE_REF_SCHEME: str` — `"yana-img://"`
  - `build_image_ref(content_hash: str) -> str`
  - `find_image_refs(text: str) -> set[str]` — the hashes referenced by a blob of HTML
  - `store_image_bytes(image_bytes: bytes, content_type: str, *, is_header: bool = False, compress: bool = True) -> str | None`
    — returns the content hash, or `None` when nothing could be stored
  - `store_image_from_url(url: str, *, is_header: bool = False) -> str | None` — hash
  - `store_image_ref_from_url(url: str, *, is_header: bool = False) -> str | None` — `yana-img://…`
  - `ImageHashCollisionError(RuntimeError)`

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_image_store.py`:

```python
"""Tests for the content-addressed image store."""

import hashlib
import io
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
    """A deterministic PNG big enough to clear compression's 5KB floor."""
    width, height = size
    img = Image.new("RGB", size)
    img.putdata(
        [((i * 7 + seed) % 256, (i * 13 + seed) % 256, (i * 29 + seed) % 256)
         for i in range(width * height)]
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

        with patch.object(image_store, "compress_image", return_value=None):
            content_hash = store_image_bytes(data, "image/png")

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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_image_store.py -v
```

Expected: collection error — `ModuleNotFoundError: No module named 'core.aggregators.services.image_store'`.

- [ ] **Step 3: Write the implementation**

Create `core/aggregators/services/image_store.py`:

```python
"""
Content-addressed image storage.

Aggregators hand raw image bytes here; this module compresses them with the
existing pipeline, hashes the *compressed* output, and keeps exactly one
``ArticleImage`` row per distinct byte sequence. Article content then carries
``yana-img://<sha256>`` instead of an inlined base64 data URI.

Hashing the compressed output rather than the original is what makes
deduplication work: the same source image encountered twice compresses to the
same bytes (Pillow is deterministic for fixed settings), finds the existing row,
and stores nothing new.
"""

import hashlib
import logging
import re

from django.core.files.base import ContentFile
from django.db import IntegrityError, transaction

from core.models import ArticleImage

from .image_extraction.compression import compress_image
from .image_extraction.fetcher import fetch_single_image

logger = logging.getLogger(__name__)

# iOS's existing scheme -- the client's resolution path already understands it.
IMAGE_REF_SCHEME = "yana-img://"

_IMAGE_REF_PATTERN = re.compile(rf"{IMAGE_REF_SCHEME}([0-9a-f]{{64}})")

_EXTENSIONS = {
    "image/webp": "webp",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/avif": "avif",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
}


class ImageHashCollisionError(RuntimeError):
    """Two different byte sequences hashed to the same SHA-256 digest."""


def build_image_ref(content_hash: str) -> str:
    """Return the ``yana-img://`` reference for a stored image."""
    return f"{IMAGE_REF_SCHEME}{content_hash}"


def find_image_refs(text: str) -> set[str]:
    """Return every content hash referenced by a blob of HTML."""
    if not text:
        return set()
    return set(_IMAGE_REF_PATTERN.findall(text))


def store_image_bytes(
    image_bytes: bytes,
    content_type: str,
    *,
    is_header: bool = False,
    compress: bool = True,
) -> str | None:
    """
    Store image bytes and return their content hash.

    Args:
        image_bytes: Raw image data
        content_type: MIME type of ``image_bytes``
        is_header: Use the larger header dimensions during compression
        compress: Set False for payloads that are already compression output
            (the ``migrate_inline_images`` backfill). Re-compressing those would
            yield a different hash than a fresh aggregation of the same source
            image, which would defeat deduplication.

    Returns:
        The SHA-256 hex digest of the stored bytes, or None when there was
        nothing to store. Callers must treat None as "no image" and publish the
        article without it.

    Raises:
        ImageHashCollisionError: A row exists for this hash with a different
            byte size.
    """
    if not image_bytes:
        return None

    if compress:
        data, output_type, width, height = _compress_or_passthrough(
            image_bytes, content_type, is_header
        )
    else:
        data, output_type, width, height = image_bytes, content_type, None, None

    content_hash = hashlib.sha256(data).hexdigest()

    existing = _existing_row(content_hash)
    if existing is not None:
        if existing.byte_size != len(data):
            raise ImageHashCollisionError(
                f"{content_hash} already stores {existing.byte_size} B, refusing to "
                f"overwrite it with {len(data)} B"
            )
        logger.debug("[image_store] %s already stored -- reusing it", content_hash[:12])
        return content_hash

    image = ArticleImage(
        content_hash=content_hash,
        content_type=output_type,
        width=width,
        height=height,
        byte_size=len(data),
    )
    filename = f"{content_hash}.{_EXTENSIONS.get(output_type, 'bin')}"
    image.file.save(filename, ContentFile(data), save=False)

    try:
        with transaction.atomic():
            image.save()
    except IntegrityError:
        # A concurrent run stored the same bytes first. Its row is just as good;
        # drop the duplicate file so it does not become an orphan on disk.
        logger.debug(
            "[image_store] %s was stored concurrently -- keeping the existing row",
            content_hash[:12],
        )
        image.file.delete(save=False)

    return content_hash


def store_image_from_url(url: str, *, is_header: bool = False) -> str | None:
    """Fetch an image and store it. Returns its content hash, or None."""
    fetched = fetch_single_image(url)
    if not fetched:
        logger.info("[image_store] Could not fetch %s -- no image stored", url)
        return None

    return store_image_bytes(
        fetched["imageData"], fetched["contentType"], is_header=is_header
    )


def store_image_ref_from_url(url: str, *, is_header: bool = False) -> str | None:
    """Fetch and store an image, returning its ``yana-img://`` reference."""
    content_hash = store_image_from_url(url, is_header=is_header)
    return build_image_ref(content_hash) if content_hash else None


def _existing_row(content_hash: str) -> ArticleImage | None:
    """Return the stored row for a hash, if any (patched in tests)."""
    return ArticleImage.objects.filter(content_hash=content_hash).first()


def _compress_or_passthrough(
    image_bytes: bytes, content_type: str, is_header: bool
) -> tuple[bytes, str, int | None, int | None]:
    """Compress, or fall back to the original bytes when compression fails."""
    result = compress_image(image_bytes, content_type, is_header=is_header)
    if not result:
        logger.warning(
            "[image_store] Compression failed for a %s image (%d B) -- storing the "
            "original bytes",
            content_type,
            len(image_bytes),
        )
        return image_bytes, content_type, None, None

    return result["data"], result["contentType"], result["width"], result["height"]
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_image_store.py -v
```

Expected: all pass. If `test_metadata_is_populated` reports `image/png` instead of `image/webp`, the
generated PNG came in under `compression.MIN_IMAGE_SIZE` (5000 B) — increase the noise size rather
than changing compression.

- [ ] **Step 5: Lint, type-check, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
```

```bash
git add core/aggregators/services/image_store.py core/tests/test_image_store.py
git commit -m "feat(images): Add the content-addressed image store"
```

---

## Task 3: The header path stores images and references them by hash

This is one task because it is one atomic rename: `HeaderElementData.base64_data_uri` disappears, so
every producer (three strategies + the domain-override path) and every consumer (five aggregators)
must change together or the suite is red.

**Files:**
- Modify: `core/aggregators/services/header_element/context.py`
- Modify: `core/aggregators/services/header_element/strategies.py:105-123,160-177,208-227`
- Modify: `core/aggregators/services/header_element/extractor.py:11,68,139-155`
- Modify: `core/aggregators/website.py:199-202`
- Modify: `core/aggregators/heise/aggregator.py:224-227`
- Modify: `core/aggregators/mein_mmo/aggregator.py:183-187`
- Modify: `core/aggregators/mactechnews/aggregator.py:208-211`
- Modify: `core/aggregators/reddit/aggregator.py:537-547` (the article-reload path only)
- Create: `core/tests/image_refs.py`
- Create: `core/tests/test_hosted_header_images.py`
- Modify: `core/tests/test_domain_image_overrides.py:106-133`
- Modify: `core/tests/test_caschys_blog_aggregator.py:99-140`

**Interfaces:**
- Consumes: `image_store.store_image_bytes`, `image_store.build_image_ref` (Task 2).
- Produces:
  - `HeaderElementData(image_bytes: bytes, content_type: str, content_hash: str, image_url: str | None = None)`
    with a property `image_ref -> str` returning `yana-img://<content_hash>`. `content_hash` is
    positional in the slot `base64_data_uri` occupied, so any missed call site fails loudly.
  - `core/tests/image_refs.assert_hosted_image(content: str, content_hash: str | None = None) -> None`
    — the shared regression guard: content references an image by hash and contains no `data:image`.

- [ ] **Step 1: Write the shared test helper**

Create `core/tests/image_refs.py`:

```python
"""Shared assertions for content-addressed image references.

Every former base64 call site uses ``assert_hosted_image``: the ``data:image``
half is the regression guard that keeps inlining from creeping back in.
"""

import re

IMAGE_REF_RE = re.compile(r"yana-img://[0-9a-f]{64}")


def assert_hosted_image(content: str, content_hash: str | None = None) -> None:
    """Assert content references a stored image and inlines no base64 image."""
    refs = IMAGE_REF_RE.findall(content)
    assert refs, f"no yana-img:// reference in content: {content[:300]!r}"
    if content_hash is not None:
        assert f"yana-img://{content_hash}" in content, (
            f"expected yana-img://{content_hash}, found {refs}"
        )
    assert "data:image" not in content, "content still inlines a base64 image"
```

- [ ] **Step 2: Write the failing tests for all five call sites**

Create `core/tests/test_hosted_header_images.py`:

```python
"""Every former base64 call site renders a hosted image reference.

The five aggregators listed here are the ones that used to read
``header_data.base64_data_uri or header_data.image_url``.
"""

import pytest

from core.aggregators.registry import get_aggregator
from core.aggregators.services.header_element.context import HeaderElementData
from core.models import Feed
from core.tests.image_refs import assert_hosted_image

HEADER_HASH = "a1" * 32

# (aggregator key, identifier, extra feed options needed to stay offline)
CASES = [
    ("full_website", "https://example.com/rss", {}),
    ("heise", "https://www.heise.de/rss/heise-atom.xml", {"include_comments": False}),
    ("mein_mmo", "https://mein-mmo.de/feed/", {"include_comments": False}),
    ("mactechnews", "https://www.mactechnews.de/news/rss", {"include_comments": False}),
    ("reddit", "python", {}),
]


def make_article() -> dict:
    return {
        "name": "Hosted image article",
        "identifier": "https://example.com/article",
        "raw_content": "<html><body><p>Body text.</p></body></html>",
        "content": "<p>Body text.</p>",
        "header_data": HeaderElementData(
            image_bytes=b"ignored",
            content_type="image/webp",
            content_hash=HEADER_HASH,
            image_url="https://example.com/header.jpg",
        ),
    }


@pytest.mark.django_db
@pytest.mark.parametrize(("aggregator", "identifier", "options"), CASES)
def test_header_image_is_referenced_by_hash(
    aggregator, identifier, options, user_with_settings
):
    feed = Feed.objects.create(
        name=f"{aggregator} feed",
        aggregator=aggregator,
        identifier=identifier,
        user=user_with_settings,
        options=options,
    )

    processed = get_aggregator(feed).process_content("<p>Body text.</p>", make_article())

    assert_hosted_image(processed, HEADER_HASH)


def test_header_element_data_exposes_the_reference():
    data = HeaderElementData(
        image_bytes=b"x", content_type="image/webp", content_hash=HEADER_HASH
    )

    assert data.image_ref == f"yana-img://{HEADER_HASH}"
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_hosted_header_images.py -v
```

Expected: every case fails — `TypeError: HeaderElementData.__init__() got an unexpected keyword
argument 'content_hash'`.

- [ ] **Step 4: Replace the data URI field with the hash**

In `core/aggregators/services/header_element/context.py`:

```python
"""
Header element extraction context.

Dataclass for passing context to header element extraction strategies.
"""

from dataclasses import dataclass

from ..image_store import build_image_ref


@dataclass
class HeaderElementContext:
    """Context for header element extraction strategies."""

    url: str  # Source URL
    alt: str  # Alt text for image/title for iframe
    user_id: int | None = None  # Optional user ID for authenticated API calls


@dataclass
class HeaderElementData:
    """Data returned from header element extraction strategies."""

    image_bytes: bytes  # Raw image data
    content_type: str  # MIME type (e.g. 'image/jpeg')
    content_hash: str  # SHA-256 of the stored (compressed) bytes
    image_url: str | None = None  # Original image URL for removal from content

    @property
    def image_ref(self) -> str:
        """The ``yana-img://`` reference callers render as the image src."""
        return build_image_ref(self.content_hash)
```

- [ ] **Step 5: Make the three strategies store instead of encode**

In `core/aggregators/services/header_element/strategies.py`, replace the compression import:

```python
from core.aggregators.services.image_store import store_image_bytes
```

(delete the `compress_and_encode_image` import), then update each strategy's tail. `RedditPostStrategy`:

```python
            content_hash = store_image_bytes(
                image_result["imageData"],
                image_result["contentType"],
            )

            if not content_hash:
                logger.debug("RedditPostStrategy: Failed to store image")
                return None

            logger.debug("RedditPostStrategy: Successfully extracted and stored icon")
            return HeaderElementData(
                image_bytes=image_result["imageData"],
                content_type=image_result["contentType"],
                content_hash=content_hash,
            )
```

`YouTubeStrategy` (same shape, its own log prefix):

```python
            content_hash = store_image_bytes(
                image_result["imageData"],
                image_result["contentType"],
            )

            if not content_hash:
                logger.debug("YouTubeStrategy: Failed to store image")
                return None

            logger.debug("YouTubeStrategy: Successfully fetched and stored thumbnail")
            return HeaderElementData(
                image_bytes=image_result["imageData"],
                content_type=image_result["contentType"],
                content_hash=content_hash,
            )
```

`GenericImageStrategy` (header dimensions, and it keeps `image_url`):

```python
            content_hash = store_image_bytes(
                image_result["imageData"],
                image_result["contentType"],
                is_header=True,
            )

            if not content_hash:
                logger.debug("GenericImageStrategy: Failed to store image")
                return None

            logger.debug("GenericImageStrategy: Successfully extracted and stored image")
            return HeaderElementData(
                image_bytes=image_result["imageData"],
                content_type=image_result["contentType"],
                content_hash=content_hash,
                image_url=image_result.get("imageUrl"),
            )
```

Also update the module docstring line 6 — the Reddit strategy "compresses to base64" is now
"stores the icon in the image store".

- [ ] **Step 6: Make the domain-override path store**

In `core/aggregators/services/header_element/extractor.py`, replace the compression import with
`from ..image_store import store_image_bytes`, fix the `extract_header_element` docstring
("Returns: HeaderElementData containing raw bytes and the stored image's hash, or None …"), and
rewrite the tail of `_build_override_data`:

```python
        content_hash = store_image_bytes(
            image_result["imageData"],
            image_result["contentType"],
            is_header=True,
        )
        if not content_hash:
            logger.warning(
                f"HeaderElementExtractor: Failed to store override image {override_url}"
            )
            return None

        return HeaderElementData(
            image_bytes=image_result["imageData"],
            content_type=image_result["contentType"],
            content_hash=content_hash,
            image_url=override_url,
        )
```

Update `core/aggregators/base.py:539`'s docstring the same way ("raw bytes and the stored image's
hash").

- [ ] **Step 7: Point the five consumers at the reference**

`core/aggregators/website.py` (in `process_content`):

```python
        # Determine header image URL for formatting
        header_image_url = header_data.image_ref if header_data else None
```

Apply the identical two lines in:
- `core/aggregators/heise/aggregator.py` (replacing lines 224-227)
- `core/aggregators/mein_mmo/aggregator.py` (replacing lines 183-187, including its now-stale
  "Use base64-encoded data URI if available" comment)
- `core/aggregators/mactechnews/aggregator.py` (replacing lines 208-211)

`core/aggregators/reddit/aggregator.py` in `process_content` (the article-reload path):

```python
            header_data = article.get("header_data")
            if header_data:
                header_html = build_header_html(header_data.image_ref, title=article["name"])
```

Note the `or header_data.image_url` fallback is gone on purpose: `content_hash` is always a real
hash now, because a strategy that cannot store returns `None` and no header renders at all. That is
Spec 4's error contract — a failed header image means *no header*, not *no article*.

- [ ] **Step 8: Update the two tests that build or patch the old field**

In `core/tests/test_domain_image_overrides.py::test_override_short_circuits_strategies`, patch the
store instead of the encoder:

```python
    def test_override_short_circuits_strategies(self):
        fake_image = {"imageData": b"x" * 200, "contentType": "image/svg+xml"}
        stored_hash = "ab" * 32

        extractor = HeaderElementExtractor()
        with (
            patch(
                "core.aggregators.services.header_element.extractor.fetch_single_image",
                return_value=fake_image,
            ) as mock_fetch,
            patch(
                "core.aggregators.services.header_element.extractor.store_image_bytes",
                return_value=stored_hash,
            ) as mock_store,
            patch.object(extractor.strategies[0], "create") as mock_strategy_create,
        ):
            result = extractor.extract_header_element(NINTENDO_SUPPORT_URL)

        assert result is not None
        assert result.image_url == NINTENDO_OVERRIDE_IMAGE
        assert result.content_hash == stored_hash
        assert result.image_ref == f"yana-img://{stored_hash}"
        assert result.content_type == "image/svg+xml"
        mock_fetch.assert_called_once_with(NINTENDO_OVERRIDE_IMAGE)
        mock_store.assert_called_once()
        mock_strategy_create.assert_not_called()
```

In `core/tests/test_caschys_blog_aggregator.py`, both `HeaderElementData(...)` constructions swap
`base64_data_uri="data:image/jpeg;base64,fake"` for `content_hash="c" * 64`.

- [ ] **Step 9: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_hosted_header_images.py core/tests/test_domain_image_overrides.py core/tests/test_caschys_blog_aggregator.py -v
```

Expected: all pass. If a parametrized case in `test_hosted_header_images.py` tries to reach the
network, add the option that disables it to that row's `options` dict — never mock the aggregator
under test.

- [ ] **Step 10: Run the full suite, lint, type-check, commit**

```bash
uv run pytest -q
```

Expected: green except `core/tests/test_reddit_aggregator.py` (Task 4 owns Reddit's own inliner).
If Reddit's tests still pass, so much the better — do not "fix" them here.

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
```

```bash
git add core/aggregators core/tests/image_refs.py core/tests/test_hosted_header_images.py core/tests/test_domain_image_overrides.py core/tests/test_caschys_blog_aggregator.py
git commit -m "feat(images): Reference header images by hash instead of inlining base64"
```

---

## Task 4: Reddit stores its header image

Reddit has its own inliner (`_inline_header_image`) because its header URL comes from the post JSON,
not from the header-element extractor.

**Files:**
- Modify: `core/aggregators/reddit/aggregator.py:17-18,584-588,641-659`
- Test: `core/tests/test_reddit_aggregator.py:906-945`

**Interfaces:**
- Consumes: `image_store.store_image_ref_from_url` (Task 2).
- Produces: `RedditAggregator._store_header_image(header_image_url: str, article: dict) -> str` —
  a `yana-img://` reference, or the original URL when the image could not be stored.

- [ ] **Step 1: Update the failing tests**

In `core/tests/test_reddit_aggregator.py::TestRedditDirectImagePostKeepsItsImage`, replace the two
tests that patch the encoder:

```python
    STORED_REF = f"yana-img://{'d' * 64}"

    @patch("core.aggregators.reddit.aggregator.store_image_ref_from_url")
    def test_body_copy_is_stripped_once_a_header_renders(self, mock_store, reddit_agg):
        mock_store.return_value = self.STORED_REF

        content = reddit_agg.finalize_articles([self._gif_article()])[0]["content"]

        assert self.STORED_REF in content
        assert "data:image" not in content
        assert "i.redd.it/cool.gif" not in content

    @patch("core.aggregators.reddit.aggregator.build_header_html", return_value=None)
    @patch("core.aggregators.reddit.aggregator.store_image_ref_from_url")
    def test_body_image_survives_when_no_header_can_be_rendered(
        self, mock_store, mock_header, reddit_agg
    ):
        mock_store.return_value = self.STORED_REF

        content = reddit_agg.finalize_articles([self._gif_article()])[0]["content"]

        assert "i.redd.it/cool.gif" in content
        assert "<header" not in content
```

And retarget the failed-download test, whose guarantee is unchanged:

```python
    @patch("core.aggregators.reddit.aggregator.store_image_ref_from_url", return_value=None)
    def test_failed_download_still_renders_the_header_from_the_original_url(
        self, mock_store, reddit_agg
    ):
        """Server behavior, deliberately kept: a failed store degrades to the
        remote URL, which still shows the image exactly once."""
        content = reddit_agg.finalize_articles([self._gif_article()])[0]["content"]

        assert '<img src="https://i.redd.it/cool.gif"' in content
        assert content.count("i.redd.it/cool.gif") == 1
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_reddit_aggregator.py -k DirectImagePost -v
```

Expected: `AttributeError: <module 'core.aggregators.reddit.aggregator'> does not have the attribute
'store_image_ref_from_url'`.

- [ ] **Step 3: Replace the inliner with a store call**

In `core/aggregators/reddit/aggregator.py`, swap the two image imports for:

```python
from ..services.image_store import store_image_ref_from_url
```

(`compress_and_encode_image` and `fetch_single_image` have no other use in this module — `ruff`'s
F401 will confirm.) Then replace `_inline_header_image`:

```python
    def _store_header_image(self, header_image_url: str, article: Dict[str, Any]) -> str:
        """
        Store a header image and return its ``yana-img://`` reference.

        Returns the original URL unchanged when the image cannot be stored: a
        remote URL still renders the image exactly once, which is the behavior
        Spec 2's A5 fix deliberately kept.
        """
        if not header_image_url.startswith("http"):
            return header_image_url

        try:
            ref = store_image_ref_from_url(header_image_url, is_header=True)
            if ref:
                return ref
        except Exception as e:
            logger.warning(f"Failed to store header image for {article.get('name')}: {e}")

        return header_image_url
```

Update the caller in `finalize_articles` and its comment:

```python
                # YouTube/Twitter headers are embedded from their source URL;
                # plain images are stored and referenced by hash.
                render_url = header_source_url
                if not (is_youtube_header or is_twitter_header):
                    render_url = self._store_header_image(header_source_url, article)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_reddit_aggregator.py core/tests/test_reddit_posts.py core/tests/test_reddit_comments.py -q
```

Expected: all pass.

- [ ] **Step 5: Lint, type-check, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
```

```bash
git add core/aggregators/reddit/aggregator.py core/tests/test_reddit_aggregator.py
git commit -m "feat(reddit): Store header images instead of inlining them"
```

---

## Task 5: Oglaf uses the shared store, and its option is retired

**Files:**
- Modify: `core/aggregators/oglaf/aggregator.py:3,21,36-53,81-121`
- Create: `core/migrations/0033_drop_oglaf_convert_to_base64.py`
- Test: `core/tests/test_oglaf_aggregator.py`

**Interfaces:**
- Consumes: `image_store.store_image_ref_from_url` (Task 2).
- Produces: `OglafAggregator.get_configuration_fields()` returning `{"show_alt_text": ...}` only;
  migration `0033` removing `convert_to_base64` from every `Feed.options`.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_oglaf_aggregator.py`:

```python
"""Tests for the Oglaf aggregator's hosted comic image."""

import importlib
from unittest.mock import patch

from django.apps import apps as global_apps

import pytest

from core.aggregators.oglaf.aggregator import OglafAggregator
from core.models import Feed
from core.tests.image_refs import assert_hosted_image

COMIC_HTML = """
<div class="content">
    <img id="strip" src="https://media.oglaf.com/comic/tribute.jpg"
         alt="Tribute" title="The second joke">
</div>
"""

STORED_REF = f"yana-img://{'f0' * 32}"


@pytest.fixture
def oglaf_feed(user):
    return Feed.objects.create(
        name="Oglaf",
        aggregator="oglaf",
        identifier="https://www.oglaf.com/feeds/rss/",
        user=user,
    )


def make_article() -> dict:
    return {"name": "Tribute", "identifier": "https://www.oglaf.com/tribute/"}


@pytest.mark.django_db
class TestOglafHostedImage:
    def test_the_comic_is_stored_and_referenced(self, oglaf_feed):
        with patch(
            "core.aggregators.oglaf.aggregator.store_image_ref_from_url",
            return_value=STORED_REF,
        ) as mock_store:
            processed = OglafAggregator(oglaf_feed).process_content(COMIC_HTML, make_article())

        mock_store.assert_called_once_with("https://media.oglaf.com/comic/tribute.jpg")
        assert_hosted_image(processed, STORED_REF.removeprefix("yana-img://"))

    def test_alt_text_still_renders_below_the_comic(self, oglaf_feed):
        with patch(
            "core.aggregators.oglaf.aggregator.store_image_ref_from_url",
            return_value=STORED_REF,
        ):
            processed = OglafAggregator(oglaf_feed).process_content(COMIC_HTML, make_article())

        assert "The second joke" in processed

    def test_a_store_failure_degrades_to_the_remote_url(self, oglaf_feed):
        with patch(
            "core.aggregators.oglaf.aggregator.store_image_ref_from_url", return_value=None
        ):
            processed = OglafAggregator(oglaf_feed).process_content(COMIC_HTML, make_article())

        assert "https://media.oglaf.com/comic/tribute.jpg" in processed
        assert "data:image" not in processed

    def test_convert_to_base64_is_no_longer_configurable(self):
        assert "convert_to_base64" not in OglafAggregator.get_configuration_fields()
        assert "show_alt_text" in OglafAggregator.get_configuration_fields()


@pytest.mark.django_db
class TestOglafOptionsMigration:
    @staticmethod
    def _run_forwards():
        module = importlib.import_module(
            "core.migrations.0033_drop_oglaf_convert_to_base64"
        )
        module.forwards(global_apps, None)

    def test_the_retired_key_is_dropped(self, user):
        feed = Feed.objects.create(
            name="Oglaf",
            aggregator="oglaf",
            identifier="https://www.oglaf.com/feeds/rss/",
            user=user,
            options={"convert_to_base64": True, "show_alt_text": False},
        )

        self._run_forwards()

        feed.refresh_from_db()
        assert feed.options == {"show_alt_text": False}

    def test_feeds_without_the_key_are_untouched(self, rss_feed):
        rss_feed.options = {"content_selectors": ["article"]}
        rss_feed.save(update_fields=["options"])

        self._run_forwards()

        rss_feed.refresh_from_db()
        assert rss_feed.options == {"content_selectors": ["article"]}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_oglaf_aggregator.py -v
```

Expected: failures — the module patch target does not exist, `convert_to_base64` is still a config
field, and the migration module is missing.

- [ ] **Step 3: Rewrite Oglaf's image handling**

In `core/aggregators/oglaf/aggregator.py`: delete `import base64`, import the store, drop the
`convert_to_base64` form field, and replace the encoding block.

```python
"""Oglaf aggregator implementation."""

import logging
from typing import Any, Dict, Optional

from bs4 import BeautifulSoup, Tag

from ..services.image_store import store_image_ref_from_url
from ..utils import format_article_content, get_attr_str
from ..website import FullWebsiteAggregator
```

Class docstring: "Handles extraction of the comic image, which is stored in the shared image store
and referenced by hash." Configuration fields keep `show_alt_text` only:

```python
        return {
            "show_alt_text": forms.BooleanField(
                initial=True,
                label="Show Alt Text",
                help_text="Display the comic's 'title' text (often containing a second joke) below the image.",
                required=False,
            ),
        }
```

`process_content` drops the option read and the inline encoding:

```python
    def process_content(self, html: str, article: Dict[str, Any]) -> str:
        """Process Oglaf content by extracting and storing the comic image."""
        show_alt_text = self.feed.options.get("show_alt_text", True)

        soup = BeautifulSoup(html, "html.parser")
        ...
            # Store the comic once; fall back to the remote URL if that fails.
            img_src = store_image_ref_from_url(img_url) or img_url
```

(The URL-normalizing and alt/joke extraction above it are unchanged.)

- [ ] **Step 4: Write the options migration**

Create `core/migrations/0033_drop_oglaf_convert_to_base64.py`:

```python
"""Drop Oglaf's retired ``convert_to_base64`` option.

Oglaf's comic image now goes through the shared content-addressed image store
like every other image, so the toggle has nothing left to switch. The reverse
operation is a deliberate no-op: restoring a key no code reads would only make
the stored options lie about what the aggregator does.
"""

import logging

from django.db import migrations

logger = logging.getLogger(__name__)


def forwards(apps, schema_editor):
    Feed = apps.get_model("core", "Feed")

    for feed in Feed.objects.all():
        if not isinstance(feed.options, dict) or "convert_to_base64" not in feed.options:
            continue

        logger.info("Feed %s: dropping the retired convert_to_base64 option", feed.pk)
        feed.options.pop("convert_to_base64")
        feed.save(update_fields=["options"])


def backwards(apps, schema_editor):
    """No-op: the option no longer exists."""


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0032_articleimage"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_oglaf_aggregator.py core/tests/test_forms.py core/tests/test_selector_options.py -v
```

Expected: all pass.

- [ ] **Step 6: Apply the migration, lint, type-check, commit**

```bash
uv run python manage.py migrate && uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
```

```bash
git add core/aggregators/oglaf/aggregator.py core/migrations/0033_drop_oglaf_convert_to_base64.py core/tests/test_oglaf_aggregator.py
git commit -m "feat(oglaf): Store the comic image instead of embedding base64"
```

---

## Task 6: Delete the base64 producers and guard against their return

**Files:**
- Modify: `core/aggregators/services/image_extraction/compression.py:1-13,165-233`
- Modify: `core/aggregators/services/image_extraction/__init__.py`
- Modify: `core/aggregators/services/config.py:63-64`
- Create: `core/tests/test_no_inline_base64.py`

**Interfaces:**
- Consumes: nothing new. After Tasks 3-5, `compress_and_encode_image` and `create_image_element`
  have no callers.
- Produces: a guard test that fails if any production module under `core/` encodes an image as
  base64 again.

- [ ] **Step 1: Write the failing guard test**

Create `core/tests/test_no_inline_base64.py`:

```python
"""Guard tests: images are stored, never inlined as base64.

Spec 4 replaced every ``data:image/...;base64,...`` producer with the
content-addressed store. These assert absence so a future change cannot
silently reintroduce inlining -- the failure mode that inflated every image by
~33% and stored the same picture once per article.
"""

from pathlib import Path

import core

PRODUCTION_ROOT = Path(core.__file__).parent

# The backfill decodes existing data URIs; it is the one module allowed to
# mention them.
ALLOWED_DATA_URI_MENTIONS = {
    PRODUCTION_ROOT / "management" / "commands" / "migrate_inline_images.py",
}


def production_modules():
    for path in sorted(PRODUCTION_ROOT.rglob("*.py")):
        if "tests" in path.parts or path.name.startswith("test"):
            continue
        if "migrations" in path.parts:
            continue
        yield path


def test_no_production_module_encodes_images_as_base64():
    offenders = [
        str(path.relative_to(PRODUCTION_ROOT))
        for path in production_modules()
        if "b64encode" in path.read_text()
    ]

    assert offenders == [], f"base64 encoding is back in {offenders}"


def test_only_the_backfill_mentions_base64_data_uris():
    offenders = [
        str(path.relative_to(PRODUCTION_ROOT))
        for path in production_modules()
        if ";base64," in path.read_text() and path not in ALLOWED_DATA_URI_MENTIONS
    ]

    assert offenders == [], f"base64 data URIs are back in {offenders}"


def test_the_base64_feature_flag_is_gone():
    from core.aggregators.services import config

    assert not hasattr(config, "ENABLE_BASE64_ENCODING")


def test_the_data_uri_helpers_are_gone():
    from core.aggregators.services.image_extraction import compression

    assert not hasattr(compression, "compress_and_encode_image")
    assert not hasattr(compression, "create_image_element")
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_no_inline_base64.py -v
```

Expected: all four fail — `compression.py` still encodes, and `config.ENABLE_BASE64_ENCODING` still
exists.

- [ ] **Step 3: Delete the producers**

In `core/aggregators/services/image_extraction/compression.py`: delete `import base64`, delete
`compress_and_encode_image` (lines 165-212) and `create_image_element` (lines 215-233), and update
the module docstring:

```python
"""
Image compression utilities.

Handles:
- Image resizing and format conversion using Pillow
- Quality optimization

Compressed bytes go to the content-addressed store
(``core/aggregators/services/image_store.py``); nothing here produces base64.
"""
```

In `core/aggregators/services/image_extraction/__init__.py`, drop both names from the import and
from `__all__`, leaving `compress_image`.

In `core/aggregators/services/config.py`, delete the `ENABLE_BASE64_ENCODING` block (lines 63-64).

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_no_inline_base64.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Run the full suite, lint, type-check, commit**

```bash
uv run pytest -q
```

Expected: green. A failure here means a caller was missed in Tasks 3-5 — fix the caller, do not
restore the helper.

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
```

```bash
git add core/aggregators/services core/tests/test_no_inline_base64.py
git commit -m "refactor(images): Delete the base64 encoders and their feature flag"
```

---

## Task 7: The `migrate_inline_images` backfill command

**Files:**
- Create: `core/management/commands/migrate_inline_images.py`
- Test: `core/tests/test_migrate_inline_images.py`

**Interfaces:**
- Consumes: `image_store.store_image_bytes(..., compress=False)`, `image_store.build_image_ref`.
- Produces: `uv run python manage.py migrate_inline_images [--dry-run] [--limit N] [--batch-size N]`.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_migrate_inline_images.py`:

```python
"""Tests for the inline-image backfill command."""

import base64
import hashlib
import io
from io import StringIO

from django.core.management import call_command

import pytest
from PIL import Image

from core.aggregators.services.image_extraction.compression import compress_image
from core.aggregators.services.image_store import store_image_bytes
from core.models import Article, ArticleImage


def noisy_png(seed: int = 0, size: tuple[int, int] = (300, 300)) -> bytes:
    width, height = size
    img = Image.new("RGB", size)
    img.putdata(
        [((i * 7 + seed) % 256, (i * 13 + seed) % 256, (i * 29 + seed) % 256)
         for i in range(width * height)]
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

        run()

        assert ArticleImage.objects.count() == 1

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

        run()

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
            article
            for article in Article.objects.all()
            if "data:image" not in article.content
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_migrate_inline_images.py -v
```

Expected: `CommandError: Unknown command: 'migrate_inline_images'`.

- [ ] **Step 3: Write the command**

Create `core/management/commands/migrate_inline_images.py`:

```python
"""
Backfill: convert inline base64 data URIs in article content to stored images.

Walks ``Article.content``, decodes each ``data:image/...;base64,...`` payload,
stores it in the content-addressed image store, and replaces the URI with
``yana-img://<hash>``. Only ``content`` is rewritten -- ``raw_content`` is the
untouched source HTML, and any data URI in it came from the publisher.

The decoded bytes are stored verbatim (``compress=False``): they are already
compression output, and re-compressing them would produce a different hash than
a fresh aggregation of the same source image, creating a duplicate row.

Batched and idempotent -- it runs over the whole article table and must be safe
to interrupt and resume. Each batch commits on its own; a partial run leaves
converted articles converted and the rest untouched.

Usage:
    python manage.py migrate_inline_images --dry-run
    python manage.py migrate_inline_images --limit 100
    python manage.py migrate_inline_images
"""

import base64
import binascii
import hashlib
import logging
import re

from django.core.management.base import BaseCommand
from django.db import transaction

from core.aggregators.services.image_store import build_image_ref, store_image_bytes
from core.models import Article

logger = logging.getLogger(__name__)

DATA_URI_PATTERN = re.compile(r"data:(image/[\w.+-]+);base64,([A-Za-z0-9+/=]+)")
DEFAULT_BATCH_SIZE = 200


class Command(BaseCommand):
    help = "Convert inline base64 images in article content to stored ArticleImage rows"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would change without writing anything",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=None,
            help="Process at most this many articles (for a trial run)",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=DEFAULT_BATCH_SIZE,
            help=f"Articles per transaction (default: {DEFAULT_BATCH_SIZE})",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        limit = options["limit"]
        batch_size = max(1, options["batch_size"])

        pending = (
            Article.objects.filter(content__contains="data:image")
            .only("id", "content")
            .order_by("pk")
        )

        converted_articles = 0
        stored_images = 0
        skipped_articles = 0
        bytes_saved = 0
        processed = 0

        for batch in self._batches(pending, batch_size, limit):
            with transaction.atomic():
                for article in batch:
                    processed += 1
                    result = self._convert(article.content, dry_run=dry_run)

                    if result is None:
                        skipped_articles += 1
                        logger.warning(
                            "Article %s: undecodable base64 payload -- leaving its "
                            "content untouched",
                            article.id,
                        )
                        continue

                    new_content, image_count = result
                    if image_count == 0:
                        continue

                    converted_articles += 1
                    stored_images += image_count
                    bytes_saved += len(article.content) - len(new_content)

                    if not dry_run:
                        article.content = new_content
                        article.save(update_fields=["content"])

        verb = "would convert" if dry_run else "converted"
        savings_verb = "would save" if dry_run else "saved"
        self.stdout.write(
            f"{verb} {converted_articles} articles ({stored_images} images), "
            f"{savings_verb} {bytes_saved} bytes of content"
        )
        if skipped_articles:
            self.stdout.write(
                self.style.WARNING(
                    f"skipped {skipped_articles} articles with undecodable payloads "
                    "(see the log for their IDs)"
                )
            )
        self.stdout.write(
            self.style.SUCCESS(f"scanned {processed} articles containing data URIs")
        )

    def _batches(self, queryset, batch_size: int, limit: int | None):
        """Yield lists of articles, honoring --limit, re-querying per batch."""
        remaining = limit
        last_pk = 0

        while remaining is None or remaining > 0:
            size = batch_size if remaining is None else min(batch_size, remaining)
            batch = list(queryset.filter(pk__gt=last_pk)[:size])
            if not batch:
                return

            yield batch

            last_pk = batch[-1].pk
            if remaining is not None:
                remaining -= len(batch)

    @staticmethod
    def _convert(content: str, *, dry_run: bool) -> tuple[str, int] | None:
        """
        Replace every data URI in content with a stored-image reference.

        Returns the new content and the number of images, or None when any
        payload could not be decoded (in which case the whole article is left
        alone -- a half-rewritten body is worse than an unconverted one).
        """
        matches = list(DATA_URI_PATTERN.finditer(content))
        if not matches:
            return content, 0

        replacements = []
        for match in matches:
            content_type, payload = match.group(1), match.group(2)
            try:
                decoded = base64.b64decode(payload, validate=True)
            except (binascii.Error, ValueError):
                return None

            if dry_run:
                # Hash without storing so the reported savings are real.
                content_hash = hashlib.sha256(decoded).hexdigest()
            else:
                content_hash = store_image_bytes(decoded, content_type, compress=False)

            if not content_hash:
                return None

            replacements.append((match.span(), build_image_ref(content_hash)))

        new_content = content
        for (start, end), ref in reversed(replacements):
            new_content = new_content[:start] + ref + new_content[end:]

        return new_content, len(replacements)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_migrate_inline_images.py -v
```

Expected: all pass.

- [ ] **Step 5: Lint, type-check, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
```

```bash
git add core/management/commands/migrate_inline_images.py core/tests/test_migrate_inline_images.py
git commit -m "feat(images): Add the migrate_inline_images backfill command"
```

---

## Task 8: The `prune_orphaned_images` command

**Files:**
- Create: `core/management/commands/prune_orphaned_images.py`
- Test: `core/tests/test_prune_orphaned_images.py`

**Interfaces:**
- Consumes: `image_store.find_image_refs`; `core.models.ArticleImage`, `core.models.Article`.
- Produces: `uv run python manage.py prune_orphaned_images [--dry-run] [--min-age DAYS]`.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_prune_orphaned_images.py`:

```python
"""Tests for the orphaned-image reaper."""

import os
from datetime import timedelta
from io import StringIO

from django.core.files.base import ContentFile
from django.core.management import call_command
from django.utils import timezone

import pytest

from core.models import Article, ArticleImage


@pytest.fixture(autouse=True)
def isolated_media_root(settings, tmp_path):
    settings.MEDIA_ROOT = str(tmp_path / "media")
    return tmp_path / "media"


def make_image(content_hash: str, *, age_days: int = 30) -> ArticleImage:
    image = ArticleImage(
        content_hash=content_hash,
        content_type="image/webp",
        byte_size=4,
    )
    image.file.save(f"{content_hash}.webp", ContentFile(b"data"), save=False)
    image.save()
    ArticleImage.objects.filter(pk=image.pk).update(
        created_at=timezone.now() - timedelta(days=age_days)
    )
    image.refresh_from_db()
    return image


def run(**kwargs) -> str:
    out = StringIO()
    call_command("prune_orphaned_images", stdout=out, **kwargs)
    return out.getvalue()


@pytest.mark.django_db
class TestPruning:
    def test_an_unreferenced_image_is_deleted_with_its_file(self):
        image = make_image("a" * 64)
        file_path = image.file.path

        run()

        assert ArticleImage.objects.count() == 0
        assert not os.path.exists(file_path)

    def test_a_referenced_image_is_kept(self, rss_feed):
        image = make_image("b" * 64)
        Article.objects.create(
            name="Referencing",
            identifier="https://example.com/ref",
            raw_content="",
            content=f'<img src="yana-img://{image.content_hash}">',
            feed=rss_feed,
        )

        run()

        assert ArticleImage.objects.filter(pk=image.pk).exists()

    def test_an_image_younger_than_min_age_is_kept(self):
        """An image stored moments before its article must not be collected."""
        image = make_image("c" * 64, age_days=0)

        run()

        assert ArticleImage.objects.filter(pk=image.pk).exists()

    def test_min_age_is_configurable(self):
        image = make_image("d" * 64, age_days=3)

        run(min_age=1)

        assert not ArticleImage.objects.filter(pk=image.pk).exists()

    def test_dry_run_deletes_nothing(self):
        image = make_image("e" * 64)

        output = run(dry_run=True)

        assert ArticleImage.objects.filter(pk=image.pk).exists()
        assert "would delete 1" in output

    def test_a_row_whose_file_is_missing_is_reported(self, rss_feed):
        image = make_image("f" * 64)
        Article.objects.create(
            name="Referencing",
            identifier="https://example.com/ref",
            raw_content="",
            content=f'<img src="yana-img://{image.content_hash}">',
            feed=rss_feed,
        )
        image.file.storage.delete(image.file.name)

        output = run()

        assert "missing file" in output
        assert image.content_hash[:12] in output
        assert ArticleImage.objects.filter(pk=image.pk).exists()

    def test_a_fresh_database_reports_zero_orphans(self):
        output = run(dry_run=True)

        assert "would delete 0" in output
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_prune_orphaned_images.py -v
```

Expected: `CommandError: Unknown command: 'prune_orphaned_images'`.

- [ ] **Step 3: Write the command**

Create `core/management/commands/prune_orphaned_images.py`:

```python
"""
Delete ``ArticleImage`` rows that no article references any more.

Content-addressed storage needs a reaper: an image whose referencing articles
are all gone is dead weight on disk and in the database.

EFFICIENCY CAVEAT (temporary): until Spec 5 lands, finding references means
scanning every ``Article.content`` for ``yana-img://`` hashes, because the only
place a reference exists is that text. That is acceptable for a periodic
maintenance command and unacceptable for anything hot. Once
``ArticleBlock.image_ref`` exists and is indexed, this becomes a JOIN and this
command should be rewritten accordingly.

The command also reports rows whose file is gone from disk (manual deletion,
failed storage) -- the serving layer would 404 on those.

Usage:
    python manage.py prune_orphaned_images --dry-run
    python manage.py prune_orphaned_images --min-age 30
    python manage.py prune_orphaned_images
"""

from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from core.aggregators.services.image_store import find_image_refs
from core.models import Article, ArticleImage

DEFAULT_MIN_AGE_DAYS = 7
MISSING_FILE_REPORT_LIMIT = 20


class Command(BaseCommand):
    help = "Delete ArticleImage rows and files that no article content references"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be deleted without deleting anything",
        )
        parser.add_argument(
            "--min-age",
            type=int,
            default=DEFAULT_MIN_AGE_DAYS,
            help=(
                "Only prune images older than this many days, so an image stored "
                f"moments before its article is not collected (default: {DEFAULT_MIN_AGE_DAYS})"
            ),
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        cutoff = timezone.now() - timedelta(days=options["min_age"])

        referenced = self._referenced_hashes()
        self.stdout.write(f"{len(referenced)} image(s) referenced by article content")

        deleted = 0
        freed_bytes = 0
        missing_files = []

        for image in ArticleImage.objects.all().iterator(chunk_size=200):
            if not image.file or not image.file.storage.exists(image.file.name):
                missing_files.append(image.content_hash)

            if image.content_hash in referenced or image.created_at >= cutoff:
                continue

            deleted += 1
            freed_bytes += image.byte_size

            if not dry_run:
                image.file.delete(save=False)
                image.delete()

        verb = "would delete" if dry_run else "deleted"
        self.stdout.write(
            self.style.SUCCESS(f"{verb} {deleted} orphaned image(s), {freed_bytes} bytes")
        )

        if missing_files:
            shown = ", ".join(h[:12] for h in missing_files[:MISSING_FILE_REPORT_LIMIT])
            suffix = "" if len(missing_files) <= MISSING_FILE_REPORT_LIMIT else ", ..."
            self.stdout.write(
                self.style.WARNING(
                    f"{len(missing_files)} row(s) with a missing file: {shown}{suffix}"
                )
            )

    @staticmethod
    def _referenced_hashes() -> set[str]:
        """Every hash referenced by any article's content."""
        referenced: set[str] = set()
        contents = (
            Article.objects.exclude(content="")
            .values_list("content", flat=True)
            .iterator(chunk_size=200)
        )
        for content in contents:
            referenced |= find_image_refs(content)
        return referenced
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_prune_orphaned_images.py -v
```

Expected: all pass.

- [ ] **Step 5: Lint, type-check, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
```

```bash
git add core/management/commands/prune_orphaned_images.py core/tests/test_prune_orphaned_images.py
git commit -m "feat(images): Add the prune_orphaned_images command"
```

---

## Task 9: Admin — the verification surface

**Files:**
- Modify: `core/admin.py:19-21` (imports), `core/admin.py:469-500` (`ArticleAdmin`), and a new
  `ArticleImageAdmin`
- Create: `core/templates/admin/core/articleimage/change_list.html`
- Test: `core/tests/test_article_image_admin.py`

**Interfaces:**
- Consumes: `core.models.ArticleImage`; `image_store.find_image_refs`.
- Produces: an `ArticleImage` changelist with thumbnails, a byte-size total, content-type filtering
  and hash-prefix search; a read-only-but-deletable model admin; a `referenced_images` display on
  the Article change page.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_article_image_admin.py`:

```python
"""Admin is the verification surface for hosted images this phase."""

from django.core.files.base import ContentFile
from django.urls import reverse

import pytest

from core.models import Article, ArticleImage


@pytest.fixture(autouse=True)
def isolated_media_root(settings, tmp_path):
    settings.MEDIA_ROOT = str(tmp_path / "media")
    return tmp_path / "media"


@pytest.fixture
def stored_image():
    image = ArticleImage(
        content_hash="ab" * 32,
        content_type="image/webp",
        width=800,
        height=600,
        byte_size=2048,
    )
    image.file.save(f"{'ab' * 32}.webp", ContentFile(b"payload"), save=False)
    image.save()
    return image


@pytest.mark.django_db
class TestArticleImageChangelist:
    def test_the_changelist_shows_the_image(self, admin_client, stored_image):
        response = admin_client.get(reverse("admin:core_articleimage_changelist"))

        assert response.status_code == 200
        content = response.content.decode()
        assert stored_image.content_hash[:12] in content
        assert "image/webp" in content
        assert "800" in content

    def test_the_changelist_totals_the_stored_bytes(self, admin_client, stored_image):
        response = admin_client.get(reverse("admin:core_articleimage_changelist"))

        assert "2048" in response.content.decode()

    def test_hash_prefix_search_finds_the_row(self, admin_client, stored_image):
        response = admin_client.get(
            reverse("admin:core_articleimage_changelist"),
            {"q": stored_image.content_hash[:8]},
        )

        assert response.status_code == 200
        assert stored_image.content_hash[:12] in response.content.decode()

    def test_rows_cannot_be_added_by_hand(self, admin_client):
        """A hand-written content-addressed row makes the hash a lie."""
        response = admin_client.get(reverse("admin:core_articleimage_add"))

        assert response.status_code == 403

    def test_deletion_stays_available(self, admin_client, stored_image):
        response = admin_client.get(
            reverse("admin:core_articleimage_delete", args=[stored_image.pk])
        )

        assert response.status_code == 200


@pytest.mark.django_db
class TestArticleReferencedImages:
    def test_the_article_page_shows_its_referenced_images(
        self, admin_client, rss_feed, stored_image
    ):
        article = Article.objects.create(
            name="Referencing",
            identifier="https://example.com/ref",
            raw_content="",
            content=f'<img src="yana-img://{stored_image.content_hash}">',
            feed=rss_feed,
        )

        response = admin_client.get(
            reverse("admin:core_article_change", args=[article.pk])
        )

        assert response.status_code == 200
        assert stored_image.file.url in response.content.decode()

    def test_a_reference_with_no_stored_row_is_flagged(self, admin_client, rss_feed):
        article = Article.objects.create(
            name="Dangling",
            identifier="https://example.com/dangling",
            raw_content="",
            content=f'<img src="yana-img://{"cd" * 32}">',
            feed=rss_feed,
        )

        response = admin_client.get(
            reverse("admin:core_article_change", args=[article.pk])
        )

        assert "missing" in response.content.decode()

    def test_an_article_without_references_says_so(self, admin_client, article):
        response = admin_client.get(
            reverse("admin:core_article_change", args=[article.pk])
        )

        assert "No hosted images" in response.content.decode()
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_article_image_admin.py -v
```

Expected: `NoReverseMatch: 'core_articleimage_changelist' is not a registered admin URL`.

- [ ] **Step 3: Register the admin**

In `core/admin.py`, extend the imports:

```python
from django.db.models import Sum
from django.template.defaultfilters import filesizeformat
from django.utils.html import format_html, format_html_join

from .aggregators.services.image_store import find_image_refs
from .forms import FeedAdminForm, TextareaWithCopyButtonWidget, UserSettingsAdminForm
from .models import (
    Article,
    ArticleImage,
    Feed,
    FeedGroup,
    RedditSubreddit,
    UserSettings,
    YouTubeChannel,
)
```

Add the admin (after `ArticleAdmin`):

```python
@admin.register(ArticleImage)
class ArticleImageAdmin(YanaDjangoQLMixin, admin.ModelAdmin):
    """
    Read-only view of the content-addressed image store.

    Rows are derived from aggregation: hand-editing one makes its hash a lie, so
    adding and changing are disabled. Deletion stays available for manual
    cleanup (``prune_orphaned_images`` is the automated path).
    """

    list_display = [
        "thumbnail",
        "short_hash",
        "content_type",
        "dimensions",
        "byte_size",
        "created_at",
    ]
    list_filter = ["content_type", "created_at"]
    search_fields = ["content_hash"]
    readonly_fields = [
        "preview",
        "content_hash",
        "file",
        "content_type",
        "width",
        "height",
        "byte_size",
        "created_at",
    ]
    fields = readonly_fields
    change_list_template = "admin/core/articleimage/change_list.html"

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    @admin.display(description="Preview")
    def thumbnail(self, obj):
        if not obj.file:
            return "-"
        return format_html(
            '<img src="{}" style="max-height: 60px; max-width: 100px;">', obj.file.url
        )

    @admin.display(description="Image")
    def preview(self, obj):
        if not obj.file:
            return "-"
        return format_html(
            '<a href="{}" target="_blank"><img src="{}" style="max-height: 400px; '
            'max-width: 100%;"></a>',
            obj.file.url,
            obj.file.url,
        )

    @admin.display(description="Hash", ordering="content_hash")
    def short_hash(self, obj):
        return obj.content_hash[:12]

    @admin.display(description="Dimensions")
    def dimensions(self, obj):
        if not obj.width or not obj.height:
            return "-"
        return f"{obj.width}x{obj.height}"

    def changelist_view(self, request, extra_context=None):
        """Add the stored-byte total -- the number that makes the savings visible."""
        response = super().changelist_view(request, extra_context=extra_context)

        context = getattr(response, "context_data", None)
        if not context or "cl" not in context:
            return response

        total = context["cl"].queryset.aggregate(total=Sum("byte_size"))["total"] or 0
        context["total_byte_size"] = total
        context["total_byte_size_display"] = filesizeformat(total)
        return response
```

Create `core/templates/admin/core/articleimage/change_list.html`:

```html
{% extends "admin/change_list.html" %}

{% block result_list %}
  <p class="help">
    Total stored: {{ total_byte_size_display }} ({{ total_byte_size }} bytes)
    across {{ cl.result_count }} image(s).
  </p>
  {{ block.super }}
{% endblock %}
```

- [ ] **Step 4: Show an article's images on its change page**

In `ArticleAdmin`, add the display method, register it as readonly, and give it a fieldset:

```python
    readonly_fields = ["created_at", "updated_at", "referenced_images"]
```

```python
    fieldsets = (
        (None, {"fields": ("name", "identifier", "feed")}),
        ("Content", {"fields": ("raw_content", "content")}),
        ("Images", {"fields": ("referenced_images",)}),
        ("Metadata", {"fields": ("author", "icon", "date")}),
        ("Status", {"fields": ("read", "starred")}),
        ("Timestamps", {"fields": ("created_at", "updated_at"), "classes": ("collapse",)}),
    )
```

```python
    @admin.display(description="Referenced images")
    def referenced_images(self, obj):
        """Show the stored images this article references, so a missing one is
        traceable to the article that wanted it."""
        if not obj or not obj.pk:
            return "-"

        hashes = find_image_refs(obj.content or "")
        if not hashes:
            return "No hosted images referenced"

        stored = {
            image.content_hash: image
            for image in ArticleImage.objects.filter(content_hash__in=hashes)
        }

        cells = []
        for content_hash in sorted(hashes):
            image = stored.get(content_hash)
            if image and image.file:
                cells.append(
                    format_html(
                        '<a href="{}" target="_blank"><img src="{}" '
                        'style="max-height: 90px; margin: 0 8px 8px 0;"></a>',
                        image.file.url,
                        image.file.url,
                    )
                )
            else:
                cells.append(
                    format_html('<span style="color: #ba2121;">missing: {}</span> ', content_hash)
                )

        return format_html_join("", "{}", ((cell,) for cell in cells))
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_article_image_admin.py core/tests/test_branding.py -v
```

Expected: all pass. If `test_rows_cannot_be_added_by_hand` gets a 302 rather than a 403, Django
redirected to the login page — check that `admin_client` is the pytest-django superuser fixture.

- [ ] **Step 6: Lint, type-check, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
```

```bash
git add core/admin.py core/templates/admin/core/articleimage/change_list.html core/tests/test_article_image_admin.py
git commit -m "feat(admin): Register ArticleImage and show an article's hosted images"
```

---

## Task 10: Documentation and end-to-end verification

**Files:**
- Modify: `core/aggregators/README.md` (new "Image Storage" section after "Content Selection")
- Modify: `README.md` (Features bullet, Project Architecture, a maintenance-commands note)
- Modify: `CLAUDE.md` (project structure, Key Models, aggregator flow note, HTTP surface)

- [ ] **Step 1: Document the store in the aggregator guide**

Add to `core/aggregators/README.md`, after the "Content Selection" section:

```markdown
## Image Storage

Images are **stored once and referenced by hash**, never inlined as base64.

`core/aggregators/services/image_store.py` is the only writer:

```
remote URL -> fetch (image_extraction) -> compress (compression.py)
           -> sha256(compressed bytes) -> ArticleImage row -> return the hash
```

Article content carries the reference, not the bytes:

```html
<img src="yana-img://3f786850e387550fdab836ed7e6dc881de23001b...">
```

Key properties:

- **The hash is over the compressed output**, so the same source image compresses to the same bytes,
  finds the existing row, and stores nothing new. Deduplication is free; the unique constraint on
  `content_hash` makes concurrent runs safe.
- **A failed store means no image**, not no article. The header-element strategies return `None`, so
  no header renders and the body publishes as usual. (Reddit's own header path is the documented
  exception: it degrades to the remote URL, which still shows the image exactly once.)
- **A failed compression stores the original bytes** and logs it -- a large stored image beats a
  missing one.
- Storage lives on local disk under `MEDIA_ROOT/article_images/YYYY/MM/`. Admin serves it via
  `/media/` so images are verifiable by eye; the authenticated HTTP endpoint belongs to the new API.

### Maintenance commands

```bash
# Convert legacy inline data URIs in existing articles (batched, idempotent)
uv run python manage.py migrate_inline_images --dry-run
uv run python manage.py migrate_inline_images

# Delete images no article references any more (and report rows with missing files)
uv run python manage.py prune_orphaned_images --dry-run
uv run python manage.py prune_orphaned_images --min-age 30
```
```

- [ ] **Step 2: Document it in the user-facing README**

In `README.md`, add to Features:

```markdown
-   **Deduplicated Image Storage:** Article images are stored once, content-addressed by hash, and referenced from article content -- no base64 bloat in the database.
```

In "Project Architecture", under `core/aggregators/`:

```markdown
    -   `services/image_store.py`: Content-addressed image storage (`yana-img://<hash>` references).
```

And under `core/models.py`, extend the model list to `Feed`, `Article`, `ArticleImage`, `FeedGroup`.

- [ ] **Step 3: Update CLAUDE.md**

Three edits:

1. Project structure — add to the `services/` tree and the commands list:

```
│   │   ├── services/                 # Business logic layer
...
│   ├── aggregators/
│   │   ├── services/
│   │   │   └── image_store.py       # Content-addressed image storage
...
│   ├── management/commands/         # CLI commands
│   │   ├── migrate_inline_images.py  # Backfill inline data URIs -> stored images
│   │   ├── prune_orphaned_images.py  # Delete unreferenced images
```

2. Key Models — add a row:

```markdown
| `ArticleImage` | content_hash, file, content_type, width, height, byte_size | Content-addressed; referenced from content as `yana-img://<hash>` |
```

3. After the "Article dates" note, add:

```markdown
**Article images:** images are stored once as `ArticleImage` (SHA-256 of the *compressed* bytes) and
referenced from `Article.content` as `yana-img://<hash>`. Nothing inlines base64 — `core/tests/test_no_inline_base64.py`
guards that. `migrate_inline_images` backfills legacy content; `prune_orphaned_images` reaps
unreferenced rows.
```

Also extend the HTTP surface table's `/media/…` row: "Media files — including the stored article
images, which is how admin previews them this phase".

- [ ] **Step 4: Run every check**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

Expected: clean lint, clean mypy, full suite green, coverage >80%.

- [ ] **Step 5: Verify against a live feed (manual, from the spec's verification list)**

```bash
uv run python manage.py migrate
```

```bash
uv run python manage.py test_aggregator heise --limit 2 --first 1 --verbose
```

Expected: the printed content contains `yana-img://…` and no `data:image` blob.

Then, in admin (`uv run python manage.py runserver`):
1. **Article Images** lists rows with a sensible short hash, content type, dimensions and byte size,
   newest first; the total-bytes line appears above the list; each thumbnail renders via `/media/`.
2. Re-run the same feed (or aggregate a second feed sharing an image) — the image count does **not**
   grow. That is deduplication working.
3. Open an article and confirm the **Images** fieldset shows its referenced images.
4. `uv run python manage.py migrate_inline_images --dry-run` — reports article/image counts and the
   byte savings. Run it for real, then confirm no `Article.content` contains `data:image`:

```bash
uv run python manage.py shell -c "from core.models import Article; print(Article.objects.filter(content__contains='data:image').count())"
```

Expected: `0`.

5. `uv run python manage.py prune_orphaned_images --dry-run` — reports 0 orphans on a database whose
   images are all referenced.
6. Note the SQLite file size before and after the backfill; it should drop noticeably (run
   `uv run python manage.py optimize_sqlite --analyze` and `VACUUM` if you want the space returned).

- [ ] **Step 6: Commit**

```bash
git add README.md CLAUDE.md core/aggregators/README.md
git commit -m "docs(images): Document content-addressed image storage"
```

---

## Spec coverage map

| Spec section | Task |
|---|---|
| The model (`ArticleImage`, date-sharded `upload_to`) | 1 |
| Storage flow, hash over compressed bytes, `get_or_create` dedup, race safety | 2 |
| Reference format `yana-img://<hash>` | 2 (helpers), 3-5 (call sites) |
| `HeaderElementData.base64_data_uri` → `content_hash` | 3 |
| All five `base64_data_uri or image_url` call sites | 3 (four of them + Reddit's reload path), 4 (Reddit's own inliner) |
| Oglaf's `convert_to_base64`, its form field, its inline encoding, the options migration | 5 |
| `ENABLE_BASE64_ENCODING`, `import base64` in Oglaf | 5, 6 |
| Backfill (`migrate_inline_images`: batched, idempotent, `--dry-run`, `--limit`, decode failures) | 7 |
| Orphan pruning (`--dry-run`, `--min-age`, temporary text scan documented) | 8 |
| Missing file / present row reporting (`verify_image_store` check) | 8 |
| Error handling: fetch failure → no image; compression failure → original bytes; hash collision → hard error | 2 (store), 3 (callers) |
| Admin registration, thumbnail list, filter/search, read-only, byte-size total, per-article references | 9 |
| Testing checklist (model/storage, five call sites via a shared helper, Oglaf, backfill, pruning) | 1-9 |
| Verification via admin (steps 1-8) | 10 |
| Serving over HTTP, auth, feed-logo migration, thumbnails, S3, response size caps | Out of scope (spec) |
