"""Service for reloading and managing article content."""

from typing import Any, Dict

from django.core.exceptions import ObjectDoesNotExist

from ..aggregators import get_aggregator
from ..aggregators.services.header_element.file_handler import HeaderElementFileHandler
from ..models import Article


class ArticleService:
    """Service for managing and reloading articles."""

    @staticmethod
    def reload_article(article_id: int) -> Dict[str, Any]:
        """
        Reload a single article by re-fetching and re-processing its content.

        This method:
        1. Fetches the article and its feed
        2. Gets the appropriate aggregator
        3. Re-fetches the article content from the URL
        4. Updates the article with new content

        Args:
            article_id: The ID of the article to reload

        Returns:
            Dictionary with:
                - success: Boolean indicating if reload succeeded
                - article_id: The article ID
                - article_name: The article name
                - feed_name: The feed name
                - aggregator_type: The aggregator type used
                - error: Error message if failed (optional)

        Raises:
            ObjectDoesNotExist: If article with given ID doesn't exist
        """
        try:
            # Get the article
            article = Article.objects.select_related("feed").get(id=article_id)
            feed = article.feed

            # Check if feed is enabled
            if not feed.enabled:
                return {
                    "success": False,
                    "article_id": article_id,
                    "article_name": article.name,
                    "feed_name": feed.name,
                    "aggregator_type": feed.aggregator,
                    "error": "Feed is disabled",
                }

            # Get the aggregator
            aggregator = get_aggregator(feed)
            agg_type = feed.aggregator

            # Re-fetch and process the article
            print(f"\n{'=' * 60}")
            print(f"Reloading article ID: {article_id} ({agg_type})")
            print(f"Article: {article.name}")
            print(f"URL: {article.identifier}")
            print(f"{'=' * 60}")

            # Force reload the specific article by re-fetching its content
            url = article.identifier

            # Build article dict for aggregator methods
            article_dict = {
                "name": article.name,
                "identifier": url,
                "author": article.author,
                "date": article.created_at,
            }

            # Use the same extraction pipeline as background aggregation
            try:
                # Extract header element (image/video) - same as background job
                header_data = aggregator.extract_header_element(article_dict)
                if header_data:
                    # Save image to ImageField
                    HeaderElementFileHandler.save_image_to_article(
                        article, header_data.image_bytes, header_data.content_type
                    )
                    # Store in dict for content processing (prepending)
                    article_dict["header_data"] = header_data
            except Exception as e:
                # Log but don't fail on header extraction errors
                print(f"Warning: Failed to extract header element: {e}")

            # Fetch and process the article content
            raw_html = aggregator.fetch_article_content(url)
            extracted_content = aggregator.extract_content(raw_html, article_dict)
            processed_content = aggregator.process_content(extracted_content, article_dict)

            # Update the article with fresh content
            article.raw_content = raw_html
            article.content = processed_content
            article.save(update_fields=["raw_content", "content", "icon"])

            print(f"{'=' * 60}")
            print("Article reloaded successfully")
            print(f"Raw content: {len(raw_html)} bytes")
            print(f"Processed content: {len(processed_content)} bytes")
            print(f"{'=' * 60}\n")

            return {
                "success": True,
                "article_id": article_id,
                "article_name": article.name,
                "feed_name": feed.name,
                "aggregator_type": feed.aggregator,
                "message": f"Article reloaded ({len(raw_html)} bytes fetched, {len(processed_content)} bytes processed)",
                "fetch_size": len(raw_html),
                "process_size": len(processed_content),
            }

        except ObjectDoesNotExist as e:
            raise ObjectDoesNotExist(f"Article with ID {article_id} does not exist") from e
        except Exception as e:
            return {
                "success": False,
                "article_id": article_id,
                "article_name": article.name if "article" in locals() else "Unknown",
                "feed_name": feed.name if "feed" in locals() else "Unknown",
                "aggregator_type": feed.aggregator if "feed" in locals() else "Unknown",
                "error": str(e),
            }

    @staticmethod
    def delete_old_articles(months: int = 2) -> int:
        """
        Delete articles older than the specified number of months.

        Args:
            months: Number of months to keep articles for (default: 2)

        Returns:
            Number of deleted articles
        """
        from datetime import timedelta

        from django.utils import timezone

        # Calculate the cutoff date
        cutoff_date = timezone.now() - timedelta(days=months * 30)

        # Delete articles older than the cutoff date, based on when the article
        # was imported (created_at), not its publish date (date). Article.date
        # is the feed's real publish time, so a just-imported article with an
        # old publish date must not be deleted on the very next cleanup run --
        # created_at is the append-only, import-time signal retention needs.
        # We preserve starred articles as they are explicitly saved by the user
        count, _ = Article.objects.filter(created_at__lt=cutoff_date, starred=False).delete()

        return count
