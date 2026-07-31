from unittest.mock import MagicMock, patch

import requests

from core.ai_client import AIClient


def _make_settings(provider="gemini", max_retries=3, retry_delay=1, max_retry_time=60):
    """Create a mock UserSettings with AI configuration."""
    settings = MagicMock()
    settings.active_ai_provider = provider
    settings.ai_max_retries = max_retries
    settings.ai_retry_delay = retry_delay
    settings.ai_max_retry_time = max_retry_time
    settings.ai_request_timeout = 30
    settings.ai_temperature = 0.7
    settings.ai_max_tokens = 1000

    # Gemini
    settings.gemini_enabled = provider == "gemini"
    settings.gemini_api_key = "test-key"
    settings.gemini_model = "gemini-3-flash-preview"

    # OpenAI
    settings.openai_enabled = provider == "openai"
    settings.openai_api_key = "sk-test"
    settings.openai_model = "gpt-4o-mini"
    settings.openai_api_url = "https://api.openai.com/v1"

    # Anthropic
    settings.anthropic_enabled = provider == "anthropic"
    settings.anthropic_api_key = "sk-ant-test"
    settings.anthropic_model = "claude-sonnet-4-20250514"

    return settings


def _make_429_response():
    """Create a mock 429 response."""
    response = MagicMock(spec=requests.Response)
    response.status_code = 429
    response.text = "Too Many Requests"
    response.headers = {"Retry-After": "1"}
    http_error = requests.exceptions.HTTPError(
        "429 Client Error: Too Many Requests", response=response
    )
    response.raise_for_status.side_effect = http_error
    return response


def _make_success_response(body):
    """Create a mock successful response."""
    response = MagicMock(spec=requests.Response)
    response.status_code = 200
    response.raise_for_status.return_value = None
    response.json.return_value = body
    return response


class TestGeminiRetryOn429:
    @patch("core.ai_client.requests.post")
    def test_retries_on_429_then_succeeds(self, mock_post):
        """Gemini 429 should be retried and succeed on subsequent attempt."""
        settings = _make_settings(provider="gemini", max_retries=3, retry_delay=0)

        success_body = {"candidates": [{"content": {"parts": [{"text": "hello"}]}}]}
        mock_post.side_effect = [
            _make_429_response(),
            _make_success_response(success_body),
        ]

        client = AIClient(settings)
        result = client.generate_response("test prompt")

        assert result == "hello"
        assert mock_post.call_count == 2

    @patch("core.ai_client.requests.post")
    def test_returns_none_after_max_retries_exhausted(self, mock_post):
        """Should return None after exhausting all retries on persistent 429."""
        settings = _make_settings(provider="gemini", max_retries=3, retry_delay=0)

        mock_post.side_effect = [
            _make_429_response(),
            _make_429_response(),
            _make_429_response(),
            _make_429_response(),  # initial + 3 retries = 4 attempts
        ]

        client = AIClient(settings)
        result = client.generate_response("test prompt")

        assert result is None
        # 1 initial + 3 retries = 4
        assert mock_post.call_count == 4

    @patch("core.ai_client.requests.post")
    def test_no_retry_on_non_429_error(self, mock_post):
        """Non-429 errors should NOT be retried."""
        settings = _make_settings(provider="gemini", max_retries=3, retry_delay=0)

        response = MagicMock(spec=requests.Response)
        response.status_code = 500
        response.text = "Internal Server Error"
        response.raise_for_status.side_effect = requests.exceptions.HTTPError(
            "500 Server Error", response=response
        )
        mock_post.return_value = response

        client = AIClient(settings)
        result = client.generate_response("test prompt")

        assert result is None
        assert mock_post.call_count == 1

    @patch("core.ai_client.time.sleep")
    @patch("core.ai_client.requests.post")
    def test_backoff_delay_increases(self, mock_post, mock_sleep):
        """Retry delay should increase exponentially."""
        settings = _make_settings(provider="gemini", max_retries=3, retry_delay=2)

        success_body = {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}
        mock_post.side_effect = [
            _make_429_response(),
            _make_429_response(),
            _make_success_response(success_body),
        ]

        client = AIClient(settings)
        result = client.generate_response("test prompt")

        assert result == "ok"
        # First retry: delay * 1 = 2, second retry: delay * 2 = 4
        assert mock_sleep.call_count == 2
        mock_sleep.assert_any_call(2)
        mock_sleep.assert_any_call(4)

    @patch("core.ai_client.requests.post")
    def test_zero_retries_means_no_retry(self, mock_post):
        """With max_retries=0, no retry should be attempted."""
        settings = _make_settings(provider="gemini", max_retries=0, retry_delay=0)

        mock_post.return_value = _make_429_response()

        client = AIClient(settings)
        result = client.generate_response("test prompt")

        assert result is None
        assert mock_post.call_count == 1

    @patch("core.ai_client.time.monotonic")
    @patch("core.ai_client.time.sleep")
    @patch("core.ai_client.requests.post")
    def test_stops_retrying_when_time_budget_exceeded(self, mock_post, mock_sleep, mock_mono):
        """Should stop retrying if next sleep would exceed max_retry_time."""
        settings = _make_settings(
            provider="gemini", max_retries=5, retry_delay=2, max_retry_time=10
        )

        mock_post.side_effect = [
            _make_429_response(),
            _make_429_response(),
        ]

        # start=0; after 1st 429: elapsed=3, wait=2(2^0)=2, 3+2=5<10 → sleep & retry
        # after 2nd 429: elapsed=7, wait=2(2^1)=4, 7+4=11>10 → budget exceeded, raise
        mock_mono.side_effect = [0, 3, 7]

        client = AIClient(settings)
        result = client.generate_response("test prompt")

        assert result is None
        assert mock_post.call_count == 2
        assert mock_sleep.call_count == 1


class TestOpenAIRetryOn429:
    @patch("core.ai_client.requests.post")
    def test_retries_on_429_then_succeeds(self, mock_post):
        """OpenAI 429 should be retried and succeed on subsequent attempt."""
        settings = _make_settings(provider="openai", max_retries=3, retry_delay=0)

        success_body = {"choices": [{"message": {"content": "hello"}}]}
        mock_post.side_effect = [
            _make_429_response(),
            _make_success_response(success_body),
        ]

        client = AIClient(settings)
        result = client.generate_response("test prompt")

        assert result == "hello"
        assert mock_post.call_count == 2


class TestAnthropicRetryOn429:
    @patch("core.ai_client.requests.post")
    def test_retries_on_429_then_succeeds(self, mock_post):
        """Anthropic 429 should be retried and succeed on subsequent attempt."""
        settings = _make_settings(provider="anthropic", max_retries=3, retry_delay=0)

        success_body = {"content": [{"text": "hello"}]}
        mock_post.side_effect = [
            _make_429_response(),
            _make_success_response(success_body),
        ]

        client = AIClient(settings)
        result = client.generate_response("test prompt")

        assert result == "hello"
        assert mock_post.call_count == 2
