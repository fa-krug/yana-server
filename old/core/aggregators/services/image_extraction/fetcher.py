"""
HTTP image fetching utilities.

Handles downloading images from URLs with proper:
- HTTP headers (User-Agent, Referer)
- MIME type detection and validation
- Timeout handling
- Error handling
"""

import logging
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import requests

logger = logging.getLogger(__name__)

# HTTP configuration
DEFAULT_TIMEOUT = 10
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

# Accepted image MIME types.
#
# Every concrete (non-wildcard) type advertised in the `Accept` header built by
# `get_image_headers` below must appear here -- otherwise we negotiate for a
# format and then throw away what the server sends. `image/avif` is
# deliberately absent: Pillow 11.0 (this project's pinned version) has no AVIF
# decoder (`PIL.features.check("avif")` is False, and "avif" is not even a
# recognized feature name), so accepting it would just mean storing bytes we
# can never decode. `image/apng` *is* here, unlike avif, because Pillow reads
# animated PNGs through the same PNG decoder as any other `.png` (confirmed:
# `Image.open` on APNG bytes succeeds and reports `format == "PNG"`) -- a
# server that labels its response `image/apng` is sending us something we can
# use, so there is no reason to reject it.
ACCEPTED_IMAGE_TYPES = {
    "image/jpeg",
    "image/png",
    "image/apng",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "image/bmp",
    "image/tiff",
}


def get_image_headers(url: str | None = None) -> Dict[str, str]:
    """
    Get HTTP headers for image fetching.

    Constructs headers with User-Agent and Referer.

    Args:
        url: Optional URL to extract referer from

    Returns:
        Dict of HTTP headers
    """
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "DNT": "1",
    }

    # Add referer header if URL provided
    if url:
        try:
            parsed = urlparse(url)
            referer = f"{parsed.scheme}://{parsed.netloc}"
            headers["Referer"] = referer
        except Exception:
            pass

    return headers


def is_image_content_type(content_type: Optional[str]) -> bool:
    """
    Check if content type is a valid image MIME type.

    Args:
        content_type: HTTP Content-Type header value

    Returns:
        True if valid image MIME type
    """
    if not content_type:
        return False

    # Extract base MIME type (without parameters like charset)
    base_type = content_type.split(";")[0].strip()

    return base_type in ACCEPTED_IMAGE_TYPES


class NonImageResponse:
    """Sentinel: the fetch completed and gave a *definitive* answer that the
    resource is not a usable image -- a non-image `Content-Type`, an
    empty/too-small body, or bytes Pillow cannot decode as an image at all.
    Retrying will not change any of these; the server (after following any
    redirect) told us plainly what this is.

    Distinct from the plain `None` `fetch_image_outcome` returns for every
    *transient* failure (a network/DNS error, a timeout, or an HTTP error
    status) -- those might succeed on a later attempt, so a caller that
    cares about the difference (currently only
    ``core.aggregators.services.image_store.store_body_image_ref_from_url``,
    for ``core.blocks.conversion``'s body-image localization pass) must not
    treat the two alike.

    Falsy, so ``fetch_single_image`` -- which collapses this back to `None`
    for its existing, unchanged public contract -- and every caller that
    only checks truthiness (every current caller of ``fetch_single_image``)
    sees exactly the same "no image" outcome it always has.
    """

    def __bool__(self) -> bool:
        return False

    def __repr__(self) -> str:
        return "NON_IMAGE_RESPONSE"


NON_IMAGE_RESPONSE = NonImageResponse()


def fetch_image_outcome(
    url: str, timeout: int = DEFAULT_TIMEOUT
) -> Optional[Dict[str, Any]] | NonImageResponse:
    """
    Fetch a single image from URL, distinguishing a definitive "this is not
    an image" answer from a merely transient failure.

    Handles:
    - HTTP fetching with proper headers
    - Content-type validation
    - Timeout handling
    - Size validation (must be > 100 bytes)
    - Decodability validation (Pillow must be able to open the bytes)

    Args:
        url: URL to fetch image from
        timeout: Request timeout in seconds

    Returns:
        - Dict with keys ``imageData`` (bytes) and ``contentType`` (str) on
          success.
        - ``NON_IMAGE_RESPONSE`` when the response is definitively not a
          usable image: wrong content-type, an empty/too-small body, or
          undecodable bytes.
        - ``None`` for a transient failure: a network/DNS error, a timeout,
          or an HTTP error status -- any of which might succeed later.
    """
    if not url:
        logger.warning("Empty URL provided to fetch_single_image")
        return None

    try:
        logger.debug(f"Fetching image from {url}")

        headers = get_image_headers(url)
        response = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)

        # An HTTP error status (after following any redirect) is transient --
        # a 503 or a rate-limited 429 may well succeed on retry, and we have
        # no usable body to judge either way.
        try:
            response.raise_for_status()
        except requests.exceptions.HTTPError as e:
            logger.warning(f"HTTP {e.response.status_code} fetching {url}")
            return None

        # Validate content type -- a non-2xx-but-successful response (e.g. a
        # redirect that resolved to a `text/html` error page, the VG Wort
        # tracking-pixel shape) is a definitive answer, not a retry candidate.
        content_type = response.headers.get("Content-Type", "")
        if not is_image_content_type(content_type):
            logger.warning(f"Invalid content type for image: {content_type}")
            return NON_IMAGE_RESPONSE

        # Validate content length
        image_data = response.content
        if len(image_data) < 100:  # Minimum 100 bytes
            logger.debug(f"Image too small ({len(image_data)} bytes): {url}")
            return NON_IMAGE_RESPONSE

        # The content-type header is only a claim -- confirm the bytes
        # actually decode as an image before trusting it.
        if validate_image_data_with_pillow(image_data) is None:
            logger.debug(f"Undecodable image bytes ({content_type}): {url}")
            return NON_IMAGE_RESPONSE

        logger.debug(f"Successfully fetched image ({len(image_data)} bytes): {url}")
        return {
            "imageData": image_data,
            "contentType": content_type.split(";")[0].strip(),
        }

    except requests.exceptions.Timeout:
        logger.warning(f"Timeout fetching image: {url}")
        return None
    except requests.exceptions.ConnectionError:
        logger.warning(f"Connection error fetching image: {url}")
        return None
    except requests.exceptions.RequestException as e:
        logger.warning(f"Error fetching image: {e}")
        return None
    except Exception as e:
        logger.error(f"Unexpected error fetching image {url}: {e}")
        return None


def fetch_single_image(url: str, timeout: int = DEFAULT_TIMEOUT) -> Optional[Dict[str, Any]]:
    """
    Fetch a single image from URL with validation.

    Thin wrapper over ``fetch_image_outcome`` that collapses its
    ``NON_IMAGE_RESPONSE`` sentinel back into plain ``None`` -- the original,
    unchanged two-way contract every current caller (header-image
    extraction, the direct/YouTube/Twitter/meta-tag/page-image strategies)
    relies on, none of which need to (or should have to) tell a definitive
    rejection apart from a transient one.

    Returns:
        Dict with keys ``imageData``/``contentType`` on success, ``None``
        if the fetch fails for any reason (transient or definitive).
    """
    result = fetch_image_outcome(url, timeout)
    return result if isinstance(result, dict) else None


def validate_image_data_with_pillow(image_data: bytes) -> Optional[Dict[str, Any]]:
    """
    Validate image data using Pillow and extract metadata.

    Args:
        image_data: Raw image bytes

    Returns:
        Dict with image metadata if valid, None otherwise
    """
    try:
        import io

        from PIL import Image

        img = Image.open(io.BytesIO(image_data))
        # Try to load image to verify it's valid
        img.load()

        return {
            "width": img.width,
            "height": img.height,
            "format": img.format or "unknown",
        }
    except Exception as e:
        logger.debug(f"Pillow validation failed: {e}")
        return None
