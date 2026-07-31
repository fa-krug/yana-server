from unittest.mock import MagicMock, patch

from django.conf import settings as django_settings

import requests

from core.ai_client import AIClient


def _make_settings(provider="gemini"):
    s = MagicMock()
    s.active_ai_provider = provider
    s.ai_max_retries = 0
    s.ai_retry_delay = 0
    s.ai_request_timeout = 30
    s.ai_temperature = 0.7
    s.ai_max_tokens = 1000
    s.gemini_enabled = True
    s.gemini_api_key = "test-key"
    s.gemini_model = "gemini-3-flash-preview"
    s.openai_enabled = provider == "openai"
    s.openai_api_key = "sk-test"
    s.openai_model = "gpt-4o-mini"
    s.openai_api_url = "https://api.openai.com/v1"
    s.anthropic_enabled = provider == "anthropic"
    s.anthropic_api_key = "sk-ant-test"
    s.anthropic_model = "claude-sonnet-4-20250514"
    return s


class TestCoreLoggerConfig:
    def test_core_logger_does_not_have_mail_admins_handler(self):
        """The core logger must NOT use mail_admins to avoid SMTP hangs in workers."""
        logging_config = django_settings.LOGGING
        core_logger = logging_config["loggers"]["core"]
        assert "mail_admins" not in core_logger["handlers"]


class TestAIClientLogLevels:
    @patch("core.ai_client.requests.post")
    def test_gemini_request_error_logs_warning_not_error(self, mock_post):
        """Request errors should log at WARNING, not ERROR."""
        response = MagicMock(spec=requests.Response)
        response.status_code = 429
        response.text = "Too Many Requests"
        response.raise_for_status.side_effect = requests.exceptions.HTTPError(
            "429 Client Error", response=response
        )
        mock_post.return_value = response
        client = AIClient(_make_settings())
        with patch("core.ai_client.logger") as mock_logger:
            client.generate_response("test")
            for call in mock_logger.error.call_args_list:
                msg = call[0][0] if call[0] else ""
                assert "Request Error" not in msg
                assert "API call failed" not in msg
