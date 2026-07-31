"""
Header element extraction service.

Provides functionality for extracting header elements (HTML iframes or hosted images,
referenced as ``yana-img://<hash>``) from various sources using Strategy pattern.
"""

from .context import HeaderElementContext
from .extractor import HeaderElementExtractor

__all__ = ["HeaderElementExtractor", "HeaderElementContext"]
