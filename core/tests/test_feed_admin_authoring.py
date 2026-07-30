"""Tests for the feed-authoring admin surfaces: resolve, test, logo, suggest."""

from unittest.mock import patch

import pytest

from core.admin import FeedAdmin
from core.forms import FeedAdminForm
from core.models import Feed


def _form_data(**overrides):
    data = {
        "name": "Golem",
        "aggregator": "full_website",
        "identifier": "golem.de",
        "daily_limit": 20,
        "options": "{}",
    }
    data.update(overrides)
    return data


@pytest.mark.django_db
def test_clean_identifier_resolves_for_a_url_aggregator():
    with patch("core.forms.resolve_feed_url", return_value="https://golem.de/rss.php") as resolve:
        form = FeedAdminForm(data=_form_data())
        assert form.is_valid(), form.errors
        assert form.cleaned_data["identifier"] == "https://golem.de/rss.php"
    resolve.assert_called_once_with("golem.de")


@pytest.mark.django_db
def test_clean_identifier_leaves_a_subreddit_alone():
    with patch("core.forms.resolve_feed_url") as resolve:
        form = FeedAdminForm(data=_form_data(aggregator="reddit", identifier="swift"))
        form.is_valid()
        assert form.cleaned_data["identifier"] == "swift"
    resolve.assert_not_called()


@pytest.mark.django_db
def test_clean_identifier_leaves_a_managed_scraper_alone():
    with patch("core.forms.resolve_feed_url") as resolve:
        form = FeedAdminForm(
            data=_form_data(aggregator="heise", identifier="https://www.heise.de/rss/heise.rdf")
        )
        form.is_valid()
        assert form.cleaned_data["identifier"] == "https://www.heise.de/rss/heise.rdf"
    resolve.assert_not_called()


@pytest.mark.django_db
def test_clean_identifier_survives_a_blank_identifier():
    with patch("core.forms.resolve_feed_url") as resolve:
        form = FeedAdminForm(data=_form_data(identifier=""))
        form.is_valid()
        assert form.cleaned_data["identifier"] == ""
    resolve.assert_not_called()


@pytest.mark.django_db
def test_resolve_and_test_action_reports_entry_count_without_saving(rf, user):
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="golem.de", user=user
    )
    admin_instance = FeedAdmin(Feed, None)
    request = rf.post("/admin/core/feed/")
    request.user = user
    messages = []

    with (
        patch("core.admin.resolve_feed_url", return_value="https://golem.de/rss.php"),
        patch(
            "core.admin.parse_rss_feed",
            return_value={
                "entries": [{"title": "a"}, {"title": "b"}],
                "feed": {},
                "version": "rss20",
            },
        ),
        patch.object(
            FeedAdmin, "message_user", lambda self, req, msg, *a, **kw: messages.append(msg)
        ),
    ):
        admin_instance.resolve_and_test_feeds(request, Feed.objects.filter(pk=feed.pk))

    feed.refresh_from_db()
    assert feed.identifier == "golem.de"
    assert any("2" in message and "https://golem.de/rss.php" in message for message in messages)


@pytest.mark.django_db
def test_resolve_and_test_action_reports_a_failure(rf, user):
    feed = Feed.objects.create(
        name="Dead", aggregator="full_website", identifier="dead.example", user=user
    )
    admin_instance = FeedAdmin(Feed, None)
    request = rf.post("/admin/core/feed/")
    request.user = user
    messages = []

    with (
        patch("core.admin.resolve_feed_url", return_value="https://dead.example"),
        patch("core.admin.parse_rss_feed", side_effect=ValueError("No entries found in feed")),
        patch.object(
            FeedAdmin, "message_user", lambda self, req, msg, *a, **kw: messages.append(msg)
        ),
    ):
        admin_instance.resolve_and_test_feeds(request, Feed.objects.filter(pk=feed.pk))

    assert any("No entries" in message for message in messages)
