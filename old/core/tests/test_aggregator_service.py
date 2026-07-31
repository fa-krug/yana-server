from unittest.mock import MagicMock, patch

from django.core.exceptions import ObjectDoesNotExist

import pytest

from core.models import Article
from core.services.aggregator_service import AggregatorService


@pytest.mark.django_db
class TestAggregatorService:
    @patch("core.services.aggregator_service.get_aggregator")
    def test_trigger_by_feed_id_success(self, mock_get_agg, rss_feed):
        # Setup mock aggregator
        mock_aggregator = MagicMock()
        mock_aggregator.aggregate.return_value = [
            {
                "name": "New Article",
                "identifier": "https://example.com/new",
                "raw_content": "raw",
                "content": "clean",
                "author": "Author",
            }
        ]
        mock_get_agg.return_value = mock_aggregator

        # Act
        result = AggregatorService.trigger_by_feed_id(rss_feed.id)

        # Assert
        assert result["success"] is True
        assert result["articles_count"] == 1
        assert Article.objects.filter(feed=rss_feed, identifier="https://example.com/new").exists()

    def test_trigger_by_feed_id_disabled(self, rss_feed):
        rss_feed.enabled = False
        rss_feed.save()

        result = AggregatorService.trigger_by_feed_id(rss_feed.id)

        assert result["success"] is False
        assert result["error"] == "Feed is disabled"
        assert result["articles_count"] == 0

    def test_trigger_by_feed_id_not_found(self):
        with pytest.raises(ObjectDoesNotExist):
            AggregatorService.trigger_by_feed_id(9999)

    @patch("core.services.aggregator_service.get_aggregator")
    def test_trigger_by_feed_id_no_update_default(self, mock_get_agg, rss_feed, article):
        """Test that existing articles are NOT updated by default."""
        original_content = article.content

        # Setup mock aggregator to return existing article with updated content
        mock_aggregator = MagicMock()
        mock_aggregator.aggregate.return_value = [
            {
                "name": article.name,
                "identifier": article.identifier,
                "raw_content": "different raw",
                "content": "different clean",
            }
        ]
        mock_get_agg.return_value = mock_aggregator

        # Act
        result = AggregatorService.trigger_by_feed_id(rss_feed.id)

        # Assert
        assert result["success"] is True
        assert result["articles_count"] == 0  # Should NOT count as processed
        assert Article.objects.filter(feed=rss_feed).count() == 1

        # Verify NO update
        article.refresh_from_db()
        assert article.content == original_content

    @patch("core.services.aggregator_service.get_aggregator")
    def test_trigger_by_feed_id_force_update(self, mock_get_agg, rss_feed, article):
        """Test that existing articles ARE updated when force_update=True."""
        # Setup mock aggregator to return existing article with updated content
        mock_aggregator = MagicMock()
        mock_aggregator.aggregate.return_value = [
            {
                "name": article.name,
                "identifier": article.identifier,
                "raw_content": "different raw",
                "content": "different clean",
            }
        ]
        mock_get_agg.return_value = mock_aggregator

        # Act
        result = AggregatorService.trigger_by_feed_id(rss_feed.id, force_update=True)

        # Assert
        assert result["success"] is True
        assert result["articles_count"] == 1  # Should count as processed (updated)
        assert Article.objects.filter(feed=rss_feed).count() == 1

        # Verify update
        article.refresh_from_db()
        assert article.content == "different clean"
        assert article.raw_content == "different raw"

    @patch("core.services.aggregator_service.get_aggregator")
    @patch("core.services.aggregator_service.HeaderElementFileHandler.save_image_to_article")
    def test_trigger_by_feed_id_with_header_image(self, mock_save_img, mock_get_agg, rss_feed):
        mock_header_data = MagicMock()
        mock_header_data.image_bytes = b"fake_image"
        mock_header_data.content_type = "image/jpeg"

        mock_aggregator = MagicMock()
        mock_aggregator.aggregate.return_value = [
            {"name": "Article with Image", "identifier": "img-1", "header_data": mock_header_data}
        ]
        mock_get_agg.return_value = mock_aggregator

        AggregatorService.trigger_by_feed_id(rss_feed.id)

        assert mock_save_img.called
        args, kwargs = mock_save_img.call_args
        assert args[1] == b"fake_image"
        assert args[2] == "image/jpeg"

    @patch("core.services.aggregator_service.get_aggregator")
    @patch("core.services.aggregator_service.HeaderElementFileHandler.save_image_to_article")
    def test_trigger_by_feed_id_force_update_backfills_header_image(
        self, mock_save_img, mock_get_agg, rss_feed, article
    ):
        """An existing article's header image must be persisted too, not only a new one's."""
        mock_header_data = MagicMock()
        mock_header_data.image_bytes = b"fresh-bytes"
        mock_header_data.content_type = "image/jpeg"

        mock_aggregator = MagicMock()
        mock_aggregator.aggregate.return_value = [
            {
                "name": article.name,
                "identifier": article.identifier,
                "raw_content": article.raw_content,
                "content": article.content,
                "header_data": mock_header_data,
            }
        ]
        mock_get_agg.return_value = mock_aggregator

        result = AggregatorService.trigger_by_feed_id(rss_feed.id, force_update=True)

        assert result["articles_count"] == 1
        mock_save_img.assert_called_once()
        args, kwargs = mock_save_img.call_args
        assert args[0] == article
        assert args[1] == b"fresh-bytes"
        assert args[2] == "image/jpeg"

    @patch("core.services.aggregator_service.get_aggregator")
    @patch("core.services.aggregator_service.HeaderElementFileHandler.save_image_to_article")
    def test_trigger_by_feed_id_force_update_no_header_data_keeps_existing_icon(
        self, mock_save_img, mock_get_agg, rss_feed, article
    ):
        """Extraction returning no header this run must not clear an already-set icon."""
        article.icon = "article_icons/existing.jpg"
        article.save()

        mock_aggregator = MagicMock()
        mock_aggregator.aggregate.return_value = [
            {
                "name": article.name,
                "identifier": article.identifier,
                "raw_content": "different raw",
                "content": article.content,
            }
        ]
        mock_get_agg.return_value = mock_aggregator

        AggregatorService.trigger_by_feed_id(rss_feed.id, force_update=True)

        mock_save_img.assert_not_called()
        article.refresh_from_db()
        assert article.icon.name == "article_icons/existing.jpg"

    @patch("core.services.aggregator_service.get_aggregator")
    def test_trigger_by_feed_id_force_update_unchanged_image_does_not_orphan_files(
        self, mock_get_agg, rss_feed, article, settings, tmp_path
    ):
        """Repeated force_update runs with the same image must not pile up icon files."""
        settings.MEDIA_ROOT = str(tmp_path / "media")

        image_bytes = b"identical-header-bytes"

        def make_aggregator():
            header_data = MagicMock()
            header_data.image_bytes = image_bytes
            header_data.content_type = "image/jpeg"
            mock_aggregator = MagicMock()
            mock_aggregator.aggregate.return_value = [
                {
                    "name": article.name,
                    "identifier": article.identifier,
                    "raw_content": article.raw_content,
                    "content": article.content,
                    "header_data": header_data,
                }
            ]
            return mock_aggregator

        mock_get_agg.return_value = make_aggregator()
        AggregatorService.trigger_by_feed_id(rss_feed.id, force_update=True)
        article.refresh_from_db()
        first_icon_name = article.icon.name
        assert first_icon_name

        mock_get_agg.return_value = make_aggregator()
        AggregatorService.trigger_by_feed_id(rss_feed.id, force_update=True)
        article.refresh_from_db()

        assert article.icon.name == first_icon_name

        icon_dir = tmp_path / "media" / "article_icons"
        assert len(list(icon_dir.iterdir())) == 1

    @patch("core.services.aggregator_service.get_aggregator")
    def test_trigger_by_feed_id_aggregator_exception(self, mock_get_agg, rss_feed):
        mock_aggregator = MagicMock()
        mock_aggregator.aggregate.side_effect = Exception("Aggregation failed")
        mock_get_agg.return_value = mock_aggregator

        result = AggregatorService.trigger_by_feed_id(rss_feed.id)

        assert result["success"] is False
        assert "Aggregation failed" in result["error"]

    @patch("core.services.aggregator_service.async_task")
    def test_trigger_by_aggregator_type(self, mock_async_task, rss_feed):
        mock_async_task.return_value = "task-123"

        results = AggregatorService.trigger_by_aggregator_type("rss")

        assert len(results) == 1
        assert mock_async_task.called
        assert results[0]["feed_id"] == rss_feed.id
        assert results[0]["task_id"] == "task-123"
        assert results[0]["status"] == "queued"

        # Verify async_task was called with correct arguments
        mock_async_task.assert_called_once_with(
            "core.services.aggregator_service.AggregatorService.trigger_by_feed_id",
            rss_feed.id,
            force_update=False,
            task_name="aggregate_feed_rss_feed",
        )

    @patch("core.services.aggregator_service.async_task")
    def test_trigger_all(self, mock_async_task, rss_feed, youtube_feed):
        mock_async_task.return_value = "task-456"

        results = AggregatorService.trigger_all()

        assert len(results) == 2
        assert mock_async_task.call_count == 2

        # Verify each result has the expected structure
        for result in results:
            assert "feed_id" in result
            assert "feed_name" in result
            assert result["task_id"] == "task-456"
            assert result["status"] == "queued"

    @patch("core.services.aggregator_service.async_task")
    def test_trigger_all_with_limit(self, mock_async_task, rss_feed, youtube_feed):
        mock_async_task.return_value = "task-789"

        results = AggregatorService.trigger_all(limit=1)

        assert len(results) == 1
        assert mock_async_task.call_count == 1

    @patch("core.services.aggregator_service.async_task")
    def test_trigger_by_aggregator_type_with_force_update(self, mock_async_task, rss_feed):
        mock_async_task.return_value = "task-abc"

        AggregatorService.trigger_by_aggregator_type("rss", force_update=True)

        mock_async_task.assert_called_once_with(
            "core.services.aggregator_service.AggregatorService.trigger_by_feed_id",
            rss_feed.id,
            force_update=True,
            task_name="aggregate_feed_rss_feed",
        )

    @patch("core.services.aggregator_service.AggregatorService.trigger_by_feed_id")
    def test_trigger_all_sync(self, mock_trigger, rss_feed, youtube_feed):
        """Test that sync=True processes feeds synchronously."""
        mock_trigger.return_value = {"success": True, "articles_count": 1}

        results = AggregatorService.trigger_all(sync=True)

        assert len(results) == 2
        assert mock_trigger.call_count == 2
        # Results should be the direct return values from trigger_by_feed_id
        for result in results:
            assert result["success"] is True
            assert result["articles_count"] == 1

    @patch("core.services.aggregator_service.AggregatorService.trigger_by_feed_id")
    def test_trigger_by_aggregator_type_sync(self, mock_trigger, rss_feed):
        """Test that sync=True processes feeds synchronously."""
        mock_trigger.return_value = {"success": True, "articles_count": 3}

        results = AggregatorService.trigger_by_aggregator_type("rss", sync=True)

        assert len(results) == 1
        assert mock_trigger.called
        assert results[0]["success"] is True
        assert results[0]["articles_count"] == 3
