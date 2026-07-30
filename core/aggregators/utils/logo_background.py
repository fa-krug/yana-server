"""Remove a logo's white background.

Ports the iOS client's ``LogoBackgroundRemover`` from CoreGraphics to Pillow.
The thresholds are deliberately identical to the client's so the two agree on
which logos get a transparent background while both implementations coexist.
"""

import io
import logging
from collections import deque
from collections.abc import Iterator
from typing import Any

from PIL import Image

logger = logging.getLogger(__name__)

# iOS: whiteThreshold = 240, borderWhiteFraction = 0.85. Keep in sync.
WHITE_THRESHOLD = 240
BORDER_WHITE_FRACTION = 0.85

# The flood fill walks pixels in pure Python, so its cost is O(pixels): a
# 4000x4000 image costs ~25 s of CPU for a response of a few dozen KB, which any
# site we fetch an icon from could hand us. Above the budget the removal is
# *skipped* (the caller keeps the original bytes) rather than downscaled: a logo
# is displayed at icon size, an image this large is not a favicon in the first
# place, and skipping keeps the stored bytes exactly what the site served
# instead of a resampled approximation. 512x512 is the largest size real sites
# declare for an icon or apple-touch-icon.
MAX_FILL_PIXELS = 512 * 512


def _is_white(pixel: tuple[int, ...]) -> bool:
    return all(channel >= WHITE_THRESHOLD for channel in pixel[:3])


def _border_coords(width: int, height: int) -> Iterator[tuple[int, int]]:
    for x in range(width):
        yield x, 0
        yield x, height - 1
    for y in range(1, height - 1):
        yield 0, y
        yield width - 1, y


def remove_white_background(data: bytes) -> bytes | None:
    """PNG bytes with border-connected white cleared, or ``None``.

    ``None`` means "not white-backed", "larger than ``MAX_FILL_PIXELS``", or
    "undecodable", and tells the caller to keep the original bytes untouched.
    White *enclosed* by the subject -- the lettering inside a dark circle --
    survives, because the fill only reaches white connected to the border.
    """
    try:
        with Image.open(io.BytesIO(data)) as opened:
            # Checked before convert(): decoding a huge image into RGBA is
            # itself the expensive part we are trying to avoid.
            width, height = opened.size
            if width < 2 or height < 2:
                return None
            if width * height > MAX_FILL_PIXELS:
                logger.info(
                    f"Skipping background removal for a {width}x{height} image: "
                    f"over the {MAX_FILL_PIXELS} pixel budget"
                )
                return None

            image = opened.convert("RGBA")
    except Exception as exc:
        logger.debug(f"Could not decode image for background removal: {exc}")
        return None

    pixels: Any = image.load()
    border = list(_border_coords(width, height))
    white_border = [(x, y) for x, y in border if _is_white(pixels[x, y])]
    if len(white_border) / len(border) < BORDER_WHITE_FRACTION:
        return None

    queue = deque(white_border)
    seen = set(white_border)
    while queue:
        x, y = queue.popleft()
        red, green, blue, _ = pixels[x, y]
        pixels[x, y] = (red, green, blue, 0)

        for next_x, next_y in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if not (0 <= next_x < width and 0 <= next_y < height):
                continue
            if (next_x, next_y) in seen or not _is_white(pixels[next_x, next_y]):
                continue
            seen.add((next_x, next_y))
            queue.append((next_x, next_y))

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()
