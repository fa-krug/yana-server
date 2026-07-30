"""HTML fetching utilities with retry logic."""

import time

import requests

USER_AGENT = "Mozilla/5.0 (compatible; YanaBot/1.0; +https://github.com/yourusername/yana)"
DEFAULT_RETRIES = 3

# Hard cap for ``fetch_bytes``. The URL can come from a page the site itself
# controls (a declared <link rel="icon">), so an unbounded read is a cheap way
# for that site to make us buffer arbitrary amounts of memory. A favicon or
# apple-touch-icon above 2 MB is not a favicon.
MAX_FETCH_BYTES = 2 * 1024 * 1024
FETCH_CHUNK_SIZE = 64 * 1024


def fetch_html(url: str, timeout: int = 30, retries: int = DEFAULT_RETRIES) -> str:
    """
    Fetch HTML content from URL with retry logic.

    Args:
        url: URL to fetch
        timeout: Request timeout in seconds
        retries: Number of attempts before giving up (1 disables retrying)

    Returns:
        HTML content as string

    Raises:
        requests.RequestException: If fetch fails after retries
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
            response = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
            response.raise_for_status()

            # requests defaults to ISO-8859-1 for text/html without explicit
            # charset in Content-Type header (RFC 2616), breaking UTF-8 content
            # like German umlauts (ä → Ã¤). Use apparent_encoding to detect
            # the actual encoding from the response body.
            if response.encoding and response.encoding.lower() in (
                "iso-8859-1",
                "latin-1",
                "latin1",
            ):
                response.encoding = response.apparent_encoding

            return response.text

        except requests.RequestException as e:
            last_exception = e
            if attempt < retries - 1:
                wait_time = 2**attempt  # Exponential backoff
                time.sleep(wait_time)
            continue

    if last_exception:
        raise last_exception
    raise requests.RequestException(f"Failed to fetch {url} after {retries} retries")


def fetch_bytes(url: str, timeout: int = 30, max_bytes: int = MAX_FETCH_BYTES) -> bytes:
    """Fetch raw bytes from ``url`` (images, icons), never more than ``max_bytes``.

    The response is streamed so an oversized body is abandoned instead of being
    buffered: exceeding the cap raises ``requests.RequestException``, the same
    failure callers already handle for a dead URL.

    Raises:
        requests.RequestException: If the request fails or the body is too large.
    """
    with requests.get(
        url,
        headers={"User-Agent": USER_AGENT},
        timeout=timeout,
        allow_redirects=True,
        stream=True,
    ) as response:
        response.raise_for_status()

        declared = response.headers.get("Content-Length", "")
        if declared.isdigit() and int(declared) > max_bytes:
            raise requests.RequestException(
                f"Response from {url} is too large: {declared} bytes > {max_bytes}"
            )

        body = bytearray()
        for chunk in response.iter_content(FETCH_CHUNK_SIZE):
            body.extend(chunk)
            if len(body) > max_bytes:
                raise requests.RequestException(
                    f"Response from {url} is too large: over {max_bytes} bytes"
                )

        return bytes(body)
