"""
Domain image overrides.

Maps URL prefixes to preferred image URLs. When an article URL matches one of
the registered prefixes, the configured image URL is used instead of running
the normal image extraction strategies.

This is useful when a site's automatic image extraction picks up an undesirable
asset (e.g. an animated GIF, a placeholder, or a low-quality thumbnail) and we
would rather fall back to a stable brand image.

The mapping is keyed by URL prefix; when multiple prefixes match the longest
one wins, so more specific paths can override broader domain entries.
"""

from typing import Optional

# Mapping of URL prefixes to the image URL that should be used as the article's
# header/icon image. Prefix matching uses ``str.startswith``; longest match wins.
DOMAIN_IMAGE_OVERRIDES: dict[str, str] = {
    "https://en-americas-support.nintendo.com/": (
        "https://upload.wikimedia.org/wikipedia/commons/0/0d/Nintendo.svg"
    ),
}


def get_override_image_url(url: Optional[str]) -> Optional[str]:
    """
    Return an override image URL for the given article URL, if any.

    Args:
        url: The article URL to look up.

    Returns:
        The override image URL when ``url`` starts with one of the registered
        prefixes, otherwise ``None``. When several prefixes match, the longest
        prefix wins.
    """
    if not url:
        return None

    longest_match: Optional[str] = None
    longest_length = 0
    for prefix, image_url in DOMAIN_IMAGE_OVERRIDES.items():
        if url.startswith(prefix) and len(prefix) > longest_length:
            longest_match = image_url
            longest_length = len(prefix)

    return longest_match
