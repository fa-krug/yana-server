from unittest.mock import patch

from django.test import Client, TestCase, override_settings


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

    def test_youtube_proxy_view_missing_id(self):
        """Test proxy view requires video ID."""
        response = self.client.get("/api/youtube-proxy")
        self.assertEqual(response.status_code, 400)
        self.assertIn("Missing video ID", response.content.decode())

    def test_youtube_proxy_view_success(self):
        """Test proxy view returns embed HTML."""
        response = self.client.get("/api/youtube-proxy?v=dQw4w9WgXcQ")
        self.assertEqual(response.status_code, 200)
        content = response.content.decode()
        self.assertIn("youtube-nocookie.com/embed/dQw4w9WgXcQ", content)
        self.assertIn("autoplay=0", content)

    def test_youtube_proxy_view_params(self):
        """Test proxy view passes parameters correctly."""
        url = "/api/youtube-proxy?v=test&autoplay=1&loop=1"
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        content = response.content.decode()
        self.assertIn("autoplay=1", content)
        self.assertIn("loop=1", content)
        # Playlist param is added when loop is 1
        self.assertIn("playlist=test", content)

    def test_youtube_proxy_sends_referrer_policy_header(self):
        """YouTube rejects embeds with error 153 when no Referer reaches it."""
        response = self.client.get("/api/youtube-proxy?v=dQw4w9WgXcQ")
        self.assertEqual(response["Referrer-Policy"], "strict-origin-when-cross-origin")

    def test_dailymotion_proxy_sends_referrer_policy_header(self):
        """The Dailymotion embed page uses the same referrer policy."""
        response = self.client.get("/api/dailymotion-proxy?v=x8abcde")
        self.assertEqual(response["Referrer-Policy"], "strict-origin-when-cross-origin")

    def test_error_page_sends_referrer_policy_header(self):
        """The error page is served through the same response helper."""
        response = self.client.get("/api/youtube-proxy")
        self.assertEqual(response["Referrer-Policy"], "strict-origin-when-cross-origin")

    def test_youtube_proxy_omits_jsapi_by_default(self):
        """Without the IFrame API there is no origin for YouTube to reject."""
        response = self.client.get("/api/youtube-proxy?v=dQw4w9WgXcQ")
        content = response.content.decode()
        self.assertNotIn("enablejsapi", content)
        self.assertNotIn("origin=", content)

    @override_settings(
        BASE_URL="https://yana.example.com", ALLOWED_HOSTS=["yana.example.com", "testserver"]
    )
    def test_youtube_proxy_jsapi_opt_in_adds_origin(self):
        """enablejsapi=1 re-enables the API together with a matching origin."""
        response = self.client.get(
            "/api/youtube-proxy?v=dQw4w9WgXcQ&enablejsapi=1",
            headers={"host": "yana.example.com"},
        )
        content = response.content.decode()
        self.assertIn("enablejsapi=1", content)
        self.assertIn("origin=https%3A%2F%2Fyana.example.com", content)

    @override_settings(
        BASE_URL="https://yana.example.com", ALLOWED_HOSTS=["yana.example.com", "testserver"]
    )
    def test_youtube_proxy_origin_uses_base_url_scheme(self):
        """A proxy that drops X-Forwarded-Proto must not downgrade the origin."""
        response = self.client.get(
            "/api/youtube-proxy?v=dQw4w9WgXcQ&enablejsapi=1",
            headers={"host": "yana.example.com"},
            secure=False,
        )
        content = response.content.decode()
        self.assertIn("origin=https%3A%2F%2Fyana.example.com", content)
        self.assertNotIn("origin=http%3A%2F%2Fyana.example.com", content)

    @override_settings(
        BASE_URL="https://yana.example.com", ALLOWED_HOSTS=["yana.example.com", "testserver"]
    )
    def test_youtube_proxy_origin_falls_back_to_request_host(self):
        """Requests to another host still get their own origin, not BASE_URL's."""
        response = self.client.get(
            "/api/youtube-proxy?v=dQw4w9WgXcQ&enablejsapi=1",
            headers={"host": "testserver"},
        )
        content = response.content.decode()
        self.assertIn("origin=http%3A%2F%2Ftestserver", content)
