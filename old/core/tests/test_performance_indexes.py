import pytest

from core.models import Article, Feed


@pytest.mark.django_db
class TestPerformanceIndexes:
    """Test that performance-critical indexes are present."""

    def test_article_composite_index_exists(self):
        """Check if the composite index (feed, read, date) exists on Article."""
        index_fields = [set(index.fields) for index in Article._meta.indexes]
        expected_fields = {"feed", "read", "date"}
        assert expected_fields in index_fields, (
            f"Composite index {expected_fields} not found in Article._meta.indexes"
        )

    def test_feed_aggregator_index_exists(self):
        """Check if the index on aggregator exists on Feed."""
        index_fields = [set(index.fields) for index in Feed._meta.indexes]
        expected_fields = {"aggregator"}
        assert expected_fields in index_fields, (
            f"Index {expected_fields} not found in Feed._meta.indexes"
        )

    def test_article_created_at_cursor_index_exists(self):
        """The sync cursor orders by created_at, tie-broken by id."""
        index_fields = [index.fields for index in Article._meta.indexes]
        assert ["-created_at", "-id"] in index_fields, (
            f"Cursor index ['-created_at', '-id'] not found in {index_fields}"
        )

    def test_article_feed_created_at_index_exists(self):
        index_fields = [index.fields for index in Article._meta.indexes]
        assert ["feed", "-created_at"] in index_fields, (
            f"Index ['feed', '-created_at'] not found in {index_fields}"
        )

    def test_existing_date_indexes_are_kept(self):
        """date is still filtered and sorted on for display."""
        index_fields = [set(index.fields) for index in Article._meta.indexes]
        assert {"date"} in index_fields
        assert {"feed", "date"} in index_fields

    def test_default_ordering_stays_display_oriented(self):
        assert Article._meta.ordering == ["-date"]
