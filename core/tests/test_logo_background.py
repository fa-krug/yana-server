"""Tests for logo white-background removal."""

import io

from PIL import Image

from core.aggregators.utils.logo_background import remove_white_background


def _png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _white_backed_logo() -> Image.Image:
    """A dark ring on white, with a white hole enclosed by the ring."""
    image = Image.new("RGB", (40, 40), (255, 255, 255))
    for x in range(10, 30):
        for y in range(10, 30):
            image.putpixel((x, y), (20, 20, 20))
    for x in range(18, 22):
        for y in range(18, 22):
            image.putpixel((x, y), (255, 255, 255))
    return image


def _load(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data)).convert("RGBA")


def test_white_border_becomes_transparent():
    result = remove_white_background(_png_bytes(_white_backed_logo()))

    assert result is not None
    assert _load(result).getpixel((0, 0))[3] == 0


def test_enclosed_white_is_preserved():
    result = remove_white_background(_png_bytes(_white_backed_logo()))

    assert result is not None
    image = _load(result)
    assert image.getpixel((20, 20))[3] == 255
    assert image.getpixel((20, 20))[:3] == (255, 255, 255)


def test_subject_pixels_are_untouched():
    result = remove_white_background(_png_bytes(_white_backed_logo()))

    assert result is not None
    assert _load(result).getpixel((12, 12)) == (20, 20, 20, 255)


def test_busy_border_returns_none():
    image = Image.new("RGB", (40, 40), (30, 90, 160))
    assert remove_white_background(_png_bytes(image)) is None


def test_mostly_white_border_still_counts_as_white_backed():
    image = _white_backed_logo()
    for x in range(0, 4):
        image.putpixel((x, 0), (10, 10, 10))
    assert remove_white_background(_png_bytes(image)) is not None


def test_one_by_one_image_returns_none():
    image = Image.new("RGB", (1, 1), (255, 255, 255))
    assert remove_white_background(_png_bytes(image)) is None


def test_undecodable_bytes_return_none():
    assert remove_white_background(b"not an image") is None


def test_empty_bytes_return_none():
    assert remove_white_background(b"") is None
