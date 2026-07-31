"""Tests for model choices."""

from django.test import SimpleTestCase

from core.choices import AGGREGATOR_CHOICES


class AggregatorChoicesTest(SimpleTestCase):
    def test_oglaf_choice_exists(self):
        choices = dict(AGGREGATOR_CHOICES)
        self.assertIn("oglaf", choices)
        self.assertEqual(choices["oglaf"], "Oglaf")
