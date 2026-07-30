"""Tests for the domain image override system."""

from unittest.mock import patch

import pytest

from core.aggregators.reddit.images import extract_header_image_url
from core.aggregators.reddit.types import RedditPostData
from core.aggregators.services.header_element.extractor import HeaderElementExtractor
from core.aggregators.services.image_extraction.domain_overrides import (
    DOMAIN_IMAGE_OVERRIDES,
    get_override_image_url,
)
from core.aggregators.services.image_extraction.extractor import ImageExtractor

NINTENDO_SUPPORT_URL = "https://en-americas-support.nintendo.com/app/answers/detail/a_id/71525/"
NINTENDO_OVERRIDE_IMAGE = "https://upload.wikimedia.org/wikipedia/commons/0/0d/Nintendo.svg"


class TestGetOverrideImageUrl:
    """Tests for the get_override_image_url helper."""

    def test_nintendo_support_url_resolves_to_wikipedia_logo(self):
        assert get_override_image_url(NINTENDO_SUPPORT_URL) == NINTENDO_OVERRIDE_IMAGE

    def test_nintendo_domain_root_resolves_to_wikipedia_logo(self):
        assert (
            get_override_image_url("https://en-americas-support.nintendo.com/")
            == NINTENDO_OVERRIDE_IMAGE
        )

    def test_unrelated_url_returns_none(self):
        assert get_override_image_url("https://example.com/article/1") is None

    def test_empty_url_returns_none(self):
        assert get_override_image_url("") is None
        assert get_override_image_url(None) is None

    def test_default_mapping_contains_nintendo_entry(self):
        assert "https://en-americas-support.nintendo.com/" in DOMAIN_IMAGE_OVERRIDES
        assert (
            DOMAIN_IMAGE_OVERRIDES["https://en-americas-support.nintendo.com/"]
            == NINTENDO_OVERRIDE_IMAGE
        )

    def test_longest_prefix_wins(self):
        with patch.dict(
            DOMAIN_IMAGE_OVERRIDES,
            {
                "https://example.com/": "https://cdn.example.com/general.png",
                "https://example.com/blog/": "https://cdn.example.com/blog.png",
            },
            clear=False,
        ):
            assert (
                get_override_image_url("https://example.com/about")
                == "https://cdn.example.com/general.png"
            )
            assert (
                get_override_image_url("https://example.com/blog/post-1")
                == "https://cdn.example.com/blog.png"
            )


class TestImageExtractorOverride:
    """Tests for the ImageExtractor integration."""

    def test_override_short_circuits_strategy_chain(self):
        extractor = ImageExtractor()

        fake_image = {"imageData": b"fake-bytes", "contentType": "image/svg+xml"}
        with (
            patch(
                "core.aggregators.services.image_extraction.extractor.fetch_single_image",
                return_value=fake_image,
            ) as mock_fetch,
            patch.object(extractor.strategies[0], "extract") as mock_strategy_extract,
        ):
            result = extractor.extract_image_from_url(NINTENDO_SUPPORT_URL)

        assert result is not None
        assert result["imageUrl"] == NINTENDO_OVERRIDE_IMAGE
        assert result["imageData"] == b"fake-bytes"
        mock_fetch.assert_called_once_with(NINTENDO_OVERRIDE_IMAGE)
        mock_strategy_extract.assert_not_called()

    def test_override_falls_back_when_fetch_fails(self):
        """If the override image fetch fails, fall through to normal extraction."""
        extractor = ImageExtractor()

        with (
            patch(
                "core.aggregators.services.image_extraction.extractor.fetch_single_image",
                return_value=None,
            ),
            patch.object(
                ImageExtractor,
                "_fetch_and_parse_page",
                return_value=None,
            ),
        ):
            result = extractor.extract_image_from_url(NINTENDO_SUPPORT_URL)

        assert result is None


class TestHeaderElementExtractorOverride:
    """Tests for the HeaderElementExtractor integration."""

    def test_override_short_circuits_strategies(self):
        fake_image = {"imageData": b"x" * 200, "contentType": "image/svg+xml"}
        stored_hash = "ab" * 32

        extractor = HeaderElementExtractor()
        with (
            patch(
                "core.aggregators.services.header_element.extractor.fetch_single_image",
                return_value=fake_image,
            ) as mock_fetch,
            patch(
                "core.aggregators.services.header_element.extractor.store_image_bytes",
                return_value=stored_hash,
            ) as mock_store,
            patch.object(extractor.strategies[0], "create") as mock_strategy_create,
        ):
            result = extractor.extract_header_element(NINTENDO_SUPPORT_URL)

        assert result is not None
        assert result.image_url == NINTENDO_OVERRIDE_IMAGE
        assert result.content_hash == stored_hash
        assert result.image_ref == f"yana-img://{stored_hash}"
        assert result.content_type == "image/svg+xml"
        mock_fetch.assert_called_once_with(NINTENDO_OVERRIDE_IMAGE)
        mock_store.assert_called_once()
        mock_strategy_create.assert_not_called()

    def test_override_fetch_failure_falls_through_to_strategies(self):
        extractor = HeaderElementExtractor()
        with (
            patch(
                "core.aggregators.services.header_element.extractor.fetch_single_image",
                return_value=None,
            ),
            patch.object(extractor.strategies[-1], "can_handle", return_value=False),
            patch.object(extractor.strategies[0], "can_handle", return_value=False),
            patch.object(extractor.strategies[1], "can_handle", return_value=False),
            patch.object(extractor.strategies[2], "can_handle", return_value=False),
        ):
            result = extractor.extract_header_element(NINTENDO_SUPPORT_URL)

        assert result is None


class TestRedditOverrideIntegration:
    """Reddit's extract_header_image_url honours domain overrides."""

    def _make_post(self, url: str) -> RedditPostData:
        return RedditPostData(
            {
                "url": url,
                "is_self": False,
                "selftext": "",
                "permalink": "/r/Nintendo/comments/abc/foo/",
                "title": "Nintendo support post",
                "author": "tester",
                "created_utc": 1700000000,
                "num_comments": 0,
            }
        )

    def test_nintendo_support_url_uses_override(self):
        post = self._make_post(NINTENDO_SUPPORT_URL)

        result = extract_header_image_url(post)

        assert result == NINTENDO_OVERRIDE_IMAGE

    def test_non_overridden_url_unaffected(self):
        post = self._make_post("https://example.com/article/1")
        # Without preview/thumbnail data the function should not return the
        # override image (it should follow its normal priority chain instead).
        result = extract_header_image_url(post)
        assert result != NINTENDO_OVERRIDE_IMAGE


@pytest.mark.parametrize(
    "url,expected",
    [
        (NINTENDO_SUPPORT_URL, NINTENDO_OVERRIDE_IMAGE),
        ("https://en-americas-support.nintendo.com/foo/bar", NINTENDO_OVERRIDE_IMAGE),
        ("https://other.example.com/foo", None),
    ],
)
def test_get_override_image_url_parametrized(url, expected):
    assert get_override_image_url(url) == expected
