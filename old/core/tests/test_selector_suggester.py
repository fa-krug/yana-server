"""Tests for AI selector suggestion."""

import json
from unittest.mock import MagicMock, patch

import pytest

from core.models import Article, Feed, UserSettings
from core.services.selector_suggester import (
    FEED_FETCH_TIMEOUT,
    SelectorSuggestionError,
    apply_suggested_selectors,
    has_ai_provider,
    html_digest_for_selectors,
    suggest_selectors,
)

PAGE = """
<html><head><title>t</title><style>.a{color:red}</style></head>
<body><nav>menu</nav><article class="article-body"><p>Long prose here.</p></article>
<script>var x = 1;</script></body></html>
"""


@pytest.fixture
def ai_feed(user):
    UserSettings.objects.create(user=user, active_ai_provider="openai", openai_enabled=True)
    feed = Feed.objects.create(
        name="Golem",
        aggregator="full_website",
        identifier="https://golem.de/rss.php",
        user=user,
        options={"content_selectors": ["article"], "ignore_selectors": [".ad"]},
    )
    Article.objects.create(
        name="A", identifier="https://golem.de/a", raw_content="", content="", feed=feed
    )
    return feed


def _ai_response(*selectors: str) -> str:
    return json.dumps({"selectors": list(selectors)})


def test_digest_drops_scripts_and_styles_but_keeps_structure():
    digest = html_digest_for_selectors(PAGE)

    assert "var x = 1" not in digest
    assert "color:red" not in digest
    assert 'class="article-body"' in digest


def test_digest_truncates_long_text_nodes():
    html = "<article><p>" + ("word " * 200) + "</p></article>"
    digest = html_digest_for_selectors(html)

    assert "<article>" in digest
    assert len(digest) < len(html)


def test_digest_respects_the_character_cap():
    html = "<div>" + "<p class='x'>text</p>" * 5000 + "</div>"
    assert len(html_digest_for_selectors(html, max_chars=500)) <= 500


@pytest.mark.django_db
def test_valid_json_is_decoded(ai_feed):
    client = MagicMock()
    client.generate_response.return_value = _ai_response("div.article-body", "figure")

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
    ):
        assert suggest_selectors(ai_feed, "content") == ["div.article-body", "figure"]


@pytest.mark.django_db
def test_current_entries_are_offered_as_candidates(ai_feed):
    client = MagicMock()
    client.generate_response.return_value = _ai_response("article")

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
    ):
        suggest_selectors(ai_feed, "ignore")

    prompt = client.generate_response.call_args.args[0]
    assert ".ad" in prompt


@pytest.mark.django_db
def test_malformed_json_raises(ai_feed):
    client = MagicMock()
    client.generate_response.return_value = "sorry, no JSON here"

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
        pytest.raises(SelectorSuggestionError),
    ):
        suggest_selectors(ai_feed, "content")


@pytest.mark.django_db
def test_empty_selector_list_raises(ai_feed):
    client = MagicMock()
    client.generate_response.return_value = _ai_response()

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
        pytest.raises(SelectorSuggestionError),
    ):
        suggest_selectors(ai_feed, "content")


@pytest.mark.django_db
def test_provider_failure_raises(ai_feed):
    client = MagicMock()
    client.generate_response.return_value = None

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
        pytest.raises(SelectorSuggestionError),
    ):
        suggest_selectors(ai_feed, "content")


@pytest.mark.django_db
def test_unknown_kind_raises(ai_feed):
    with pytest.raises(ValueError):
        suggest_selectors(ai_feed, "nonsense")


@pytest.mark.django_db
def test_apply_unknown_kind_raises_value_error_and_leaves_options_untouched(ai_feed):
    with pytest.raises(ValueError):
        apply_suggested_selectors(ai_feed, "nonsense")

    ai_feed.refresh_from_db()
    assert ai_feed.options["content_selectors"] == ["article"]
    assert ai_feed.options["ignore_selectors"] == [".ad"]


@pytest.mark.django_db
def test_apply_overwrites_only_the_requested_list(ai_feed):
    client = MagicMock()
    client.generate_response.return_value = _ai_response("aside", ".newsletter")

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
    ):
        previous, new = apply_suggested_selectors(ai_feed, "ignore")

    ai_feed.refresh_from_db()
    assert previous == [".ad"]
    assert new == ["aside", ".newsletter"]
    assert ai_feed.options["ignore_selectors"] == ["aside", ".newsletter"]
    assert ai_feed.options["content_selectors"] == ["article"]


@pytest.mark.django_db
def test_apply_leaves_options_untouched_on_failure(ai_feed):
    client = MagicMock()
    client.generate_response.return_value = "not json"

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
        pytest.raises(SelectorSuggestionError),
    ):
        apply_suggested_selectors(ai_feed, "content")

    ai_feed.refresh_from_db()
    assert ai_feed.options["content_selectors"] == ["article"]


@pytest.mark.django_db
def test_has_ai_provider_reflects_settings(ai_feed, user):
    assert has_ai_provider(user) is True

    settings_row = UserSettings.objects.get(user=user)
    settings_row.active_ai_provider = ""
    settings_row.save()
    assert has_ai_provider(user) is False


@pytest.mark.django_db
def test_has_ai_provider_is_false_without_settings(user):
    assert has_ai_provider(user) is False


@pytest.mark.django_db
def test_page_url_lookup_bounds_the_feed_fetch(user):
    """Suggestion runs from an admin action, so the fallback feed fetch is bounded.

    Without a ``timeout`` ``parse_rss_feed`` lets feedparser do its own HTTP,
    which has none -- a black-holed host would hang the admin request.
    """
    UserSettings.objects.create(user=user, active_ai_provider="openai", openai_enabled=True)
    # No articles, so the page URL has to come from the feed itself.
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )
    client = MagicMock()
    client.generate_response.return_value = _ai_response("article")

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
        patch(
            "core.services.selector_suggester.parse_rss_feed",
            return_value={"entries": [{"link": "https://golem.de/a"}]},
        ) as parse,
    ):
        suggest_selectors(feed, "content")

    assert parse.call_args.kwargs["timeout"] == FEED_FETCH_TIMEOUT
    assert 0 < FEED_FETCH_TIMEOUT <= 10, "an admin request must not wait longer than this"


@pytest.mark.django_db
def test_missing_page_url_raises(user):
    UserSettings.objects.create(user=user, active_ai_provider="openai", openai_enabled=True)
    feed = Feed.objects.create(
        name="Empty", aggregator="full_website", identifier="not a url", user=user
    )

    with (
        patch("core.services.selector_suggester.AIClient"),
        patch(
            "core.services.selector_suggester.parse_rss_feed",
            side_effect=ValueError("Invalid feed URL"),
        ),
        pytest.raises(SelectorSuggestionError),
    ):
        suggest_selectors(feed, "content")
