"""Every former base64 call site renders a hosted image reference.

The five aggregators listed here are the ones that used to read
``header_data.base64_data_uri or header_data.image_url``.
"""

import pytest

from core.aggregators.registry import get_aggregator
from core.aggregators.services.header_element.context import HeaderElementData
from core.models import Feed
from core.tests.image_refs import assert_hosted_image

HEADER_HASH = "a1" * 32

# (aggregator key, identifier, extra feed options needed to stay offline)
CASES = [
    ("full_website", "https://example.com/rss", {}),
    ("heise", "https://www.heise.de/rss/heise-atom.xml", {"include_comments": False}),
    ("mein_mmo", "https://mein-mmo.de/feed/", {"include_comments": False}),
    ("mactechnews", "https://www.mactechnews.de/news/rss", {"include_comments": False}),
    ("reddit", "python", {}),
]


def make_article() -> dict:
    return {
        "name": "Hosted image article",
        "identifier": "https://example.com/article",
        "raw_content": "<html><body><p>Body text.</p></body></html>",
        "content": "<p>Body text.</p>",
        "header_data": HeaderElementData(
            image_bytes=b"ignored",
            content_type="image/webp",
            content_hash=HEADER_HASH,
            image_url="https://example.com/header.jpg",
        ),
    }


@pytest.mark.django_db
@pytest.mark.parametrize(("aggregator", "identifier", "options"), CASES)
def test_header_image_is_referenced_by_hash(aggregator, identifier, options, user_with_settings):
    feed = Feed.objects.create(
        name=f"{aggregator} feed",
        aggregator=aggregator,
        identifier=identifier,
        user=user_with_settings,
        options=options,
    )

    processed = get_aggregator(feed).process_content("<p>Body text.</p>", make_article())

    assert_hosted_image(processed, HEADER_HASH)


def test_header_element_data_exposes_the_reference():
    data = HeaderElementData(image_bytes=b"x", content_type="image/webp", content_hash=HEADER_HASH)

    assert data.image_ref == f"yana-img://{HEADER_HASH}"
