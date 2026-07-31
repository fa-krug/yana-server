"""
Aggregators package.
"""

from .base import BaseAggregator
from .registry import AggregatorRegistry, get_aggregator

__all__ = ["BaseAggregator", "AggregatorRegistry", "get_aggregator"]
