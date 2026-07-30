from unittest.mock import MagicMock, patch

import pytest
import requests

from core.aggregators.utils.html_fetcher import MAX_FETCH_BYTES, fetch_bytes, fetch_html


class TestHtmlFetcher:
    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_fetch_html_success(self, mock_get):
        mock_response = MagicMock()
        mock_response.text = "<html>Content</html>"
        mock_response.raise_for_status.return_value = None
        mock_get.return_value = mock_response

        result = fetch_html("https://example.com")

        assert result == "<html>Content</html>"
        mock_get.assert_called_once()
        # Verify headers
        args, kwargs = mock_get.call_args
        assert "User-Agent" in kwargs["headers"]
        assert "YanaBot" in kwargs["headers"]["User-Agent"]

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    @patch("core.aggregators.utils.html_fetcher.time.sleep")
    def test_fetch_html_retry_success(self, mock_sleep, mock_get):
        # Fail first, succeed second
        fail_response = MagicMock()
        fail_response.raise_for_status.side_effect = requests.RequestException("Fail")

        success_response = MagicMock()
        success_response.text = "Success"
        success_response.raise_for_status.return_value = None

        mock_get.side_effect = [requests.RequestException("Fail"), success_response]

        # Relies on default retries=3
        result = fetch_html("https://example.com")

        assert result == "Success"
        assert mock_get.call_count == 2
        assert mock_sleep.call_count == 1
        mock_sleep.assert_called_with(1)  # 2**0

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    @patch("core.aggregators.utils.html_fetcher.time.sleep")
    def test_fetch_html_max_retries_exceeded(self, mock_sleep, mock_get):
        mock_get.side_effect = requests.RequestException("Persistent Fail")

        with pytest.raises(requests.RequestException, match="Persistent Fail"):
            fetch_html("https://example.com")

        assert mock_get.call_count == 3
        assert mock_sleep.call_count == 2

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    @patch("core.aggregators.utils.html_fetcher.time.sleep")
    def test_fetch_html_timeout(self, mock_sleep, mock_get):
        # Mock sleep to avoid waiting during test
        mock_get.side_effect = requests.exceptions.Timeout("Timeout")

        with pytest.raises(requests.exceptions.Timeout):
            fetch_html("https://example.com")

        # Should try 3 times
        assert mock_get.call_count == 3
        assert mock_sleep.call_count == 2

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_fetch_html_fixes_iso8859_default_encoding(self, mock_get):
        """UTF-8 content with ISO-8859-1 default should use apparent_encoding."""
        utf8_text = "Ärger mit Übung und Straße"
        mock_response = MagicMock()
        mock_response.encoding = "ISO-8859-1"
        mock_response.apparent_encoding = "utf-8"
        mock_response.raise_for_status.return_value = None
        mock_response.text = utf8_text
        mock_get.return_value = mock_response

        result = fetch_html("https://example.com")

        assert result == utf8_text
        assert mock_response.encoding == "utf-8"

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_fetch_html_preserves_explicit_charset(self, mock_get):
        """When server explicitly sets charset, encoding should not be overridden."""
        mock_response = MagicMock()
        mock_response.encoding = "utf-8"
        mock_response.apparent_encoding = "utf-8"
        mock_response.text = "Content with ä ö ü"
        mock_response.raise_for_status.return_value = None
        mock_get.return_value = mock_response

        result = fetch_html("https://example.com")

        assert result == "Content with ä ö ü"
        assert mock_response.encoding == "utf-8"

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_fetch_html_fixes_latin1_alias_encoding(self, mock_get):
        """latin-1 alias should also trigger encoding correction."""
        mock_response = MagicMock()
        mock_response.encoding = "latin-1"
        mock_response.apparent_encoding = "utf-8"
        mock_response.text = "Ö"
        mock_response.raise_for_status.return_value = None
        mock_get.return_value = mock_response

        fetch_html("https://example.com")

        assert mock_response.encoding == "utf-8"


class TestFetchBytes:
    @staticmethod
    def _streaming_response(chunks, headers=None):
        response = MagicMock()
        response.headers = headers if headers is not None else {}
        response.raise_for_status.return_value = None
        response.iter_content.return_value = chunks
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        return response

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_fetch_bytes_returns_a_small_body(self, mock_get):
        mock_get.return_value = self._streaming_response([b"icon", b"-bytes"])

        assert fetch_bytes("https://example.com/favicon.ico") == b"icon-bytes"
        assert mock_get.call_args.kwargs["stream"] is True

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_fetch_bytes_refuses_an_oversized_body_without_reading_it_all(self, mock_get):
        chunk_size = 64 * 1024
        consumed = 0

        def endless_chunks():
            nonlocal consumed
            while True:
                consumed += 1
                yield b"x" * chunk_size

        mock_get.return_value = self._streaming_response(endless_chunks())

        with pytest.raises(requests.RequestException, match="too large"):
            fetch_bytes("https://example.com/huge.png")

        # Aborted as soon as the cap was passed rather than draining the stream.
        assert consumed <= MAX_FETCH_BYTES // chunk_size + 1

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_fetch_bytes_refuses_an_oversized_declared_length_without_a_read(self, mock_get):
        def unexpected_read(*args, **kwargs):
            raise AssertionError("the body must not be read when Content-Length is over the cap")

        response = self._streaming_response([])
        response.headers = {"Content-Length": str(MAX_FETCH_BYTES + 1)}
        response.iter_content.side_effect = unexpected_read
        mock_get.return_value = response

        with pytest.raises(requests.RequestException, match="too large"):
            fetch_bytes("https://example.com/huge.png")

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_fetch_bytes_ignores_a_malformed_content_length(self, mock_get):
        mock_get.return_value = self._streaming_response(
            [b"icon"], headers={"Content-Length": "not a number"}
        )

        assert fetch_bytes("https://example.com/favicon.ico") == b"icon"
