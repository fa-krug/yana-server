"""Tests for the feed-authoring admin surfaces: resolve, test, logo, suggest."""

from unittest.mock import patch

from django.contrib import admin as django_admin
from django.urls import reverse

import pytest

from core.admin import FeedAdmin
from core.forms import FeedAdminForm
from core.models import Feed, UserSettings
from core.services.selector_suggester import SelectorSuggestionError


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


@pytest.mark.django_db
def test_form_save_resolves_the_logo_when_the_identifier_changed():
    with (
        patch("core.forms.resolve_feed_url", return_value="https://golem.de/rss.php"),
        patch("core.forms.store_feed_logo", return_value=True) as store,
    ):
        form = FeedAdminForm(data=_form_data())
        assert form.is_valid(), form.errors
        feed = form.save()

    store.assert_called_once_with(feed)


@pytest.mark.django_db
def test_form_save_survives_a_logo_failure(user):
    with (
        patch("core.forms.resolve_feed_url", return_value="https://golem.de/rss.php"),
        patch("core.forms.store_feed_logo", side_effect=OSError("dead")),
    ):
        form = FeedAdminForm(data=_form_data())
        assert form.is_valid(), form.errors
        feed = form.save()

    assert feed.pk is not None


@pytest.fixture
def logged_in_admin(client, admin_user):
    """An admin client plus the admin user, for real add/change view POSTs."""
    client.force_login(admin_user)
    return client, admin_user


@pytest.mark.django_db
def test_admin_add_view_resolves_the_logo(logged_in_admin):
    """The logo must be resolved through the real admin lifecycle.

    ``ModelAdmin.save_form()`` calls ``form.save(commit=False)``, so a refresh
    that only runs in the form's ``commit=True`` branch never happens in the
    admin -- which is the only surface this feature has.
    """
    client, admin_user = logged_in_admin

    with (
        patch("core.forms.resolve_feed_url", side_effect=lambda identifier: identifier),
        patch("core.forms.store_feed_logo", return_value=True) as store,
    ):
        response = client.post(
            reverse("admin:core_feed_add"),
            {"name": "Golem", "aggregator": "full_website"},
        )

    assert response.status_code == 302, "the add POST did not validate"
    feed = Feed.objects.get(name="Golem")
    store.assert_called_once_with(feed)


@pytest.mark.django_db
def test_admin_change_view_resolves_the_logo_when_the_identifier_changes(logged_in_admin):
    client, admin_user = logged_in_admin
    feed = Feed.objects.create(
        name="Golem",
        aggregator="full_website",
        identifier="https://golem.de/rss.php",
        user=admin_user,
        logo="feed_logos/feed-existing.png",
    )

    with (
        patch("core.forms.resolve_feed_url", side_effect=lambda identifier: identifier),
        patch("core.forms.store_feed_logo", return_value=True) as store,
    ):
        response = client.post(
            reverse("admin:core_feed_change", args=[feed.pk]),
            {
                "name": "Golem",
                "aggregator": "full_website",
                "identifier": "https://golem.de/atom.xml",
                "enabled": "on",
                "daily_limit": 20,
                "user": admin_user.pk,
                "group": "",
            },
        )

    assert response.status_code == 302, "the change POST did not validate"
    feed.refresh_from_db()
    assert feed.identifier == "https://golem.de/atom.xml"
    store.assert_called_once_with(feed)


@pytest.mark.django_db
def test_admin_change_view_keeps_an_existing_logo_when_nothing_changed(logged_in_admin):
    client, admin_user = logged_in_admin
    feed = Feed.objects.create(
        name="Golem",
        aggregator="full_website",
        identifier="https://golem.de/rss.php",
        user=admin_user,
        logo="feed_logos/feed-existing.png",
    )

    with (
        patch("core.forms.resolve_feed_url", side_effect=lambda identifier: identifier),
        patch("core.forms.store_feed_logo", return_value=True) as store,
    ):
        response = client.post(
            reverse("admin:core_feed_change", args=[feed.pk]),
            {
                "name": "Golem",
                "aggregator": "full_website",
                "identifier": "https://golem.de/rss.php",
                "enabled": "on",
                "daily_limit": 20,
                "user": admin_user.pk,
                "group": "",
            },
        )

    assert response.status_code == 302, "the change POST did not validate"
    store.assert_not_called()


@pytest.mark.django_db
def test_admin_save_survives_a_logo_failure(logged_in_admin):
    """A broken logo resolution must not turn into a save error."""
    client, admin_user = logged_in_admin

    with (
        patch("core.forms.resolve_feed_url", side_effect=lambda identifier: identifier),
        patch("core.forms.store_feed_logo", side_effect=OSError("dead")),
    ):
        response = client.post(
            reverse("admin:core_feed_add"),
            {"name": "Golem", "aggregator": "full_website"},
        )

    assert response.status_code == 302
    assert Feed.objects.filter(name="Golem").exists()


@pytest.mark.django_db
def test_refresh_logo_action_reports_per_feed(rf, user):
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )
    admin_instance = FeedAdmin(Feed, None)
    request = rf.post("/admin/core/feed/")
    request.user = user
    messages = []

    with (
        patch("core.admin.store_feed_logo", return_value=True),
        patch.object(
            FeedAdmin, "message_user", lambda self, req, msg, *a, **kw: messages.append(msg)
        ),
    ):
        admin_instance.refresh_feed_logos(request, Feed.objects.filter(pk=feed.pk))

    assert any("Golem" in message for message in messages)


SUGGEST_ACTIONS = ("suggest_content_selectors", "suggest_ignore_selectors")


@pytest.mark.django_db
def test_suggest_actions_are_hidden_without_an_ai_provider(rf, user):
    # A real AdminSite is required here (unlike the other tests in this file, which call
    # actions directly): Django's base get_actions() unconditionally reads
    # self.admin_site.actions, which raises AttributeError against admin_site=None.
    admin_instance = FeedAdmin(Feed, django_admin.site)
    request = rf.get("/admin/core/feed/")
    request.user = user

    actions = admin_instance.get_actions(request)

    assert all(name not in actions for name in SUGGEST_ACTIONS)


@pytest.mark.django_db
def test_suggest_actions_are_available_with_an_ai_provider(rf, user):
    UserSettings.objects.create(user=user, active_ai_provider="openai", openai_enabled=True)
    admin_instance = FeedAdmin(Feed, django_admin.site)
    request = rf.get("/admin/core/feed/")
    request.user = user

    actions = admin_instance.get_actions(request)

    assert all(name in actions for name in SUGGEST_ACTIONS)


@pytest.mark.django_db
def test_suggest_ignore_action_reports_the_change(rf, user):
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )
    admin_instance = FeedAdmin(Feed, None)
    request = rf.post("/admin/core/feed/")
    request.user = user
    messages = []

    with (
        patch(
            "core.admin.apply_suggested_selectors", return_value=([".ad"], ["aside"])
        ) as apply_suggestion,
        patch.object(
            FeedAdmin, "message_user", lambda self, req, msg, *a, **kw: messages.append(msg)
        ),
    ):
        admin_instance.suggest_ignore_selectors(request, Feed.objects.filter(pk=feed.pk))

    assert apply_suggestion.call_args.args[1] == "ignore"
    assert any("aside" in message for message in messages)


@pytest.mark.django_db
def test_suggest_action_reports_a_failure_without_touching_options(rf, user):
    feed = Feed.objects.create(
        name="Golem",
        aggregator="full_website",
        identifier="https://golem.de/rss.php",
        user=user,
        options={"content_selectors": ["article"]},
    )
    admin_instance = FeedAdmin(Feed, None)
    request = rf.post("/admin/core/feed/")
    request.user = user
    messages = []

    with (
        patch(
            "core.admin.apply_suggested_selectors",
            side_effect=SelectorSuggestionError("provider down"),
        ),
        patch.object(
            FeedAdmin, "message_user", lambda self, req, msg, *a, **kw: messages.append(msg)
        ),
    ):
        admin_instance.suggest_content_selectors(request, Feed.objects.filter(pk=feed.pk))

    feed.refresh_from_db()
    assert feed.options["content_selectors"] == ["article"]
    assert any("provider down" in message for message in messages)
