"""
File storage handler for header element images.

Handles saving raw image bytes to Django ImageField.
"""

import logging
import uuid

from django.core.files.base import ContentFile

from core.models import Article

logger = logging.getLogger(__name__)


class HeaderElementFileHandler:
    """Handles saving header element images to Article models."""

    @staticmethod
    def save_image_to_article(article: Article, image_bytes: bytes, content_type: str) -> bool:
        """
        Save image bytes to Article.icon ImageField.

        Args:
            article: Article instance
            image_bytes: Raw image data
            content_type: MIME type

        Returns:
            True if successful, False otherwise
        """
        if not image_bytes:
            return False

        try:
            # Generate a unique filename
            extension = content_type.split("/")[-1]
            if extension == "jpeg":
                extension = "jpg"
            elif "icon" in extension or "vnd.microsoft.icon" in content_type:
                extension = "ico"

            # Sanitize extension (limit length and remove weird chars)
            extension = "".join(c for c in extension if c.isalnum())[:4]
            if not extension:
                extension = "jpg"

            filename = f"{uuid.uuid4()}.{extension}"

            # Save to ImageField
            # This handles file storage and updating the database field
            article.icon.save(filename, ContentFile(image_bytes), save=True)

            logger.debug(f"Successfully saved header image to article {article.id}: {filename}")
            return True

        except Exception as e:
            logger.error(f"Failed to save header image to article {article.id}: {e}")
            return False
