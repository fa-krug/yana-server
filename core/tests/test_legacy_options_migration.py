"""Tests for the legacy selector-option conversion and its migration."""

import importlib

from django.apps import apps as global_apps

import pytest

from core.aggregators.utils.legacy_options import convert_legacy_options, revert_options


class TestConvertLegacyOptions:
    def test_comma_string_becomes_a_list(self):
        options, to_feed_content = convert_legacy_options(
            {"custom_content_selector": "article, .body"}
        )

        assert options == {"content_selectors": ["article", ".body"]}
        assert to_feed_content is False

    def test_stray_whitespace_and_empty_segments_are_cleaned(self):
        options, _ = convert_legacy_options({"custom_selectors_to_remove": " .ads , , .sidebar ,"})

        assert options == {"ignore_selectors": [".ads", ".sidebar"]}

    def test_empty_legacy_value_is_dropped_so_defaults_apply(self):
        options, _ = convert_legacy_options(
            {"custom_content_selector": "", "custom_selectors_to_remove": "  "}
        )

        assert options == {}

    def test_existing_new_key_wins_over_legacy(self):
        options, _ = convert_legacy_options(
            {"content_selectors": [], "custom_content_selector": "article"}
        )

        assert options == {"content_selectors": []}

    def test_use_full_content_false_requests_conversion(self):
        options, to_feed_content = convert_legacy_options({"use_full_content": False})

        assert options == {}
        assert to_feed_content is True

    def test_use_full_content_true_only_drops_the_key(self):
        options, to_feed_content = convert_legacy_options(
            {"use_full_content": True, "skip_ads": True}
        )

        assert options == {"skip_ads": True}
        assert to_feed_content is False

    def test_unrelated_options_are_untouched(self):
        options, _ = convert_legacy_options({"ai_summarize": True, "max_comments": 5})

        assert options == {"ai_summarize": True, "max_comments": 5}

    def test_non_dict_options_yield_an_empty_dict(self):
        options, to_feed_content = convert_legacy_options(["not", "a", "dict"])

        assert options == {}
        assert to_feed_content is False


class TestRevertOptions:
    def test_lists_become_comma_strings(self):
        reverted = revert_options(
            {"content_selectors": ["article", ".body"], "ignore_selectors": [".ads"]}
        )

        assert reverted == {
            "custom_content_selector": "article, .body",
            "custom_selectors_to_remove": ".ads",
        }

    def test_absent_keys_stay_absent(self):
        assert revert_options({"skip_ads": True}) == {"skip_ads": True}


@pytest.mark.django_db
class TestMigrationOverRealRows:
    @staticmethod
    def _run_forwards():
        module = importlib.import_module("core.migrations.0027_migrate_selector_options")
        module.forwards(global_apps, None)

    def test_full_website_feed_keeps_its_type_and_gains_lists(self, user):
        from core.models import Feed

        feed = Feed.objects.create(
            name="Legacy",
            aggregator="full_website",
            identifier="https://example.com/rss",
            user=user,
            options={
                "use_full_content": True,
                "custom_content_selector": "article, .body",
                "custom_selectors_to_remove": ".ads",
            },
        )

        self._run_forwards()

        feed.refresh_from_db()
        assert feed.aggregator == "full_website"
        assert feed.options == {
            "content_selectors": ["article", ".body"],
            "ignore_selectors": [".ads"],
        }

    def test_summary_only_feed_becomes_feed_content(self, user):
        from core.models import Feed

        feed = Feed.objects.create(
            name="Summary only",
            aggregator="full_website",
            identifier="https://example.com/rss",
            user=user,
            options={"use_full_content": False},
        )

        self._run_forwards()

        feed.refresh_from_db()
        assert feed.aggregator == "feed_content"
        assert feed.options == {}

    def test_malformed_options_row_does_not_block_the_migration(self, user):
        from core.models import Feed

        broken = Feed.objects.create(
            name="Broken",
            aggregator="full_website",
            identifier="https://example.com/broken",
            user=user,
            options=["not", "a", "dict"],
        )
        good = Feed.objects.create(
            name="Good",
            aggregator="full_website",
            identifier="https://example.com/good",
            user=user,
            options={"custom_content_selector": "article"},
        )

        self._run_forwards()

        broken.refresh_from_db()
        good.refresh_from_db()
        assert broken.options == ["not", "a", "dict"]
        assert good.options == {"content_selectors": ["article"]}
