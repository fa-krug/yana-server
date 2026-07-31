from unittest.mock import MagicMock, patch

from django.contrib.auth.models import User
from django.test import RequestFactory, TestCase

from core.forms import FeedAdminForm
from core.models import FeedGroup


class TestFeedAdminForm(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="formuser", password="password")
        self.group = FeedGroup.objects.create(name="Form Group", user=self.user)
        self.factory = RequestFactory()

    def test_init_pops_request(self):
        """Test that request is removed from kwargs in __init__."""
        request = self.factory.get("/")
        request.user = self.user

        # This would fail if request wasn't popped, as ModelForm doesn't accept 'request' kwarg
        form = FeedAdminForm(request=request)
        self.assertEqual(form.request, request)

    @patch("core.forms.store_feed_logo", return_value=False)
    @patch("core.forms.resolve_feed_url", side_effect=lambda identifier: identifier)
    @patch("core.aggregators.get_aggregator")
    def test_save_normalizes_identifier(
        self, mock_get_aggregator, mock_resolve_feed_url, mock_store_feed_logo
    ):
        """Test that saving the form normalizes the identifier."""
        # Setup mock aggregator
        mock_aggregator = MagicMock()
        mock_aggregator.normalize_identifier.return_value = "http://normalized.com/feed"
        mock_get_aggregator.return_value = mock_aggregator

        # Data for the form
        data = {
            "name": "Test Feed",
            "aggregator": "full_website",
            "identifier": "http://example.com/feed",
            "daily_limit": 20,
            "enabled": True,
            "user": self.user.pk,
            "group": self.group.pk,
            "options": "{}",
        }

        form = FeedAdminForm(data=data)
        self.assertTrue(form.is_valid(), form.errors)

        # Save form
        feed = form.save()

        # Verify normalization
        mock_aggregator.normalize_identifier.assert_called_with("http://example.com/feed")
        self.assertEqual(feed.identifier, "http://normalized.com/feed")

    @patch("core.forms.store_feed_logo", return_value=False)
    @patch("core.forms.resolve_feed_url", side_effect=lambda identifier: identifier)
    @patch("core.aggregators.get_aggregator")
    def test_save_handles_normalization_error(
        self, mock_get_aggregator, mock_resolve_feed_url, mock_store_feed_logo
    ):
        """Test that save continues if normalization fails."""
        mock_aggregator = MagicMock()
        mock_aggregator.normalize_identifier.side_effect = Exception("Normalization failed")
        mock_get_aggregator.return_value = mock_aggregator

        data = {
            "name": "Error Feed",
            "aggregator": "full_website",
            "identifier": "http://example.com/feed",
            "daily_limit": 20,
            "enabled": True,
            "user": self.user.pk,
            "group": self.group.pk,
            "options": "{}",
        }

        form = FeedAdminForm(data=data)
        self.assertTrue(form.is_valid())

        # Should not raise exception
        feed = form.save()

        # Identifier should remain original
        self.assertEqual(feed.identifier, "http://example.com/feed")
