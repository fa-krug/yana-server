"""HTML fetching utilities with retry logic."""

import time

import requests

USER_AGENT = "Mozilla/5.0 (compatible; YanaBot/1.0; +https://github.com/yourusername/yana)"
DEFAULT_RETRIES = 3


def fetch_html(url: str, timeout: int = 30) -> str:
    """
    Fetch HTML content from URL with retry logic.

    Args:
        url: URL to fetch
        timeout: Request timeout in seconds

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
    retries = DEFAULT_RETRIES

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


def fetch_bytes(url: str, timeout: int = 30) -> bytes:
    """Fetch raw bytes from ``url`` (images, icons).

    Raises:
        requests.RequestException: If the request fails.
    """
    response = requests.get(
        url, headers={"User-Agent": USER_AGENT}, timeout=timeout, allow_redirects=True
    )
    response.raise_for_status()
    return response.content
