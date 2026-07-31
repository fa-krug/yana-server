"""
Django management command for testing header element extraction.

Usage:
    python manage.py test_header_extraction "https://www.youtube.com/watch?v=VIDEO_ID"
    python manage.py test_header_extraction "https://twitter.com/user/status/123456"
    python manage.py test_header_extraction "https://reddit.com/r/python/comments/abc/title"
"""

from django.core.management.base import BaseCommand

from core.aggregators.exceptions import ArticleSkipError
from core.aggregators.services.header_element import HeaderElementExtractor


class Command(BaseCommand):
    """Management command for testing header element extraction."""

    help = "Test header element extraction for a given URL"

    def add_arguments(self, parser):
        """Add command arguments."""
        parser.add_argument(
            "url",
            type=str,
            help="URL to extract header element from",
        )

        parser.add_argument(
            "--alt",
            type=str,
            default="Test Article Image",
            help="Alt text for extracted image (default: 'Test Article Image')",
        )

        parser.add_argument(
            "--verbose",
            action="store_true",
            help="Verbose output with detailed logs",
        )

    def handle(self, *args, **options):
        """Execute the command."""
        url = options["url"]
        alt = options["alt"]
        verbose = options["verbose"]

        self.stdout.write(self.style.HTTP_INFO(f"Testing header extraction for: {url}"))
        self.stdout.write(self.style.HTTP_INFO(f"Alt text: {alt}\n"))

        try:
            # Run extraction synchronously
            extractor = HeaderElementExtractor()
            header_element = extractor.extract_header_element(url, alt)

            if header_element:
                self.stdout.write(self.style.SUCCESS("✓ Successfully extracted header element!\n"))

                if verbose or len(header_element) < 500:
                    self.stdout.write("Header Element HTML:")
                    self.stdout.write("-" * 80)
                    self.stdout.write(header_element)
                    self.stdout.write("-" * 80)
                else:
                    # Truncate long output
                    truncated = header_element[:500] + "...[truncated]"
                    self.stdout.write("Header Element HTML (truncated):")
                    self.stdout.write("-" * 80)
                    self.stdout.write(truncated)
                    self.stdout.write("-" * 80)
                    self.stdout.write(
                        f"(Full length: {len(header_element)} characters. Use --verbose to see full output)"
                    )

            else:
                self.stdout.write(self.style.WARNING("⚠ No header element could be extracted"))
                self.stdout.write("This might mean:")
                self.stdout.write("  - The URL is not a recognized type (YouTube, Twitter, Reddit)")
                self.stdout.write("  - No images found on the page")
                self.stdout.write("  - Page is inaccessible or returned 4xx error")

        except ArticleSkipError as e:
            self.stdout.write(self.style.ERROR(f"✗ Article Skip Error (4xx HTTP error): {e}"))
            self.stdout.write(f"Status code: {e.status_code}")

        except Exception as e:
            self.stdout.write(self.style.ERROR(f"✗ Extraction failed with error: {e}"))

            if verbose:
                import traceback

                self.stdout.write("\nFull traceback:")
                self.stdout.write(traceback.format_exc())

        finally:
            self.stdout.write("\nTest completed.")


# Test URLs for reference
TEST_URLS = {
    "YouTube": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "Twitter": "https://twitter.com/NASA/status/1234567890",
    "Reddit": "https://reddit.com/r/python/comments/xyz/title",
    "Reddit Embed": "https://vxreddit.com/r/videos/comments/xyz/title",
    "Generic Article": "https://example.com/article",
}
