"""Aggregator registry for mapping feed types to classes."""

from typing import Dict, Type

from .ars_technica import ArsTechnicaAggregator
from .base import BaseAggregator
from .caschys_blog.aggregator import CaschysBlogAggregator
from .dark_legacy.aggregator import DarkLegacyAggregator
from .explosm.aggregator import ExplosmAggregator
from .heise import HeiseAggregator
from .implementations import FeedContentAggregator
from .mactechnews.aggregator import MactechnewsAggregator
from .mein_mmo import MeinMmoAggregator
from .merkur import MerkurAggregator
from .oglaf import OglafAggregator
from .podcast.aggregator import PodcastAggregator
from .reddit import RedditAggregator
from .tagesschau import TagesschauAggregator
from .the_verge import TheVergeAggregator
from .website import FullWebsiteAggregator
from .youtube.aggregator import YouTubeAggregator


class AggregatorRegistry:
    """Registry for aggregator classes."""

    _registry: Dict[str, Type[BaseAggregator]] = {
        "full_website": FullWebsiteAggregator,
        "feed_content": FeedContentAggregator,
        "heise": HeiseAggregator,
        "merkur": MerkurAggregator,
        "tagesschau": TagesschauAggregator,
        "explosm": ExplosmAggregator,
        "dark_legacy": DarkLegacyAggregator,
        "caschys_blog": CaschysBlogAggregator,
        "mactechnews": MactechnewsAggregator,
        "oglaf": OglafAggregator,
        "mein_mmo": MeinMmoAggregator,
        "the_verge": TheVergeAggregator,
        "ars_technica": ArsTechnicaAggregator,
        "youtube": YouTubeAggregator,
        "reddit": RedditAggregator,
        "podcast": PodcastAggregator,
    }

    @classmethod
    def get(cls, aggregator_type: str) -> Type[BaseAggregator]:
        """
        Get aggregator class for the given type.

        Args:
            aggregator_type: The aggregator type string (e.g., 'full_website')

        Returns:
            Aggregator class

        Raises:
            KeyError: If aggregator type is not found
        """
        if aggregator_type not in cls._registry:
            raise KeyError(f"Unknown aggregator type: {aggregator_type}")
        return cls._registry[aggregator_type]

    @classmethod
    def get_all(cls) -> Dict[str, Type[BaseAggregator]]:
        """Get all registered aggregators."""
        return cls._registry.copy()


def get_aggregator(feed) -> BaseAggregator:
    """
    Get aggregator instance for a feed.

    Args:
        feed: Feed model instance

    Returns:
        Instantiated aggregator
    """
    aggregator_class = AggregatorRegistry.get(feed.aggregator)
    return aggregator_class(feed)
