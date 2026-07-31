"""Every path that persists an article converts its blocks."""

from unittest.mock import MagicMock, patch

import pytest

from core.models import Article
from core.services.aggregator_service import AggregatorService


@pytest.mark.django_db
class TestBlockSavePaths:
    @patch("core.services.aggregator_service.get_aggregator")
    def test_aggregation_converts_a_newly_created_article(self, mock_get_agg, rss_feed):
        mock_aggregator = MagicMock()
        mock_aggregator.aggregate.return_value = [
            {
                "identifier": "https://example.com/new",
                "name": "New",
                "raw_content": "<html></html>",
                "content": "<p>fresh body</p>",
                "author": "",
            }
        ]
        mock_get_agg.return_value = mock_aggregator

        result = AggregatorService.trigger_by_feed_id(rss_feed.id)

        assert result["success"]
        article = Article.objects.get(identifier="https://example.com/new")
        assert [block.kind for block in article.blocks.all()] == ["paragraph"]
        assert article.plain_text == "fresh body"

    @patch("core.services.aggregator_service.get_aggregator")
    def test_a_forced_update_reconverts(self, mock_get_agg, rss_feed, article):
        article.content = "<p>old</p>"
        article.save()

        mock_aggregator = MagicMock()
        mock_aggregator.aggregate.return_value = [
            {
                "identifier": article.identifier,
                "name": article.name,
                "raw_content": article.raw_content,
                "content": "<p>new</p>",
                "author": "",
            }
        ]
        mock_get_agg.return_value = mock_aggregator

        AggregatorService.trigger_by_feed_id(article.feed_id, force_update=True)

        article.refresh_from_db()
        assert article.plain_text == "new"
