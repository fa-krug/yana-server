"""
HTTP error detection utilities.

Provides functions to detect and extract HTTP error codes from various
exception types (requests library, Playwright, etc.).
"""

import re
from typing import Optional


def is_4xx_error(error: Exception) -> Optional[int]:
    """
    Check if an error is a 4xx HTTP error.

    Handles errors from both requests library and Playwright.
    4xx errors indicate client errors and should result in ArticleSkipError.

    Args:
        error: Exception to check

    Returns:
        HTTP status code (400-499) if 4xx error, None otherwise
    """
    # Check for requests library HTTPError
    if hasattr(error, "response") and error.response is not None:
        status_code = error.response.status_code
        if 400 <= status_code < 500:
            return status_code

    # Check for Playwright error messages containing status codes
    error_message = str(error)
    status_match = re.search(r"\b(40\d|41\d)\b", error_message)
    if status_match:
        status_code = int(status_match.group(1))
        if 400 <= status_code < 500:
            return status_code

    return None


def extract_http_status_from_error(error: Exception) -> Optional[int]:
    """
    Extract HTTP status code from various error types.

    Tries multiple methods to extract status code:
    1. error.response.status_code (requests)
    2. Regex pattern in error message
    3. Custom attributes

    Args:
        error: Exception to extract status from

    Returns:
        HTTP status code if found, None otherwise
    """
    # requests library
    if hasattr(error, "response") and hasattr(error.response, "status_code"):
        return error.response.status_code

    # Error message regex
    error_message = str(error)
    status_match = re.search(r"\b(\d{3})\b", error_message)
    if status_match:
        status_code = int(status_match.group(1))
        # Validate it's a real HTTP status code range
        if 100 <= status_code < 600:
            return status_code

    return None


def is_network_error(error: Exception) -> bool:
    """
    Check if error is a network-related error.

    Includes timeout, connection refused, DNS resolution failures, etc.

    Args:
        error: Exception to check

    Returns:
        True if network error, False otherwise
    """
    error_type = type(error).__name__
    error_message = str(error).lower()

    network_indicators = [
        "timeout",
        "connection",
        "network",
        "dns",
        "socket",
        "unreachable",
        "refused",
        "reset",
    ]

    return any(
        indicator in error_type.lower() or indicator in error_message
        for indicator in network_indicators
    )
