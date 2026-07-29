"""Guard tests: the Google Reader API stays deleted.

These assert absence. They exist so a future change cannot silently
reintroduce the GReader surface removed in Spec 0.
"""

from django.test import Client, TestCase
from django.urls import resolve


class TestGReaderRoutesRemoved(TestCase):
    """Old GReader paths must fall through to the catch-all admin redirect."""

    GREADER_PATHS = [
        "/api/greader/reader/api/0/user-info",
        "/api/greader/reader/api/0/token",
        "/api/greader/reader/api/0/subscription/list",
        "/api/greader/reader/api/0/stream/items/ids",
        "/api/greader/reader/api/0/unread-count",
        "/api/greader/reader/api/0/edit-tag",
        "/api/greader/accounts/ClientLogin",
    ]

    def setUp(self):
        self.client = Client()

    def test_greader_paths_redirect_to_admin(self):
        """No GReader path resolves to a GReader view; all redirect to admin."""
        for path in self.GREADER_PATHS:
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 302)
                self.assertEqual(response["Location"], "/admin/")

    def test_greader_paths_resolve_to_catch_all(self):
        """The resolved view is the catch-all redirect, not a GReader view."""
        for path in self.GREADER_PATHS:
            with self.subTest(path=path):
                match = resolve(path)
                self.assertEqual(match.func.__name__, "redirect_to_admin")

    def test_greader_url_namespace_is_gone(self):
        """reverse() on the retired 'greader' namespace must fail."""
        from django.urls import NoReverseMatch, reverse

        with self.assertRaises(NoReverseMatch):
            reverse("greader:user_info")
