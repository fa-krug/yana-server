"""Tests for article cleanup functionality."""

from datetime import timedelta

from django.contrib.auth.models import User
from django.utils import timezone

import pytest

from core.models import Article, Feed, FeedGroup
from core.services.article_service import ArticleService


@pytest.mark.django_db
class TestArticleCleanup:
    @pytest.fixture
    def user(self):
        return User.objects.create_user(username="testuser", password="password")

    @pytest.fixture
    def group(self, user):
        return FeedGroup.objects.create(name="Test Group", user=user)

    @pytest.fixture
    def feed(self, user, group):
        return Feed.objects.create(name="Test Feed", user=user, group=group)

    def test_delete_old_articles(self, feed):
        """Retention is keyed on created_at (import time), not date (publish
        time) -- see test_retention_is_based_on_created_at_not_publish_date.
        created_at is auto_now_add, so ages are set with a queryset .update()
        after creation."""
        now = timezone.now()

        # Article 1: imported 3 months ago (should be deleted)
        a1 = Article.objects.create(name="Old Article", identifier="id1", feed=feed, date=now)
        Article.objects.filter(id=a1.id).update(created_at=now - timedelta(days=91))

        # Article 2: imported 1 month ago (should be kept)
        a2 = Article.objects.create(name="New Article", identifier="id2", feed=feed, date=now)
        Article.objects.filter(id=a2.id).update(created_at=now - timedelta(days=30))

        # Article 3: imported 3 months ago BUT starred (should be kept)
        a3 = Article.objects.create(
            name="Old Starred Article",
            identifier="id3",
            feed=feed,
            date=now,
            starred=True,
        )
        Article.objects.filter(id=a3.id).update(created_at=now - timedelta(days=91))

        # Run cleanup
        count = ArticleService.delete_old_articles(months=2)

        # Verify results
        assert count == 1
        assert not Article.objects.filter(id=a1.id).exists()
        assert Article.objects.filter(id=a2.id).exists()
        assert Article.objects.filter(id=a3.id).exists()

    def test_retention_is_based_on_created_at_not_publish_date(self, feed):
        """Article.date is now the real publish time (see core/aggregators/rss.py),
        so retention must key off created_at -- otherwise an article published
        59 days ago (which filter_articles' 60-day cutoff happily accepts) can
        be deleted on the very next cleanup run, right after import."""
        now = timezone.now()

        # Old publish date, but just imported -- must survive.
        just_imported = Article.objects.create(
            name="Old Publish, Fresh Import",
            identifier="id-old-publish",
            feed=feed,
            date=now - timedelta(days=91),
        )
        Article.objects.filter(id=just_imported.id).update(created_at=now)

        # Recent publish date, but imported long ago -- must be deleted.
        stale_import = Article.objects.create(
            name="Recent Publish, Stale Import",
            identifier="id-stale-import",
            feed=feed,
            date=now - timedelta(days=1),
        )
        Article.objects.filter(id=stale_import.id).update(created_at=now - timedelta(days=91))

        count = ArticleService.delete_old_articles(months=2)

        assert count == 1
        assert Article.objects.filter(id=just_imported.id).exists()
        assert not Article.objects.filter(id=stale_import.id).exists()
