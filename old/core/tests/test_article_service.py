from datetime import timedelta
from unittest.mock import MagicMock, patch

from django.core.exceptions import ObjectDoesNotExist
from django.utils import timezone

import pytest

from core.models import Article
from core.services.article_service import ArticleService


@pytest.mark.django_db
class TestArticleService:
    @patch("core.services.article_service.get_aggregator")
    def test_reload_article_success(self, mock_get_agg, article):
        # Setup mock aggregator
        mock_aggregator = MagicMock()
        mock_aggregator.fetch_article_content.return_value = "<html>new raw</html>"
        mock_aggregator.extract_content.return_value = "new extracted"
        mock_aggregator.process_content.return_value = "new processed"
        mock_aggregator.extract_header_element.return_value = None
        mock_get_agg.return_value = mock_aggregator

        # Act
        result = ArticleService.reload_article(article.id)

        # Assert
        assert result["success"] is True
        article.refresh_from_db()
        assert article.raw_content == "<html>new raw</html>"
        assert article.content == "new processed"

    def test_reload_article_disabled_feed(self, article):
        article.feed.enabled = False
        article.feed.save()

        result = ArticleService.reload_article(article.id)

        assert result["success"] is False
        assert "Feed is disabled" in result["error"]

    @patch("core.services.article_service.get_aggregator")
    @patch("core.services.article_service.HeaderElementFileHandler.save_image_to_article")
    def test_reload_article_with_header_image(self, mock_save_img, mock_get_agg, article):
        mock_header_data = MagicMock()
        mock_header_data.image_bytes = b"new_img"
        mock_header_data.content_type = "image/png"

        mock_aggregator = MagicMock()
        mock_aggregator.extract_header_element.return_value = mock_header_data
        mock_aggregator.fetch_article_content.return_value = "raw"
        mock_aggregator.extract_content.return_value = "extracted"
        mock_aggregator.process_content.return_value = "processed"
        mock_get_agg.return_value = mock_aggregator

        ArticleService.reload_article(article.id)

        assert mock_save_img.called

    @patch("core.services.article_service.get_aggregator")
    def test_reload_article_fetch_failure(self, mock_get_agg, article):
        mock_aggregator = MagicMock()
        mock_aggregator.fetch_article_content.side_effect = Exception("Fetch failed")
        mock_get_agg.return_value = mock_aggregator

        result = ArticleService.reload_article(article.id)

        assert result["success"] is False
        assert "Fetch failed" in result["error"]

    def test_reload_article_not_found(self):
        with pytest.raises(ObjectDoesNotExist):
            ArticleService.reload_article(9999)

    @patch("core.services.article_service.get_aggregator")
    def test_reload_article_preserves_metadata(self, mock_get_agg, article):
        article.read = True
        article.starred = True
        article.save()

        mock_aggregator = MagicMock()
        mock_aggregator.fetch_article_content.return_value = "raw"
        mock_aggregator.extract_content.return_value = "extracted"
        mock_aggregator.process_content.return_value = "processed"
        mock_aggregator.extract_header_element.return_value = None
        mock_get_agg.return_value = mock_aggregator

        ArticleService.reload_article(article.id)

        article.refresh_from_db()
        assert article.read is True
        assert article.starred is True

    def test_delete_old_articles_custom_threshold(self, rss_feed):
        # Retention is keyed on created_at (import time), not date (publish
        # time) -- see core/tests/test_article_cleanup.py. created_at is
        # auto_now_add, so ages are set with a queryset .update() afterward.
        now = timezone.now()
        # Imported 4 months ago
        old = Article.objects.create(name="Old", identifier="old", feed=rss_feed, date=now)
        Article.objects.filter(id=old.id).update(created_at=now - timedelta(days=120))
        # Imported 2 months ago
        mid = Article.objects.create(name="Mid", identifier="mid", feed=rss_feed, date=now)
        Article.objects.filter(id=mid.id).update(created_at=now - timedelta(days=60))

        # Delete older than 3 months
        count = ArticleService.delete_old_articles(months=3)
        assert count == 1
        assert Article.objects.count() == 1
        assert Article.objects.first().name == "Mid"

    def test_delete_old_articles_empty_db(self):
        count = ArticleService.delete_old_articles()
        assert count == 0
