"""
Aggregator exceptions.

Custom exceptions used throughout the aggregator system for error handling
and article processing flow control.
"""


class AggregatorError(Exception):
    """Base exception for all aggregator errors."""

    pass


class ArticleSkipError(AggregatorError):
    """
    Exception indicating that an article should be skipped.

    Thrown when a 4xx HTTP error is encountered during article processing.
    The article should not be retried and should be silently skipped.

    Attributes:
        message: Error description
        status_code: HTTP status code (4xx)
        original_error: Original exception that caused this error
    """

    def __init__(
        self,
        message: str,
        status_code: int = 400,
        original_error: Exception | None = None,
    ):
        """
        Initialize ArticleSkipError.

        Args:
            message: Human-readable error message
            status_code: HTTP status code (typically 4xx)
            original_error: Original exception for context
        """
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.original_error = original_error

    def __str__(self):
        return f"{self.status_code}: {self.message}"


class ContentFetchError(AggregatorError):
    """Exception raised when content fetching fails."""

    pass


class ParseError(AggregatorError):
    """Exception raised when parsing fails."""

    pass


class ValidationError(AggregatorError):
    """Exception raised when validation fails."""

    pass
