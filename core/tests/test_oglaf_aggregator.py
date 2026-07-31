"""Tests for the Oglaf aggregator's hosted comic image."""

import importlib
from unittest.mock import patch

from django.apps import apps as global_apps

import pytest
from bs4 import BeautifulSoup

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
class TestOglafHtmlInjection:
    """The comic's `alt`/`title` attributes and `src` URL are scraped from
    the live oglaf.com page -- third-party, attacker-reachable text -- and
    were being spliced straight into the generated markup unescaped."""

    MALICIOUS_ALT_TITLE_HTML = """
    <div class="content">
        <img id="strip" src="https://media.oglaf.com/comic/tribute.jpg"
             alt="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"
             title="&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;">
    </div>
    """

    # A single-quoted `src` attribute lets a literal double quote through --
    # simulating a scraped page whose `src` value could break out of the
    # double-quoted attribute this aggregator builds.
    QUOTE_BREAKING_SRC_HTML = (
        '<div class="content"><img id="strip" '
        "src='https://media.oglaf.com/comic/tribute.jpg\"><script>alert(1)</script>' "
        'alt="Tribute" title="joke"></div>'
    )

    # Includes the "media.oglaf.com" substring so the aggregator's relative-URL
    # normalization (which would otherwise prefix a bare "javascript:alert(1)"
    # with "https://media.oglaf.com/comic/", incidentally neutralizing it)
    # leaves this `src` untouched -- it must reach the scheme check as-is.
    UNSAFE_SCHEME_SRC_HTML = """
    <div class="content">
        <img id="strip" src="javascript:alert(1)//media.oglaf.com" alt="Tribute" title="joke">
    </div>
    """

    @pytest.fixture
    def oglaf_feed(self, user):
        return Feed.objects.create(
            name="Oglaf",
            aggregator="oglaf",
            identifier="https://www.oglaf.com/feeds/rss/",
            user=user,
        )

    def test_alt_and_title_text_are_escaped(self, oglaf_feed):
        with patch(
            "core.aggregators.oglaf.aggregator.store_image_ref_from_url",
            return_value=STORED_REF,
        ):
            processed = OglafAggregator(oglaf_feed).process_content(
                self.MALICIOUS_ALT_TITLE_HTML, make_article()
            )

        soup = BeautifulSoup(processed, "html.parser")
        assert soup.find("script") is None

        img = soup.find("img", src=lambda s: s and s.startswith("yana-img://"))
        assert img is not None
        assert img["alt"] == '"><script>alert(1)</script>'

        joke_p = soup.find("p")
        assert joke_p is not None
        assert joke_p.get_text() == '"><script>alert(2)</script>'

    def test_quote_in_src_does_not_break_the_attribute(self, oglaf_feed):
        malicious_src = 'https://media.oglaf.com/comic/tribute.jpg"><script>alert(1)</script>'
        with patch(
            "core.aggregators.oglaf.aggregator.store_image_ref_from_url",
            return_value=None,
        ) as mock_store:
            processed = OglafAggregator(oglaf_feed).process_content(
                self.QUOTE_BREAKING_SRC_HTML, make_article()
            )

        mock_store.assert_called_once_with(malicious_src)
        soup = BeautifulSoup(processed, "html.parser")
        assert soup.find("script") is None
        img = soup.select_one('img[alt="Tribute"]')
        assert img is not None
        assert img["src"] == malicious_src

    def test_unsafe_scheme_skips_the_image_entirely(self, oglaf_feed):
        with patch(
            "core.aggregators.oglaf.aggregator.store_image_ref_from_url",
        ) as mock_store:
            processed = OglafAggregator(oglaf_feed).process_content(
                self.UNSAFE_SCHEME_SRC_HTML, make_article()
            )

        mock_store.assert_not_called()
        soup = BeautifulSoup(processed, "html.parser")
        assert soup.find("img") is None
        assert soup.find("script") is None
        # The legitimate "show alt text" feature still renders the joke text
        # even when the image itself had to be skipped.
        assert "joke" in processed


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
