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
