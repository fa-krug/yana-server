from unittest.mock import MagicMock

from django.test import TestCase

from core.aggregators.base import BaseAggregator
from core.aggregators.registry import AggregatorRegistry, get_aggregator
from core.aggregators.website import FullWebsiteAggregator


class TestAggregatorRegistry(TestCase):
    def test_get_existing_aggregator(self):
        """Test retrieving an existing aggregator class."""
        agg_class = AggregatorRegistry.get("full_website")
        self.assertEqual(agg_class, FullWebsiteAggregator)

    def test_get_unknown_aggregator(self):
        """Test retrieving an unknown aggregator raises KeyError."""
        with self.assertRaises(KeyError):
            AggregatorRegistry.get("non_existent_aggregator")

    def test_get_all(self):
        """Test retrieving all aggregators."""
        registry = AggregatorRegistry.get_all()
        self.assertIsInstance(registry, dict)
        self.assertIn("full_website", registry)
        self.assertIn("reddit", registry)

    def test_get_aggregator_factory(self):
        """Test get_aggregator factory function."""
        # Create a dummy feed-like object
        feed = MagicMock()
        feed.aggregator = "full_website"
        feed.identifier = "http://example.com"

        aggregator = get_aggregator(feed)

        self.assertIsInstance(aggregator, BaseAggregator)
        self.assertIsInstance(aggregator, FullWebsiteAggregator)
        self.assertEqual(aggregator.feed, feed)
