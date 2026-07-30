from unittest.mock import MagicMock, patch

import pytest
import requests

from core.aggregators.utils.favicon import is_same_site
from core.aggregators.utils.html_fetcher import (
    MAX_FETCH_BYTES,
    MAX_HTML_BYTES,
    MAX_REDIRECTS,
    fetch_bytes,
    fetch_html,
)


class FakeResponse:
    """Stand-in for a streamed ``requests.Response``.

    Faithful where ``fetch_html`` leans on it: ``iter_content`` yields the body in
    chunks and ``text`` decodes whatever the fetcher put back into ``_content``,
    so a test sees the bytes actually read rather than a canned string.
    """

    def __init__(
        self,
        body: bytes = b"",
        *,
        headers: dict | None = None,
        encoding: str | None = None,
        apparent_encoding: str = "utf-8",
        chunks=None,
    ):
        self.headers = headers if headers is not None else {}
        self.encoding = encoding
        self.apparent_encoding = apparent_encoding
        self.is_redirect = False
        self._chunks = [body] if chunks is None else chunks
        self._content: bytes | bool = False
        self.chunks_read = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def raise_for_status(self):
        return None

    def iter_content(self, chunk_size):
        for chunk in self._chunks:
            self.chunks_read += 1
            yield chunk

    @property
    def text(self) -> str:
        assert self._content is not False, "the body was decoded before it was read"
        assert isinstance(self._content, bytes)
        return str(self._content, self.encoding or "utf-8", errors="replace")


class TestHtmlFetcher:
    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_fetch_html_success(self, mock_get):
        mock_get.return_value = FakeResponse(b"<html>Content</html>", encoding="utf-8")

        result = fetch_html("https://example.com")

        assert result == "<html>Content</html>"
        mock_get.assert_called_once()
        kwargs = mock_get.call_args.kwargs
        assert "User-Agent" in kwargs["headers"]
        assert "YanaBot" in kwargs["headers"]["User-Agent"]
        # Streamed so the read can be abandoned once it passes the cap.
        assert kwargs["stream"] is True

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    @patch("core.aggregators.utils.html_fetcher.time.sleep")
    def test_fetch_html_retry_success(self, mock_sleep, mock_get):
        mock_get.side_effect = [
            requests.RequestException("Fail"),
            FakeResponse(b"Success", encoding="utf-8"),
        ]

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
        response = FakeResponse(
            utf8_text.encode("utf-8"), encoding="ISO-8859-1", apparent_encoding="utf-8"
        )
        mock_get.return_value = response

        result = fetch_html("https://example.com")

        assert result == utf8_text
        assert response.encoding == "utf-8"

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_fetch_html_preserves_explicit_charset(self, mock_get):
        """When server explicitly sets charset, encoding should not be overridden."""
        response = FakeResponse("Content with ä ö ü".encode(), encoding="utf-8")
        mock_get.return_value = response

        result = fetch_html("https://example.com")

        assert result == "Content with ä ö ü"
        assert response.encoding == "utf-8"

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_fetch_html_fixes_latin1_alias_encoding(self, mock_get):
        """latin-1 alias should also trigger encoding correction."""
        response = FakeResponse("Ö".encode(), encoding="latin-1", apparent_encoding="utf-8")
        mock_get.return_value = response

        assert fetch_html("https://example.com") == "Ö"
        assert response.encoding == "utf-8"

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    @patch("core.aggregators.utils.html_fetcher.time.sleep")
    def test_fetch_html_refuses_an_oversized_body_without_reading_it_all(
        self, mock_sleep, mock_get
    ):
        chunk_size = 64 * 1024

        def endless_chunks():
            while True:
                yield b"x" * chunk_size

        response = FakeResponse(chunks=endless_chunks(), encoding="utf-8")
        mock_get.return_value = response

        with pytest.raises(requests.RequestException, match="too large"):
            fetch_html("https://example.com")

        # Abandoned as soon as the cap was passed rather than buffering the page.
        assert response.chunks_read <= MAX_HTML_BYTES // chunk_size + 1
        # And not retried: the same oversized body would only be downloaded again.
        assert mock_get.call_count == 1
        mock_sleep.assert_not_called()

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_fetch_html_refuses_an_oversized_declared_length_without_a_read(self, mock_get):
        response = FakeResponse(b"<html>", headers={"Content-Length": str(MAX_HTML_BYTES + 1)})
        mock_get.return_value = response

        with pytest.raises(requests.RequestException, match="too large"):
            fetch_html("https://example.com")

        assert response.chunks_read == 0

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_fetch_html_honours_a_caller_supplied_cap(self, mock_get):
        mock_get.return_value = FakeResponse(b"x" * 200, encoding="utf-8")

        with pytest.raises(requests.RequestException, match="too large"):
            fetch_html("https://example.com", retries=1, max_bytes=100)


class TestFetchBytes:
    @staticmethod
    def _streaming_response(chunks, headers=None):
        response = MagicMock()
        response.headers = headers if headers is not None else {}
        response.is_redirect = False
        response.raise_for_status.return_value = None
        response.iter_content.return_value = chunks
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        return response

    @staticmethod
    def _redirect_response(location):
        response = MagicMock()
        response.is_redirect = True
        response.headers = {"Location": location}
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


class TestFetchBytesRedirects:
    """The host a caller pinned a download to has to survive the redirect chain."""

    _streaming_response = staticmethod(TestFetchBytes._streaming_response)
    _redirect_response = staticmethod(TestFetchBytes._redirect_response)

    @staticmethod
    def _on_example_com(candidate: str) -> bool:
        return is_same_site(candidate, "https://example.com/")

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_follows_a_redirect_hop_by_hop(self, mock_get):
        mock_get.side_effect = [
            self._redirect_response("https://example.com/static/icon.png"),
            self._streaming_response([b"icon"]),
        ]

        assert fetch_bytes("https://example.com/favicon.ico") == b"icon"
        assert [call.args[0] for call in mock_get.call_args_list] == [
            "https://example.com/favicon.ico",
            "https://example.com/static/icon.png",
        ]
        # requests must not follow them for us -- a hop it followed is a hop we
        # could no longer refuse.
        assert all(call.kwargs["allow_redirects"] is False for call in mock_get.call_args_list)

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_resolves_a_relative_location(self, mock_get):
        mock_get.side_effect = [
            self._redirect_response("/static/icon.png"),
            self._streaming_response([b"icon"]),
        ]

        assert fetch_bytes("https://example.com/favicon.ico") == b"icon"
        assert mock_get.call_args_list[1].args[0] == "https://example.com/static/icon.png"

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_never_requests_a_hop_that_leaves_the_allowed_site(self, mock_get):
        """The redirect target must not be requested at all -- that request *is* the SSRF."""
        mock_get.side_effect = [
            self._redirect_response("http://169.254.169.254/latest/meta-data/"),
            self._streaming_response([b"cloud-credentials"]),
        ]

        with pytest.raises(requests.RequestException, match="not on the site"):
            fetch_bytes("https://example.com/favicon.ico", is_allowed_url=self._on_example_com)

        assert mock_get.call_count == 1

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_allows_a_redirect_within_the_site(self, mock_get):
        mock_get.side_effect = [
            self._redirect_response("https://static.example.com/icon.png"),
            self._streaming_response([b"icon"]),
        ]

        result = fetch_bytes("https://example.com/favicon.ico", is_allowed_url=self._on_example_com)

        assert result == b"icon"
        assert mock_get.call_count == 2

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_refuses_the_first_url_when_it_is_not_allowed(self, mock_get):
        with pytest.raises(requests.RequestException, match="not on the site"):
            fetch_bytes("http://169.254.169.254/latest/meta-data/", is_allowed_url=lambda _: False)

        mock_get.assert_not_called()

    @patch("core.aggregators.utils.html_fetcher.requests.get")
    def test_gives_up_on_an_endless_redirect_chain(self, mock_get):
        mock_get.side_effect = lambda *args, **kwargs: self._redirect_response(
            "https://example.com/next"
        )

        with pytest.raises(requests.TooManyRedirects):
            fetch_bytes("https://example.com/favicon.ico")

        assert mock_get.call_count == MAX_REDIRECTS + 1
