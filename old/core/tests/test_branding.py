from django.contrib.staticfiles import finders
from django.test import TestCase
from django.urls import reverse


class BrandingTestCase(TestCase):
    """Test that branding assets exist and are correctly configured."""

    def test_icons_exist(self):
        """Verify that all required branding icons exist in static files."""
        icons = [
            "core/img/logo-wordmark.png",
            "core/img/logo-icon-only.png",
            "core/img/icon.png",
            "core/img/apple-touch-icon.png",
        ]
        for icon_path in icons:
            self.assertIsNotNone(
                finders.find(icon_path), f"Branding asset {icon_path} not found in static files"
            )

    def test_admin_login_branding(self):
        """Verify that the admin login page contains the logo."""
        response = self.client.get(reverse("admin:login"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "icon.png")
        self.assertContains(response, "apple-touch-icon.png")

    def test_admin_base_branding(self):
        """Verify that the admin base template contains the wordmark."""
        # Need to login to see admin index
        from django.contrib.auth.models import User

        user, created = User.objects.get_or_create(
            username="admin_test",
            defaults={"email": "admin_test@example.com", "is_staff": True, "is_superuser": True},
        )
        if created:
            user.set_password("password")
            user.save()

        self.client.login(username="admin_test", password="password")

        response = self.client.get(reverse("admin:index"))
        self.assertEqual(response.status_code, 200)
        # We now expect plaintext "Yana" instead of the image
        self.assertContains(response, "Yana")
        self.assertContains(response, "apple-touch-icon.png")
