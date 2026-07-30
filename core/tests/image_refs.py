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
