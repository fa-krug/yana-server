"""
Image extraction and compression service.

Provides functionality for:
- Extracting images from various sources (URLs, meta tags, pages)
- Compressing images
- HTTP image fetching with validation
"""

from .compression import compress_image
from .fetcher import fetch_single_image

__all__ = [
    "fetch_single_image",
    "compress_image",
]
