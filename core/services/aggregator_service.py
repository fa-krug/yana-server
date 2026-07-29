"""Service for triggering and managing feed aggregators."""

import logging
from typing import Any, Dict, List, Optional

from django.core.exceptions import ObjectDoesNotExist
from django.utils import timezone
from django.utils.text import slugify

from django_q.tasks import async_task

from ..aggregators import get_aggregator
from ..aggregators.services.header_element.file_handler import HeaderElementFileHandler
from ..models import Article, Feed

logger = logging.getLogger(__name__)


class AggregatorService:
    """Service for managing and triggering aggregators."""

    @staticmethod
    def trigger_by_feed_id(feed_id: int, force_update: bool = False) -> Dict[str, Any]:
        """
        Trigger aggregator for a specific feed by its ID.

        Args:
            feed_id: The ID of the feed to aggregate
            force_update: Whether to update existing articles

        Returns:
            Dictionary with:
                - success: Boolean indicating if aggregation succeeded
                - feed_id: The feed ID
                - feed_name: The feed name
                - aggregator_type: The aggregator type used
                - articles_count: Number of articles aggregated
                - error: Error message if failed (optional)

        Raises:
            ObjectDoesNotExist: If feed with given ID doesn't exist
        """
        try:
            # Get the feed
            feed = Feed.objects.get(id=feed_id)

            # Check if feed is enabled
            if not feed.enabled:
                return {
                    "success": False,
                    "feed_id": feed_id,
                    "feed_name": feed.name,
                    "aggregator_type": feed.aggregator,
                    "articles_count": 0,
                    "error": "Feed is disabled",
                }

            # Get the aggregator
            aggregator = get_aggregator(feed)

            # Trigger aggregation
            print(f"\n{'=' * 60}")
            print(f"Triggering aggregator for feed ID: {feed_id}")
            print(f"{'=' * 60}")

            articles_data = aggregator.aggregate()

            # Save articles to database
            created_count = 0
            updated_count = 0
            for article_data in articles_data:
                try:
                    # Get or create article by identifier
                    article = Article.objects.filter(
                        feed=feed, identifier=article_data["identifier"]
                    ).first()

                    if article:
                        # Update existing article only if force_update is True
                        if force_update:
                            updated = False
                            if article.name != article_data.get("name", ""):
                                article.name = article_data.get("name", "")
                                updated = True
                            if article.raw_content != article_data.get("raw_content", ""):
                                article.raw_content = article_data.get("raw_content", "")
                                updated = True
                            if article.content != article_data.get("content", ""):
                                article.content = article_data.get("content", "")
                                updated = True
                            if article.author != article_data.get("author", ""):
                                article.author = article_data.get("author", "")
                                updated = True

                            if updated:
                                article.save()
                                updated_count += 1
                    else:
                        # Create new article
                        article = Article.objects.create(
                            feed=feed,
                            identifier=article_data["identifier"],
                            name=article_data.get("name", ""),
                            raw_content=article_data.get("raw_content", ""),
                            content=article_data.get("content", ""),
                            date=article_data.get("date") or timezone.now(),
                            author=article_data.get("author", ""),
                        )
                        created_count += 1

                        # Handle header image if present
                        header_data = article_data.get("header_data")
                        if header_data:
                            HeaderElementFileHandler.save_image_to_article(
                                article, header_data.image_bytes, header_data.content_type
                            )
                except Exception as e:
                    print(f"Warning: Failed to save article: {e}")

            print(f"{'=' * 60}")
            print("Aggregation completed successfully")
            print(f"Created {created_count} new articles")
            print(f"Updated {updated_count} articles")
            print(f"{'=' * 60}\n")

            return {
                "success": True,
                "feed_id": feed_id,
                "feed_name": feed.name,
                "aggregator_type": feed.aggregator,
                "articles_count": created_count + updated_count,
            }

        except ObjectDoesNotExist as e:
            raise ObjectDoesNotExist(f"Feed with ID {feed_id} does not exist") from e
        except Exception as e:
            return {
                "success": False,
                "feed_id": feed_id,
                "feed_name": feed.name if "feed" in locals() else "Unknown",
                "aggregator_type": feed.aggregator if "feed" in locals() else "Unknown",
                "articles_count": 0,
                "error": str(e),
            }

    @staticmethod
    def trigger_by_aggregator_type(
        aggregator_type: str,
        limit: Optional[int] = None,
        force_update: bool = False,
        sync: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Trigger all feeds of a specific aggregator type.

        Args:
            aggregator_type: The aggregator type (e.g., 'youtube', 'reddit')
            limit: Optional limit on number of feeds to process
            force_update: Whether to update existing articles
            sync: If True, process feeds synchronously. If False (default),
                  spawn individual async tasks to prevent timeouts.

        Returns:
            If sync=True: List of result dictionaries from trigger_by_feed_id
            If sync=False: List of dictionaries with feed_id and task_id for each spawned task
        """
        feeds = Feed.objects.filter(aggregator=aggregator_type, enabled=True)

        if limit:
            feeds = feeds[:limit]

        results = []
        for feed in feeds:
            if sync:
                result = AggregatorService.trigger_by_feed_id(feed.id, force_update=force_update)
                results.append(result)
            else:
                task_id = async_task(
                    "core.services.aggregator_service.AggregatorService.trigger_by_feed_id",
                    feed.id,
                    force_update=force_update,
                    task_name=f"aggregate_feed_{slugify(feed.name).replace('-', '_')}",
                )
                logger.info(f"Spawned aggregation task for feed {feed.id} ({feed.name}): {task_id}")
                results.append(
                    {
                        "feed_id": feed.id,
                        "feed_name": feed.name,
                        "task_id": task_id,
                        "status": "queued",
                    }
                )

        return results

    @staticmethod
    def trigger_all(
        limit: Optional[int] = None,
        force_update: bool = False,
        sync: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Trigger all enabled feeds.

        Args:
            limit: Optional limit on number of feeds to process
            force_update: Whether to update existing articles
            sync: If True, process feeds synchronously. If False (default),
                  spawn individual async tasks to prevent timeouts when
                  processing many feeds or feeds with slow operations.

        Returns:
            If sync=True: List of result dictionaries from trigger_by_feed_id
            If sync=False: List of dictionaries with feed_id and task_id for each spawned task
        """
        feeds = Feed.objects.filter(enabled=True)

        if limit:
            feeds = feeds[:limit]

        results = []
        for feed in feeds:
            if sync:
                result = AggregatorService.trigger_by_feed_id(feed.id, force_update=force_update)
                results.append(result)
            else:
                task_id = async_task(
                    "core.services.aggregator_service.AggregatorService.trigger_by_feed_id",
                    feed.id,
                    force_update=force_update,
                    task_name=f"aggregate_feed_{slugify(feed.name).replace('-', '_')}",
                )
                logger.info(f"Spawned aggregation task for feed {feed.id} ({feed.name}): {task_id}")
                results.append(
                    {
                        "feed_id": feed.id,
                        "feed_name": feed.name,
                        "task_id": task_id,
                        "status": "queued",
                    }
                )

        if not sync:
            logger.info(f"Queued {len(results)} feed aggregation tasks")
        return results
