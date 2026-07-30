"""
Tests for the Feed admin 'Save as new' functionality.

This test module verifies that the 'Save as new' feature in Django admin
properly preserves feed data when creating a new feed based on an existing one.
"""

from django.urls import reverse

import pytest

from core.models import Feed, FeedGroup


@pytest.fixture(autouse=True)
def _no_network_resolve(monkeypatch):
    """Keep identifier resolution a no-op here.

    ``test_feed`` uses the ``feed_content`` aggregator, which resolves feed
    URLs on save (see ``FeedAdminForm.clean_identifier``). These tests are
    about 'Save as new' field preservation, not resolution, so patch
    ``resolve_feed_url`` to the identity function to avoid a real network
    call to ``https://example.com/feed.xml``.
    """
    monkeypatch.setattr("core.forms.resolve_feed_url", lambda identifier: identifier)


@pytest.fixture
def admin_client(admin_user, client):
    """Create an authenticated admin client."""
    client.force_login(admin_user)
    return client


@pytest.fixture
def test_feed_group(admin_user):
    """Create a test feed group."""
    return FeedGroup.objects.create(name="Test Group", user=admin_user)


@pytest.fixture
def test_feed(admin_user, test_feed_group):
    """Create a test feed with various options set."""
    return Feed.objects.create(
        name="Original Test Feed",
        aggregator="feed_content",  # Use valid aggregator type from AGGREGATOR_CHOICES
        identifier="https://example.com/feed.xml",
        daily_limit=15,
        enabled=True,
        user=admin_user,
        group=test_feed_group,
        options={
            "ai_summarize": True,
            "ai_translate": True,
            "ai_translate_language": "German",
        },
    )


@pytest.mark.django_db
class TestFeedSaveAsNew:
    """Tests for Feed admin 'Save as new' functionality."""

    def test_edit_form_contains_aggregator_field(self, admin_client, test_feed):
        """
        Verify that the edit form contains the aggregator field.

        The aggregator field must be present (even as hidden input) so that
        its value is submitted when 'Save as new' is clicked.
        """
        url = reverse("admin:core_feed_change", args=[test_feed.pk])
        response = admin_client.get(url)

        assert response.status_code == 200
        content = response.content.decode("utf-8")

        # The aggregator field should be present in the form
        # It may be as a hidden input or as a visible select
        assert 'name="aggregator"' in content, (
            "Aggregator field is missing from the form. "
            "'Save as new' will fail because the aggregator value won't be submitted."
        )

    def test_save_as_new_creates_new_feed(self, admin_client, test_feed):
        """
        Verify that 'Save as new' creates a new feed with the submitted data.
        """
        url = reverse("admin:core_feed_change", args=[test_feed.pk])

        # Prepare POST data simulating 'Save as new' form submission
        post_data = {
            "_saveasnew": "Save as new",
            "name": "Copied Feed via Save As New",
            "aggregator": test_feed.aggregator,
            "identifier": test_feed.identifier,
            "daily_limit": test_feed.daily_limit,
            "enabled": "on" if test_feed.enabled else "",
            "user": test_feed.user_id,
            "group": test_feed.group_id if test_feed.group else "",
            # AI fields
            "ai_summarize": "on",
            "ai_improve_writing": "",
            "ai_translate": "on",
            "ai_translate_language": "German",
        }

        initial_count = Feed.objects.count()
        response = admin_client.post(url, post_data, follow=True)

        assert response.status_code == 200

        # Check that a new feed was created
        new_count = Feed.objects.count()
        assert new_count == initial_count + 1, (
            f"Expected {initial_count + 1} feeds, but found {new_count}. "
            "'Save as new' did not create a new feed."
        )

        # Verify the new feed exists with the correct name
        new_feed = Feed.objects.filter(name="Copied Feed via Save As New").first()
        assert new_feed is not None, "New feed was not created with expected name."

    def test_save_as_new_preserves_aggregator(self, admin_client, test_feed):
        """
        Verify that 'Save as new' preserves the aggregator value.

        This was a known issue where the aggregator field was not being
        submitted because it was rendered as a readonly display instead
        of a form field.
        """
        url = reverse("admin:core_feed_change", args=[test_feed.pk])

        post_data = {
            "_saveasnew": "Save as new",
            "name": "Aggregator Test Feed",
            "aggregator": test_feed.aggregator,
            "identifier": test_feed.identifier,
            "daily_limit": test_feed.daily_limit,
            "enabled": "on",
            "user": test_feed.user_id,
            "group": test_feed.group_id if test_feed.group else "",
        }

        response = admin_client.post(url, post_data, follow=True)
        assert response.status_code == 200

        # Check for validation errors in response
        content = response.content.decode("utf-8")
        assert "This field is required" not in content, (
            "Form validation failed with 'This field is required'. "
            "The aggregator field value is likely not being submitted."
        )

        new_feed = Feed.objects.filter(name="Aggregator Test Feed").first()
        assert new_feed is not None, "New feed was not created."
        assert new_feed.aggregator == test_feed.aggregator, (
            f"Aggregator mismatch: expected '{test_feed.aggregator}', got '{new_feed.aggregator}'."
        )

    def test_save_as_new_preserves_all_fields(self, admin_client, test_feed):
        """
        Verify that 'Save as new' preserves all important field values.
        """
        url = reverse("admin:core_feed_change", args=[test_feed.pk])

        post_data = {
            "_saveasnew": "Save as new",
            "name": "Full Copy Test Feed",
            "aggregator": test_feed.aggregator,
            "identifier": test_feed.identifier,
            "daily_limit": test_feed.daily_limit,
            "enabled": "on" if test_feed.enabled else "",
            "user": test_feed.user_id,
            "group": test_feed.group_id if test_feed.group else "",
            # AI fields from options
            "ai_summarize": "on",
            "ai_improve_writing": "",
            "ai_translate": "on",
            "ai_translate_language": "German",
        }

        response = admin_client.post(url, post_data, follow=True)
        assert response.status_code == 200

        new_feed = Feed.objects.filter(name="Full Copy Test Feed").first()
        assert new_feed is not None, "New feed was not created."

        # Verify all fields were copied correctly
        assert new_feed.aggregator == test_feed.aggregator
        assert new_feed.identifier == test_feed.identifier
        assert new_feed.daily_limit == test_feed.daily_limit
        assert new_feed.user_id == test_feed.user_id
        assert new_feed.group_id == test_feed.group_id

    def test_save_as_new_preserves_ai_options(self, admin_client, test_feed):
        """
        Verify that 'Save as new' preserves AI configuration options.
        """
        url = reverse("admin:core_feed_change", args=[test_feed.pk])

        post_data = {
            "_saveasnew": "Save as new",
            "name": "AI Options Test Feed",
            "aggregator": test_feed.aggregator,
            "identifier": test_feed.identifier,
            "daily_limit": test_feed.daily_limit,
            "enabled": "on",
            "user": test_feed.user_id,
            "group": test_feed.group_id if test_feed.group else "",
            # AI fields
            "ai_summarize": "on",
            "ai_improve_writing": "",
            "ai_translate": "on",
            "ai_translate_language": "German",
        }

        response = admin_client.post(url, post_data, follow=True)
        assert response.status_code == 200

        new_feed = Feed.objects.filter(name="AI Options Test Feed").first()
        assert new_feed is not None, "New feed was not created."

        # Verify AI options were saved
        assert new_feed.options is not None, "Options field is None."
        assert new_feed.options.get("ai_summarize") is True, (
            f"ai_summarize not preserved: got {new_feed.options.get('ai_summarize')}"
        )
        assert new_feed.options.get("ai_translate") is True, (
            f"ai_translate not preserved: got {new_feed.options.get('ai_translate')}"
        )
        assert new_feed.options.get("ai_translate_language") == "German", (
            f"ai_translate_language not preserved: got {new_feed.options.get('ai_translate_language')}"
        )

    def test_save_as_new_does_not_modify_original(self, admin_client, test_feed):
        """
        Verify that 'Save as new' does not modify the original feed.
        """
        original_name = test_feed.name
        original_id = test_feed.pk

        url = reverse("admin:core_feed_change", args=[test_feed.pk])

        post_data = {
            "_saveasnew": "Save as new",
            "name": "New Feed Name",
            "aggregator": test_feed.aggregator,
            "identifier": "https://different-url.com/feed.xml",
            "daily_limit": 999,
            "enabled": "",  # disabled
            "user": test_feed.user_id,
            "group": "",
        }

        response = admin_client.post(url, post_data, follow=True)
        assert response.status_code == 200

        # Reload original feed from database
        test_feed.refresh_from_db()

        # Verify original was not modified
        assert test_feed.pk == original_id
        assert test_feed.name == original_name
        assert test_feed.identifier == "https://example.com/feed.xml"
        assert test_feed.daily_limit == 15
        assert test_feed.enabled is True

    def test_save_as_new_redirects_to_changelist(self, admin_client, test_feed):
        """
        Verify that 'Save as new' redirects to the changelist, not the edit page.
        """
        url = reverse("admin:core_feed_change", args=[test_feed.pk])

        post_data = {
            "_saveasnew": "Save as new",
            "name": "Redirect Test Feed",
            "aggregator": test_feed.aggregator,
            "identifier": test_feed.identifier,
            "daily_limit": test_feed.daily_limit,
            "enabled": "on",
            "user": test_feed.user_id,
            "group": test_feed.group_id if test_feed.group else "",
        }

        # Don't follow redirects to check the redirect target
        response = admin_client.post(url, post_data, follow=False)

        # Should redirect (302) to changelist
        assert response.status_code == 302
        changelist_url = reverse("admin:core_feed_changelist")
        assert response.url == changelist_url, (
            f"Expected redirect to {changelist_url}, got {response.url}"
        )
