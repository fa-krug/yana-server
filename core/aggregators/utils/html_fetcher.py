"""HTML fetching utilities with retry logic."""

import time
from collections.abc import Callable
from urllib.parse import urljoin

import requests

USER_AGENT = "Mozilla/5.0 (compatible; YanaBot/1.0; +https://github.com/yourusername/yana)"
DEFAULT_RETRIES = 3

# Hard cap for ``fetch_bytes``. The URL can come from a page the site itself
# controls (a declared <link rel="icon">), so an unbounded read is a cheap way
# for that site to make us buffer arbitrary amounts of memory. A favicon or
# apple-touch-icon above 2 MB is not a favicon.
MAX_FETCH_BYTES = 2 * 1024 * 1024

# Same reasoning for ``fetch_html``, which buffers the whole page before parsing
# and runs on the request path (icon lookup, feed discovery, selector
# suggestion). Generous rather than tight -- the cap is there to stop an endless
# body, not to police page weight.
MAX_HTML_BYTES = 8 * 1024 * 1024

FETCH_CHUNK_SIZE = 64 * 1024

# Redirect hops ``fetch_bytes`` will follow. Two is already unusual for an icon
# or a feed; the limit only has to keep a redirect loop from spinning.
MAX_REDIRECTS = 5

ISO_8859_1_ALIASES = ("iso-8859-1", "latin-1", "latin1")


class ResponseTooLarge(requests.RequestException):
    """A body went over the caller's cap.

    A ``RequestException`` so every caller that already treats a failed fetch as
    "no content" handles it without new branches.
    """


class DisallowedRedirect(requests.RequestException):
    """A hop left the site the caller pinned the fetch to. Also a ``RequestException``."""


def _reject_oversized_declaration(response: requests.Response, url: str, max_bytes: int) -> None:
    """Fail on an honest ``Content-Length`` over the cap, before reading a byte."""
    declared = response.headers.get("Content-Length", "")
    if declared.isdigit() and int(declared) > max_bytes:
        raise ResponseTooLarge(f"Response from {url} is too large: {declared} bytes > {max_bytes}")


def _read_capped(response: requests.Response, url: str, max_bytes: int) -> bytes:
    """Body of ``response``, abandoned as soon as it passes ``max_bytes``.

    ``response`` must have been requested with ``stream=True``; an oversized body
    is then never fully buffered.
    """
    _reject_oversized_declaration(response, url, max_bytes)

    body = bytearray()
    for chunk in response.iter_content(FETCH_CHUNK_SIZE):
        body.extend(chunk)
        if len(body) > max_bytes:
            raise ResponseTooLarge(f"Response from {url} is too large: over {max_bytes} bytes")

    return bytes(body)


def fetch_html(
    url: str,
    timeout: int = 30,
    retries: int = DEFAULT_RETRIES,
    max_bytes: int = MAX_HTML_BYTES,
) -> str:
    """
    Fetch HTML content from URL with retry logic.

    Args:
        url: URL to fetch
        timeout: Request timeout in seconds
        retries: Number of attempts before giving up (1 disables retrying)
        max_bytes: Refuse a body larger than this (see ``MAX_HTML_BYTES``)

    Returns:
        HTML content as string

    Raises:
        requests.RequestException: If fetch fails after retries, or if the body
            is over ``max_bytes`` (``ResponseTooLarge``, raised without retrying).
    """
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    }

    last_exception: requests.RequestException | None = None
    retries = max(1, retries)

    for attempt in range(retries):
        try:
            with requests.get(
                url,
                headers=headers,
                timeout=timeout,
                allow_redirects=True,
                stream=True,
            ) as response:
                response.raise_for_status()

                # Read the body ourselves so it stays bounded, then hand it back
                # to the response: `.text` and `.apparent_encoding` below are
                # requests' own decoding, and this is exactly what `.content`
                # would have stored had we let it read the body unbounded.
                response._content = _read_capped(response, url, max_bytes)
                response._content_consumed = True  # type: ignore[attr-defined]

                # requests defaults to ISO-8859-1 for text/html without explicit
                # charset in Content-Type header (RFC 2616), breaking UTF-8 content
                # like German umlauts (ä → Ã¤). Use apparent_encoding to detect
                # the actual encoding from the response body.
                if response.encoding and response.encoding.lower() in ISO_8859_1_ALIASES:
                    response.encoding = response.apparent_encoding

                return response.text

        except ResponseTooLarge:
            # Deterministic: a retry would download the same oversized body again.
            raise
        except requests.RequestException as e:
            last_exception = e
            if attempt < retries - 1:
                wait_time = 2**attempt  # Exponential backoff
                time.sleep(wait_time)
            continue

    if last_exception:
        raise last_exception
    raise requests.RequestException(f"Failed to fetch {url} after {retries} retries")


def fetch_bytes(
    url: str,
    timeout: int = 30,
    max_bytes: int = MAX_FETCH_BYTES,
    is_allowed_url: Callable[[str], bool] | None = None,
) -> bytes:
    """Fetch raw bytes from ``url`` (images, icons), never more than ``max_bytes``.

    The response is streamed so an oversized body is abandoned instead of being
    buffered: exceeding the cap raises ``requests.RequestException``, the same
    failure callers already handle for a dead URL.

    Redirects are followed by hand rather than by requests so that
    ``is_allowed_url``, when given, can veto a hop *before* it is requested --
    letting requests follow them would issue the off-site request first and leave
    nothing to check but the aftermath, which is the whole point of a blind SSRF.
    Every URL is checked, including ``url`` itself, so the caller's host rule
    holds end to end (see ``favicon.is_same_site``).

    Raises:
        requests.RequestException: If the request fails, the body is too large,
            a hop is not allowed, or the redirect chain is too long.
    """
    target = url

    for _ in range(MAX_REDIRECTS + 1):
        if is_allowed_url is not None and not is_allowed_url(target):
            raise DisallowedRedirect(f"Refusing to fetch {target}: not on the site {url} is on")

        with requests.get(
            target,
            headers={"User-Agent": USER_AGENT},
            timeout=timeout,
            allow_redirects=False,
            stream=True,
        ) as response:
            if response.is_redirect:
                target = urljoin(target, response.headers["Location"])
                continue

            response.raise_for_status()
            return _read_capped(response, target, max_bytes)

    raise requests.TooManyRedirects(f"Too many redirects fetching {url}")
