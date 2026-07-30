"""Tests for per-feed logo resolution and storage."""

import pytest

from core.models import Feed


@pytest.mark.django_db
def test_feed_starts_without_a_logo(user):
    feed = Feed.objects.create(
        name="Heise", aggregator="heise", identifier="https://www.heise.de/rss/heise.rdf", user=user
    )

    assert not feed.logo
    assert feed.logo_source_url == ""
