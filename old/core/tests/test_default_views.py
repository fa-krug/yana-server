from unittest.mock import patch

from django.test import Client, TestCase

import pytest


class TestDefaultViews(TestCase):
    def setUp(self):
        self.client = Client()

    def test_health_check_healthy(self):
        """Test health check returns 200 and healthy status."""
        with patch("django.db.connection.cursor"):
            response = self.client.get("/health/")

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"status": "healthy", "database": "connected"})

    def test_health_check_unhealthy(self):
        """Test health check returns 503 when db fails."""
        with patch("django.db.connection.cursor") as mock_cursor:
            mock_cursor.side_effect = Exception("DB Down")

            response = self.client.get("/health/")

            self.assertEqual(response.status_code, 503)
            data = response.json()
            self.assertEqual(data["status"], "unhealthy")
            self.assertEqual(data["error"], "DB Down")


class TestProxyViewsRemoved:
    """The embed proxies served HTML players for the GReader-era article body.
    Embeds are typed blocks now and the client plays them itself."""

    def test_the_youtube_proxy_route_is_gone(self, client):
        assert client.get("/api/youtube-proxy?v=abc").status_code in (301, 302, 404)

    def test_the_dailymotion_proxy_route_is_gone(self, client):
        assert client.get("/api/dailymotion-proxy?v=abc").status_code in (301, 302, 404)

    def test_the_views_are_no_longer_exported(self):
        import core.views

        assert not hasattr(core.views, "youtube_proxy_view")
        assert not hasattr(core.views, "dailymotion_proxy_view")

    @pytest.mark.django_db
    def test_health_check_still_works(self, client):
        assert client.get("/health/").status_code == 200
