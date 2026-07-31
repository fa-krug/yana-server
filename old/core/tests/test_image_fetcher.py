"""Tests for HTTP image fetching -- content negotiation and content-type validation.

Covers the AVIF over-negotiation defect: the `Accept` header used to advertise
`image/avif` while `ACCEPTED_IMAGE_TYPES` had no AVIF entry (Pillow 11.0, this
project's pinned version, cannot decode AVIF at all), so a compliant server
would send AVIF and we would then reject every single one of those bytes.

Also covers `fetch_image_outcome`'s three-way split (definitive non-image vs.
transient failure vs. success) -- the fix for a VG Wort tracking-pixel URL
that resolves (after a redirect) to a zero-length `text/html` response: the
old two-way `fetch_single_image` contract collapsed that into a bare `None`,
indistinguishable from a timeout, so the caller kept the dead remote ref
forever instead of dropping it.
"""

import io
from unittest.mock import Mock, patch

import requests
from PIL import Image

from core.aggregators.services.image_extraction.fetcher import (
    ACCEPTED_IMAGE_TYPES,
    NonImageResponse,
    fetch_image_outcome,
    fetch_single_image,
    get_image_headers,
    is_image_content_type,
)


def _real_png(size: tuple[int, int] = (50, 50)) -> bytes:
    img = Image.new("RGB", size, (10, 20, 30))
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()


def _mock_response(*, content_type: str, content: bytes) -> Mock:
    response = Mock()
    response.raise_for_status = Mock()
    response.headers = {"Content-Type": content_type}
    response.content = content
    return response


def _mock_http_error_response(status_code: int) -> Mock:
    error = requests.exceptions.HTTPError()
    error.response = Mock(status_code=status_code)
    response = Mock()
    response.raise_for_status = Mock(side_effect=error)
    return response


def _advertised_concrete_types(accept_header: str) -> list[str]:
    """Every exact MIME type in an `Accept` header, wildcards excluded.

    `image/*` and `*/*;q=0.8` are not real `Content-Type` values a server
    could ever send back -- only the concrete entries are a promise we must
    be able to keep.
    """
    types = [entry.split(";")[0].strip() for entry in accept_header.split(",")]
    return [t for t in types if "*" not in t]


class TestAcceptHeaderNegotiation:
    def test_every_advertised_concrete_type_is_in_the_allowlist(self):
        """The property that actually prevents recurrence: whatever we ask
        for in `Accept`, `is_image_content_type` must be willing to accept
        back. Derived from both module constants -- not a hardcoded literal
        -- so the two cannot silently drift apart again."""
        concrete = _advertised_concrete_types(get_image_headers()["Accept"])

        assert concrete, "expected at least one concrete type in the Accept header"
        for mime_type in concrete:
            assert mime_type in ACCEPTED_IMAGE_TYPES

    def test_avif_is_not_advertised(self):
        """Pillow 11.0 has no AVIF decoder -- asking for it just means
        throwing away whatever the server sends."""
        assert "image/avif" not in _advertised_concrete_types(get_image_headers()["Accept"])

    def test_avif_is_not_in_the_allowlist(self):
        assert "image/avif" not in ACCEPTED_IMAGE_TYPES

    def test_apng_is_advertised_and_accepted(self):
        """Unlike AVIF, Pillow decodes APNG fine (via the ordinary PNG
        decoder), so it stays in both the header and the allowlist."""
        assert "image/apng" in _advertised_concrete_types(get_image_headers()["Accept"])
        assert is_image_content_type("image/apng")


class TestAvifResponseIsRejectedGracefully:
    def test_an_avif_response_is_rejected_without_raising_or_storing(self):
        """If a server ignores our `Accept` header and sends AVIF anyway,
        that must be rejected the same way any other undecodable response
        is: logged, no exception, nothing returned for the caller to store."""
        response = Mock()
        response.raise_for_status = Mock()
        response.headers = {"Content-Type": "image/avif"}
        response.content = b"\x00" * 500

        with patch("requests.get", return_value=response):
            result = fetch_single_image("https://example.com/photo.avif")

        assert result is None

    def test_is_image_content_type_rejects_avif(self):
        assert is_image_content_type("image/avif") is False


class TestFetchImageOutcomeDistinguishesDefinitiveFromTransient:
    """`fetch_image_outcome` widens `fetch_single_image`'s bare `None` into
    three outcomes: a `dict` (success), `NonImageResponse` (definitive --
    we got a response and it is conclusively not a usable image), or `None`
    (transient -- might succeed on retry)."""

    def test_a_redirected_empty_text_html_response_is_non_image(self):
        """The real VG Wort shape: a 302 that `requests` follows (we pass
        `allow_redirects=True`) to a final 200 serving `text/html` with a
        zero-length body."""
        response = _mock_response(content_type="text/html", content=b"")

        with patch("requests.get", return_value=response):
            result = fetch_image_outcome("https://vg08.met.vgwort.de/na/beacon")

        assert isinstance(result, NonImageResponse)

    def test_a_200_with_html_content_type_is_non_image(self):
        response = _mock_response(content_type="text/html", content=b"<html>oops</html>" * 10)

        with patch("requests.get", return_value=response):
            result = fetch_image_outcome("https://example.com/not-an-image")

        assert isinstance(result, NonImageResponse)

    def test_a_200_image_content_type_with_undecodable_bytes_is_non_image(self):
        """The server claims an image type, but the bytes are garbage --
        this is only detectable by actually trying to decode them."""
        garbage = b"not really a png, just padding to clear the size floor" * 3
        response = _mock_response(content_type="image/png", content=garbage)

        with patch("requests.get", return_value=response):
            result = fetch_image_outcome("https://example.com/corrupt.png")

        assert isinstance(result, NonImageResponse)

    def test_a_timeout_is_transient_and_returns_none(self):
        with patch("requests.get", side_effect=requests.exceptions.Timeout()):
            result = fetch_image_outcome("https://example.com/slow.png")

        assert result is None

    def test_a_503_is_transient_and_returns_none(self):
        response = _mock_http_error_response(503)

        with patch("requests.get", return_value=response):
            result = fetch_image_outcome("https://example.com/unavailable.png")

        assert result is None

    def test_a_normal_image_is_still_fetched_successfully(self):
        data = _real_png()
        response = _mock_response(content_type="image/png", content=data)

        with patch("requests.get", return_value=response):
            result = fetch_image_outcome("https://example.com/real.png")

        assert result == {"imageData": data, "contentType": "image/png"}

    def test_fetch_single_image_collapses_non_image_to_none(self):
        """The old, still-public two-way contract every existing caller
        (header images, extraction strategies) relies on is unaffected --
        a definitive non-image rejection looks exactly like any other
        failure to them."""
        response = _mock_response(content_type="text/html", content=b"")

        with patch("requests.get", return_value=response):
            result = fetch_single_image("https://vg08.met.vgwort.de/na/beacon")

        assert result is None
