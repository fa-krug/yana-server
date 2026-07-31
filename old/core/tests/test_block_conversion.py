"""convert_article: the one parse -> store -> plain_text entry point."""

import io
import logging
import random
from unittest.mock import MagicMock, Mock, patch

import pytest
import requests
from PIL import Image

from core.aggregators.services import image_store
from core.blocks.conversion import _localize_body_images, convert_article
from core.blocks.storage import load_blocks
from core.blocks.types import (
    Blockquote,
    Heading,
    ImageBlock,
    InlineRun,
    ListBlock,
    Paragraph,
)
from core.models import Article, ArticleBlock, ArticleImage

BODY = '<h2>Head</h2><p>Body <a href="/rel">link</a></p>'


def _tiny_png(size: tuple[int, int] = (1, 1)) -> bytes:
    """A real, tiny PNG at exactly ``size`` pixels -- a stand-in for a
    tracking pixel, well under compress_image's 5KB compression floor."""
    img = Image.new("RGB", size, (255, 0, 0))
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    data = buffer.getvalue()
    assert len(data) < 5000
    return data


def _png_bytes(seed: int = 0, size: tuple[int, int] = (300, 300)) -> bytes:
    """A deterministic PNG big enough to clear compression's 5KB floor.

    Duplicated from ``test_image_store.py``'s ``noisy_png`` rather than
    imported cross-file (no precedent for that in this suite): true
    pseudo-random pixels defeat PNG's row-filter compression, which a linear
    gradient would not reliably do.
    """
    width, height = size
    rng = random.Random(seed)
    img = Image.new("RGB", size)
    img.putdata(
        [
            (rng.randrange(256), rng.randrange(256), rng.randrange(256))
            for _ in range(width * height)
        ]
    )
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()


def _mock_response(*, content_type: str, content: bytes) -> Mock:
    response = Mock()
    response.raise_for_status = Mock()
    response.headers = {"Content-Type": content_type}
    response.content = content
    return response


def _mock_http_error_response(status_code: int) -> Mock:
    error = requests.exceptions.HTTPError()
    error.response = Mock(status_code=status_code)
    response = Mock()
    response.raise_for_status = Mock(side_effect=error)
    return response


@pytest.fixture(autouse=True)
def isolated_media_root(settings, tmp_path):
    """Never write test images into the repository's media/ directory."""
    settings.MEDIA_ROOT = str(tmp_path / "media")
    return tmp_path / "media"


@pytest.mark.django_db
def test_converting_stores_the_tree(article):
    article.content = BODY
    article.identifier = "https://example.com/news/story"
    article.save()

    written = convert_article(article)

    assert written == 2
    assert load_blocks(article) == [
        Heading(level=2, runs=[InlineRun(text="Head")]),
        Paragraph(
            runs=[
                InlineRun(text="Body "),
                InlineRun(text="link", link="https://example.com/rel"),
            ]
        ),
    ]


@pytest.mark.django_db
def test_converting_populates_plain_text(article):
    article.content = BODY
    article.save()
    convert_article(article)
    assert Article.objects.get(pk=article.pk).plain_text == "Head\n\nBody link"


@pytest.mark.django_db
def test_links_resolve_against_the_article_identifier(article):
    article.content = '<p><a href="/x">l</a></p>'
    article.identifier = "https://example.com/a/b"
    article.save()
    convert_article(article)
    assert load_blocks(article)[0].runs[0].link == "https://example.com/x"


@pytest.mark.django_db
def test_converting_twice_is_idempotent(article):
    article.content = BODY
    article.save()
    convert_article(article)
    first = load_blocks(article)
    convert_article(article)
    assert load_blocks(article) == first
    assert ArticleBlock.objects.filter(article=article).count() == 2


@pytest.mark.django_db
def test_empty_content_stores_nothing_and_clears_plain_text(article):
    article.content = ""
    article.plain_text = "stale"
    article.save()
    assert convert_article(article) == 0
    assert Article.objects.get(pk=article.pk).plain_text == ""


@pytest.mark.django_db
def test_a_parser_failure_leaves_the_article_blockless_and_does_not_raise(article, caplog):
    article.content = BODY
    article.save()
    # settings.py's LOGGING sets `"core": {"propagate": False}`, so records
    # from `core.blocks.conversion` never reach caplog's root-attached handler
    # by propagation alone -- attach it here directly.
    conversion_logger = logging.getLogger("core.blocks.conversion")
    conversion_logger.addHandler(caplog.handler)
    try:
        with (
            caplog.at_level("WARNING", logger="core.blocks.conversion"),
            patch("core.blocks.conversion.blocks_from_html", side_effect=RuntimeError("boom")),
        ):
            assert convert_article(article) == 0
    finally:
        conversion_logger.removeHandler(caplog.handler)
    assert load_blocks(article) == []
    assert str(article.pk) in caplog.text


@pytest.mark.django_db
def test_the_footer_no_longer_produces_a_trailing_url_paragraph(article):
    """Task 7's removal, verified end to end."""
    from core.aggregators.utils import format_article_content

    article.content = format_article_content(
        "<p>body</p>", title="T", url="https://example.com/story"
    )
    article.save()
    convert_article(article)
    assert load_blocks(article) == [Paragraph(runs=[InlineRun(text="body")])]


@pytest.mark.django_db
def test_a_hosted_image_reference_lands_in_image_ref(article):
    """Not a test of <header> semantics -- just a convenient image-bearing
    fixture. Deliberately NOT wrapped in <header>: that wrapper is now a
    structurally-dropped, non-recursed tag (see block_parser's DROPPED_TAGS),
    since it duplicates the article's own Article.icon -- wrapping the image
    here would make it vanish from the blocks entirely instead of landing in
    image_ref."""
    ref = "yana-img://" + "a" * 64
    article.content = f'<img src="{ref}" alt="T"><p>body</p>'
    article.save()
    convert_article(article)
    assert load_blocks(article)[0] == ImageBlock(ref=ref)
    assert ArticleBlock.objects.filter(image_ref=ref).exists()


@pytest.mark.django_db
class TestBodyImageLocalization:
    """Defect 2: body images (outside the header/icon path) were never
    downloaded and stored -- ``convert_article`` kept the raw remote ref
    forever. This is the localization pass that fixes it, added right after
    parsing and before ``write_blocks``."""

    def test_a_remote_image_is_downloaded_and_its_ref_replaced_with_a_hash(self, article):
        data = _png_bytes(seed=1)
        article.content = '<p>lead</p><img src="https://example.com/photo.png">'
        article.save()

        with patch.object(
            image_store,
            "fetch_image_outcome",
            return_value={"imageData": data, "contentType": "image/png"},
        ):
            convert_article(article)

        blocks = load_blocks(article)
        image_block = next(b for b in blocks if isinstance(b, ImageBlock))
        assert image_block.ref.startswith("yana-img://")

        stored = ArticleImage.objects.get(content_hash=image_block.ref.removeprefix("yana-img://"))
        # Compression prefers WebP output (see `compress_image`'s `PREFER_WEBP`)
        # -- the fetched content type is the *input*, not what gets stored.
        assert stored.content_type == "image/webp"
        assert stored.width is not None
        assert stored.height is not None

    def test_an_already_localized_ref_is_untouched_and_never_fetched(self, article):
        ref = "yana-img://" + "b" * 64
        article.content = f'<img src="{ref}">'
        article.save()

        mock_fetch = MagicMock()
        with patch.object(image_store, "fetch_image_outcome", mock_fetch):
            convert_article(article)

        assert load_blocks(article) == [ImageBlock(ref=ref)]
        mock_fetch.assert_not_called()

    def test_the_same_remote_url_twice_is_fetched_once_and_shares_one_row(self, article):
        data = _png_bytes(seed=2)
        article.content = (
            '<img src="https://example.com/dup.png">'
            "<p>middle</p>"
            '<img src="https://example.com/dup.png">'
        )
        article.save()

        mock_fetch = MagicMock(return_value={"imageData": data, "contentType": "image/png"})
        with patch.object(image_store, "fetch_image_outcome", mock_fetch):
            convert_article(article)

        image_blocks = [b for b in load_blocks(article) if isinstance(b, ImageBlock)]
        assert len(image_blocks) == 2
        assert image_blocks[0].ref == image_blocks[1].ref
        assert image_blocks[0].ref.startswith("yana-img://")
        assert mock_fetch.call_count == 1
        assert ArticleImage.objects.count() == 1

    def test_remote_images_nested_in_a_list_item_and_a_blockquote_are_both_localized(self, article):
        data = _png_bytes(seed=3)
        article.content = (
            '<ul><li><img src="https://example.com/in-list.png"></li></ul>'
            '<blockquote><p>quoted</p><img src="https://example.com/in-quote.png"></blockquote>'
        )
        article.save()

        with patch.object(
            image_store,
            "fetch_image_outcome",
            return_value={"imageData": data, "contentType": "image/png"},
        ):
            convert_article(article)

        blocks = load_blocks(article)
        list_block = next(b for b in blocks if isinstance(b, ListBlock))
        list_image = next(b for b in list_block.items[0] if isinstance(b, ImageBlock))
        quote_block = next(b for b in blocks if isinstance(b, Blockquote))
        quote_image = next(b for b in quote_block.blocks if isinstance(b, ImageBlock))

        assert list_image.ref.startswith("yana-img://")
        assert quote_image.ref.startswith("yana-img://")

    def test_a_failed_download_keeps_the_remote_ref_and_the_rest_of_the_body_survives(
        self, article
    ):
        article.content = '<p>before</p><img src="https://example.com/broken.png"><p>after</p>'
        article.save()

        with patch.object(image_store, "fetch_image_outcome", return_value=None):
            written = convert_article(article)

        blocks = load_blocks(article)
        assert written == 3
        image_block = next(b for b in blocks if isinstance(b, ImageBlock))
        assert image_block.ref == "https://example.com/broken.png"
        assert [b for b in blocks if isinstance(b, Paragraph)][0].runs[0].text == "before"
        assert [b for b in blocks if isinstance(b, Paragraph)][1].runs[0].text == "after"
        assert ArticleImage.objects.count() == 0

    def test_a_store_exception_is_swallowed_and_the_remote_ref_survives(self, article, caplog):
        """Graceful degradation covers more than a clean ``None`` return --
        an unexpected exception out of the store (e.g. a hash collision) must
        not escape and fail the whole conversion either."""
        article.content = '<img src="https://example.com/boom.png">'
        article.save()
        conversion_logger = logging.getLogger("core.blocks.conversion")
        conversion_logger.addHandler(caplog.handler)
        try:
            with (
                caplog.at_level("WARNING", logger="core.blocks.conversion"),
                patch(
                    "core.blocks.conversion.store_body_image_ref_from_url",
                    side_effect=RuntimeError("boom"),
                ),
            ):
                convert_article(article)
        finally:
            conversion_logger.removeHandler(caplog.handler)

        blocks = load_blocks(article)
        assert blocks == [ImageBlock(ref="https://example.com/boom.png")]

    def test_localize_body_images_skips_non_http_refs_without_fetching(self):
        """Direct unit test of the localization pass itself: `data:` URIs and
        empty refs must never reach the fetcher, regardless of whether the
        parser can currently produce them (it doesn't, per Defect 1 -- this
        is a defense-in-depth check on the pass's own contract)."""
        blocks = [
            ImageBlock(ref="data:image/png;base64,AAAA"),
            ImageBlock(ref=""),
        ]
        mock_fetch = MagicMock()
        with patch.object(image_store, "fetch_image_outcome", mock_fetch):
            _localize_body_images(blocks)

        assert blocks[0].ref == "data:image/png;base64,AAAA"
        assert blocks[1].ref == ""
        mock_fetch.assert_not_called()


@pytest.mark.django_db
class TestTrackingPixelDropped:
    """A tracking pixel (fetched and decoded successfully, then rejected by
    the store for being 1x1 -- see image_store.TRACKING_PIXEL_MAX_DIMENSION)
    must disappear from the tree entirely, unlike a genuine fetch/decode
    failure, which keeps the remote ref (TestBodyImageLocalization's
    ``test_a_failed_download_keeps_the_remote_ref...`` covers that case and
    must keep passing unchanged)."""

    def test_a_pixel_between_two_paragraphs_leaves_both_intact_and_no_gap(self, article):
        pixel = _tiny_png()
        article.content = '<p>before</p><img src="https://vgwort.example/beacon"><p>after</p>'
        article.save()

        with patch.object(
            image_store,
            "fetch_image_outcome",
            return_value={"imageData": pixel, "contentType": "image/png"},
        ):
            written = convert_article(article)

        blocks = load_blocks(article)
        assert blocks == [
            Paragraph(runs=[InlineRun(text="before")]),
            Paragraph(runs=[InlineRun(text="after")]),
        ]
        assert not any(isinstance(b, ImageBlock) for b in blocks)
        assert written == 2
        assert ArticleImage.objects.count() == 0

        positions = list(
            ArticleBlock.objects.filter(article=article, parent__isnull=True)
            .order_by("position")
            .values_list("position", flat=True)
        )
        assert positions == [0, 1], "root positions must stay 0-based and contiguous after a drop"

    def test_a_body_that_is_only_a_pixel_has_no_image_block_and_does_not_error(self, article):
        pixel = _tiny_png()
        article.content = '<img src="https://vgwort.example/beacon">'
        article.save()

        with patch.object(
            image_store,
            "fetch_image_outcome",
            return_value={"imageData": pixel, "contentType": "image/png"},
        ):
            written = convert_article(article)

        assert load_blocks(article) == []
        assert written == 0
        assert ArticleImage.objects.count() == 0
        assert ArticleBlock.objects.filter(article=article).count() == 0

    def test_a_pixel_nested_in_a_list_item_and_a_blockquote_is_dropped_there_too(self, article):
        pixel = _tiny_png()
        article.content = (
            '<ul><li><img src="https://vgwort.example/in-list"><p>kept</p></li></ul>'
            '<blockquote><p>quoted</p><img src="https://vgwort.example/in-quote"></blockquote>'
        )
        article.save()

        with patch.object(
            image_store,
            "fetch_image_outcome",
            return_value={"imageData": pixel, "contentType": "image/png"},
        ):
            convert_article(article)

        blocks = load_blocks(article)
        list_block = next(b for b in blocks if isinstance(b, ListBlock))
        quote_block = next(b for b in blocks if isinstance(b, Blockquote))

        assert not any(isinstance(b, ImageBlock) for b in list_block.items[0])
        assert not any(isinstance(b, ImageBlock) for b in quote_block.blocks)
        assert list_block.items[0] == [Paragraph(runs=[InlineRun(text="kept")])]
        assert quote_block.blocks == [Paragraph(runs=[InlineRun(text="quoted")])]
        assert ArticleImage.objects.count() == 0

    def test_a_normal_image_is_still_localized_after_the_tracking_pixel_check(self, article):
        """Regression guard: the drop-on-rejection path must not affect a
        real image's localization."""
        data = _png_bytes(seed=59)
        article.content = '<img src="https://example.com/real.png">'
        article.save()

        with patch.object(
            image_store,
            "fetch_image_outcome",
            return_value={"imageData": data, "contentType": "image/png"},
        ):
            convert_article(article)

        blocks = load_blocks(article)
        assert len(blocks) == 1
        assert isinstance(blocks[0], ImageBlock)
        assert blocks[0].ref.startswith("yana-img://")
        assert ArticleImage.objects.count() == 1


@pytest.mark.django_db
class TestDefinitiveNonImageDropped:
    """The refinement beyond the 1x1 dimension check: a resource that the
    fetch itself conclusively identifies as not an image -- wrong
    Content-Type, an empty body, or bytes Pillow cannot decode -- must be
    dropped exactly like a tracking pixel (see
    image_extraction.fetcher.NonImageResponse), not kept as a dead remote
    ref. The real-world case (a caschys_blog article) is a VG Wort
    tracking-pixel URL that redirects to a zero-length `text/html` response:
    it will never become an image, so "keep the ref and hope a retry fixes
    it" only means every render still leaks the reader's IP to the tracker.

    Exercised through the real HTTP layer (`requests.get` mocked, not
    `image_store.fetch_image_outcome`) so these are true end-to-end checks
    of the widened fetch path, including the transient-failure regression
    guards, which must NOT be reclassified as definitive."""

    def test_a_redirected_empty_html_response_is_dropped(self, article):
        """The actual caschys_blog/VG Wort shape: `requests` follows the 302
        (we pass `allow_redirects=True`) to a final response that is
        `text/html` and empty."""
        article.content = (
            '<p>before</p><img src="https://vg08.met.vgwort.de/na/beacon"><p>after</p>'
        )
        article.save()
        response = _mock_response(content_type="text/html", content=b"")

        with patch("requests.get", return_value=response):
            written = convert_article(article)

        blocks = load_blocks(article)
        assert blocks == [
            Paragraph(runs=[InlineRun(text="before")]),
            Paragraph(runs=[InlineRun(text="after")]),
        ]
        assert written == 2
        assert ArticleImage.objects.count() == 0

    def test_a_200_html_response_is_dropped(self, article):
        article.content = '<img src="https://example.com/not-an-image">'
        article.save()
        response = _mock_response(content_type="text/html", content=b"<html></html>" * 10)

        with patch("requests.get", return_value=response):
            convert_article(article)

        assert load_blocks(article) == []
        assert ArticleImage.objects.count() == 0

    def test_corrupt_bytes_with_an_image_content_type_are_dropped(self, article):
        """The server's Content-Type is only a claim -- this pins that we
        actually try to decode the bytes rather than trusting the header."""
        article.content = '<img src="https://example.com/corrupt.png">'
        article.save()
        garbage = b"not a real png, just padding to clear the size floor" * 3
        response = _mock_response(content_type="image/png", content=garbage)

        with patch("requests.get", return_value=response):
            convert_article(article)

        assert load_blocks(article) == []
        assert ArticleImage.objects.count() == 0

    def test_a_connection_timeout_preserves_the_remote_ref(self, article):
        """Regression guard on the deliberate contract: a transient failure
        must keep the remote ref, not be reclassified as definitive."""
        article.content = '<img src="https://example.com/slow.png">'
        article.save()

        with patch("requests.get", side_effect=requests.exceptions.Timeout()):
            convert_article(article)

        assert load_blocks(article) == [ImageBlock(ref="https://example.com/slow.png")]
        assert ArticleImage.objects.count() == 0

    def test_a_503_preserves_the_remote_ref(self, article):
        """Same deliberate contract, this time via an HTTP error status."""
        article.content = '<img src="https://example.com/unavailable.png">'
        article.save()
        response = _mock_http_error_response(503)

        with patch("requests.get", return_value=response):
            convert_article(article)

        assert load_blocks(article) == [ImageBlock(ref="https://example.com/unavailable.png")]
        assert ArticleImage.objects.count() == 0

    def test_a_normal_image_is_still_localized_end_to_end(self, article):
        """Regression guard exercised through the real HTTP layer (not a
        mocked `fetch_image_outcome`): the widened fetch path -- including
        its new Pillow-decode check -- must not regress the ordinary
        success case."""
        data = _png_bytes(seed=61)
        article.content = '<img src="https://example.com/real.png">'
        article.save()
        response = _mock_response(content_type="image/png", content=data)

        with patch("requests.get", return_value=response):
            convert_article(article)

        blocks = load_blocks(article)
        assert len(blocks) == 1
        assert isinstance(blocks[0], ImageBlock)
        assert blocks[0].ref.startswith("yana-img://")
        assert ArticleImage.objects.count() == 1
