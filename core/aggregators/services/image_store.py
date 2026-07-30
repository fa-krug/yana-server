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
        # A blank file name (however that happened) must never reach
        # storage.save(""), which raises SuspiciousFileOperation -- the old
        # code simply returned the hash in that case, so preserve that by
        # only attempting repair when there is a name to check and rewrite.
        file_name = existing.file.name if existing.file else ""
        if file_name and not existing.file.storage.exists(file_name):
            # A restored DB backup without media/, or a manually cleared
            # directory, leaves rows whose file is gone. Returning early here
            # (the old behavior) is self-perpetuating: every later encounter
            # finds the row and writes nothing, so the reference 404s forever
            # and the reaper's "missing file" report never leads to repair.
            # Rewrite the file in place instead, keeping the same hash.
            logger.warning(
                "[image_store] %s row exists but its file is missing on disk -- rewriting it",
                content_hash[:12],
            )
            saved_name = existing.file.storage.save(file_name, ContentFile(data))
            if saved_name != file_name:
                # Another writer recreated the file between our exists()
                # check and this save, so storage disambiguated with a
                # suffixed name instead of overwriting. That stray file is
                # referenced by no row and the reaper would never reclaim
                # it -- drop it and trust whatever now sits at the hash's
                # real, DB-recorded path.
                existing.file.storage.delete(saved_name)
        else:
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

    return store_image_bytes(fetched["imageData"], fetched["contentType"], is_header=is_header)


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
            "[image_store] Compression failed for a %s image (%d B) -- storing the original bytes",
            content_type,
            len(image_bytes),
        )
        return image_bytes, content_type, None, None

    return result["data"], result["contentType"], result["width"], result["height"]
