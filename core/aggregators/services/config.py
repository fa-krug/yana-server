"""
Configuration for aggregator services.

Centralized configuration for image compression, HTTP requests, and external APIs.
Settings can be overridden via Django settings (YANA_* variables).
"""

from django.conf import settings

# ==================== Image Compression Settings ====================

# Standard image dimensions (for article images)
MAX_IMAGE_WIDTH = getattr(settings, "YANA_MAX_IMAGE_WIDTH", 600)
MAX_IMAGE_HEIGHT = getattr(settings, "YANA_MAX_IMAGE_HEIGHT", 600)

# Header image dimensions (larger for more prominent display)
MAX_HEADER_IMAGE_WIDTH = getattr(settings, "YANA_MAX_HEADER_IMAGE_WIDTH", 1200)
MAX_HEADER_IMAGE_HEIGHT = getattr(settings, "YANA_MAX_HEADER_IMAGE_HEIGHT", 1200)

# Image compression quality (1-100, lower is more compressed)
JPEG_QUALITY = getattr(settings, "YANA_JPEG_QUALITY", 65)
WEBP_QUALITY = getattr(settings, "YANA_WEBP_QUALITY", 65)

# Prefer WebP format when available (better compression than JPEG)
PREFER_WEBP = getattr(settings, "YANA_PREFER_WEBP", True)

# Minimum file size to attempt compression (smaller images left as-is)
MIN_IMAGE_SIZE_FOR_COMPRESSION = 5000  # 5KB

# ==================== HTTP Settings ====================

# Request timeout in seconds
HTTP_TIMEOUT = getattr(settings, "YANA_HTTP_TIMEOUT", 10)

# User-Agent header for HTTP requests
USER_AGENT = getattr(
    settings,
    "YANA_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
)

# ==================== External API Endpoints ====================

# fxtwitter API for Twitter/X image extraction
FXTWITTER_API_BASE = getattr(settings, "YANA_FXTWITTER_API_BASE", "https://api.fxtwitter.com")

# Reddit API endpoint
REDDIT_API_BASE = getattr(settings, "YANA_REDDIT_API_BASE", "https://www.reddit.com")

# YouTube thumbnail base URL
YOUTUBE_THUMBNAIL_BASE = getattr(
    settings, "YANA_YOUTUBE_THUMBNAIL_BASE", "https://img.youtube.com/vi"
)

# ==================== Feature Flags ====================

# Enable header element extraction
ENABLE_HEADER_EXTRACTION = getattr(settings, "YANA_ENABLE_HEADER_EXTRACTION", True)

# Enable image compression
ENABLE_IMAGE_COMPRESSION = getattr(settings, "YANA_ENABLE_IMAGE_COMPRESSION", True)
