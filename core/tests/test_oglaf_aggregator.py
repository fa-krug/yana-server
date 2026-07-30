"""Tests for the Oglaf aggregator's hosted comic image."""

import importlib
from unittest.mock import patch

from django.apps import apps as global_apps

import pytest

from core.aggregators.oglaf.aggregator import OglafAggregator
from core.models import Feed
from core.tests.image_refs import assert_hosted_image

COMIC_HTML = """
<div class="content">
    <img id="strip" src="https://media.oglaf.com/comic/tribute.jpg"
         alt="Tribute" title="The second joke">
</div>
"""

STORED_REF = f"yana-img://{'f0' * 32}"


@pytest.fixture
def oglaf_feed(user):
    return Feed.objects.create(
        name="Oglaf",
        aggregator="oglaf",
        identifier="https://www.oglaf.com/feeds/rss/",
        user=user,
    )


def make_article() -> dict:
    return {"name": "Tribute", "identifier": "https://www.oglaf.com/tribute/"}


@pytest.mark.django_db
class TestOglafHostedImage:
    def test_the_comic_is_stored_and_referenced(self, oglaf_feed):
        with patch(
            "core.aggregators.oglaf.aggregator.store_image_ref_from_url",
            return_value=STORED_REF,
        ) as mock_store:
            processed = OglafAggregator(oglaf_feed).process_content(COMIC_HTML, make_article())

        mock_store.assert_called_once_with("https://media.oglaf.com/comic/tribute.jpg")
        assert_hosted_image(processed, STORED_REF.removeprefix("yana-img://"))

    def test_alt_text_still_renders_below_the_comic(self, oglaf_feed):
        with patch(
            "core.aggregators.oglaf.aggregator.store_image_ref_from_url",
            return_value=STORED_REF,
        ):
            processed = OglafAggregator(oglaf_feed).process_content(COMIC_HTML, make_article())

        assert "The second joke" in processed

    def test_a_store_failure_degrades_to_the_remote_url(self, oglaf_feed):
        with patch("core.aggregators.oglaf.aggregator.store_image_ref_from_url", return_value=None):
            processed = OglafAggregator(oglaf_feed).process_content(COMIC_HTML, make_article())

        assert "https://media.oglaf.com/comic/tribute.jpg" in processed
        assert "data:image" not in processed

    def test_convert_to_base64_is_no_longer_configurable(self):
        assert "convert_to_base64" not in OglafAggregator.get_configuration_fields()
        assert "show_alt_text" in OglafAggregator.get_configuration_fields()


@pytest.mark.django_db
class TestOglafOptionsMigration:
    @staticmethod
    def _run_forwards():
        module = importlib.import_module("core.migrations.0033_drop_oglaf_convert_to_base64")
        module.forwards(global_apps, None)

    def test_the_retired_key_is_dropped(self, user):
        feed = Feed.objects.create(
            name="Oglaf",
            aggregator="oglaf",
            identifier="https://www.oglaf.com/feeds/rss/",
            user=user,
            options={"convert_to_base64": True, "show_alt_text": False},
        )

        self._run_forwards()

        feed.refresh_from_db()
        assert feed.options == {"show_alt_text": False}

    def test_feeds_without_the_key_are_untouched(self, rss_feed):
        rss_feed.options = {"content_selectors": ["article"]}
        rss_feed.save(update_fields=["options"])

        self._run_forwards()

        rss_feed.refresh_from_db()
        assert rss_feed.options == {"content_selectors": ["article"]}
