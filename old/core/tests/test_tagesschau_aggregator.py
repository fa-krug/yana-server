import json
from unittest.mock import patch

import pytest
from bs4 import BeautifulSoup

from core.aggregators.tagesschau.aggregator import _MEDIA_HEADER_CACHE_KEY, TagesschauAggregator
from core.aggregators.tagesschau.media_processor import extract_media_header


@pytest.mark.django_db
class TestTagesschauAggregator:
    @pytest.fixture
    def tages_agg(self, rss_feed):
        rss_feed.aggregator = "tagesschau"
        rss_feed.identifier = "https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml"
        return TagesschauAggregator(rss_feed)

    def test_default_identifier(self, rss_feed):
        rss_feed.identifier = ""
        agg = TagesschauAggregator(rss_feed)
        assert (
            agg.identifier == "https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml"
        )

    def test_filter_articles_skips_livestream(self, tages_agg):
        articles = [
            {"name": "Normal News", "identifier": "url1", "date": None},
            {"name": "Livestream: Corona", "identifier": "url2", "date": None},
        ]
        with patch(
            "core.aggregators.website.FullWebsiteAggregator.filter_articles",
            side_effect=lambda x: x,
        ):
            filtered = tages_agg.filter_articles(articles)

        assert len(filtered) == 1
        assert filtered[0]["name"] == "Normal News"

    def test_filter_articles_skips_podcasts(self, tages_agg):
        articles = [
            {"name": "Normal News", "identifier": "url1", "date": None},
            {"name": "11KM-Podcast: Topic", "identifier": "url2", "date": None},
        ]
        with patch(
            "core.aggregators.website.FullWebsiteAggregator.filter_articles",
            side_effect=lambda x: x,
        ):
            filtered = tages_agg.filter_articles(articles)

        assert len(filtered) == 1
        assert filtered[0]["name"] == "Normal News"

    def test_filter_articles_skips_videos(self, tages_agg):
        articles = [
            {
                "name": "Normal News",
                "identifier": "https://www.tagesschau.de/news-100.html",
                "date": None,
            },
            {
                "name": "Video News",
                "identifier": "https://www.tagesschau.de/video/video-100.html",
                "date": None,
            },
        ]
        # Test with skip_videos = True (default)
        with patch(
            "core.aggregators.website.FullWebsiteAggregator.filter_articles",
            side_effect=lambda x: x,
        ):
            filtered = tages_agg.filter_articles(articles)

        assert len(filtered) == 1
        assert filtered[0]["name"] == "Normal News"

        # Test with skip_videos = False
        tages_agg.feed.options["skip_videos"] = False
        with patch(
            "core.aggregators.website.FullWebsiteAggregator.filter_articles",
            side_effect=lambda x: x,
        ):
            filtered = tages_agg.filter_articles(articles)

        assert len(filtered) == 2

    @patch("core.aggregators.tagesschau.aggregator.extract_tagesschau_content")
    def test_extract_content(self, mock_extract, tages_agg):
        mock_extract.return_value = "Specialized Content"
        result = tages_agg.extract_content("<html></html>", {"name": "Test"})
        assert result == "Specialized Content"
        mock_extract.assert_called_once()

    @patch("core.aggregators.tagesschau.aggregator.extract_media_header")
    def test_process_content_adds_media_header(self, mock_media, tages_agg):
        mock_media.return_value = "<video>Header</video>"

        with patch(
            "core.aggregators.website.FullWebsiteAggregator.process_content",
            side_effect=lambda x, y: x,
        ):
            processed = tages_agg.process_content("Body", {"name": "Test", "raw_content": "raw"})

        assert "<video>Header</video>Body" in processed

    # A3: regional feeds syndicate items that link straight to an external ARD
    # broadcaster page (mdr.de, ndr.de, ...) whose template carries none of
    # tagesschau.de's textabsatz/MediaPlayer markup.
    BROADCASTER_BODY = (
        "Der Landtag hat am Mittwoch nach langer Debatte einen Nachtragshaushalt "
        "beschlossen, der vor allem den Kommunen zugutekommen soll."
    )

    def test_extract_content_uses_the_generic_tier_for_broadcaster_pages(self, tages_agg):
        html = f"<html><body><article><p>{self.BROADCASTER_BODY}</p></article></body></html>"

        result = tages_agg.extract_content(
            html,
            {"name": "T", "identifier": "https://www.mdr.de/a", "content": "<p>rss teaser</p>"},
        )

        assert self.BROADCASTER_BODY in result

    def test_extract_content_falls_back_to_rss_below_the_generic_floor(self, tages_agg):
        """A container holding only a byline must lose to the RSS summary."""
        html = "<html><body><article><p>Von Jan Mueller</p></article></body></html>"

        result = tages_agg.extract_content(
            html,
            {"name": "T", "identifier": "https://www.ndr.de/a", "content": "<p>rss teaser</p>"},
        )

        assert result == "<p>rss teaser</p>"

    def test_extract_content_falls_back_to_rss_for_container_less_widgets(self, tages_agg):
        """The DWD weather-warning pages have no generic container at all."""
        html = "<html><body><div class='widget'>Warnlagebericht</div></body></html>"

        result = tages_agg.extract_content(
            html,
            {
                "name": "T",
                "identifier": "https://www.tagesschau.de/wetter",
                "content": "<p>rss</p>",
            },
        )

        assert result == "<p>rss</p>"

    def test_extract_content_prefers_textabsatz_over_the_generic_tier(self, tages_agg):
        html = (
            "<html><body>"
            '<p class="textabsatz">Tagesschau eigener Text.</p>'
            f"<article><p>{self.BROADCASTER_BODY}</p></article>"
            "</body></html>"
        )

        result = tages_agg.extract_content(
            html, {"name": "T", "identifier": "u", "content": "<p>rss</p>"}
        )

        assert "Tagesschau eigener Text." in result
        assert self.BROADCASTER_BODY not in result

    @patch("core.aggregators.tagesschau.aggregator.extract_media_header")
    def test_a_media_player_page_keeps_its_empty_body(self, mock_media, tages_agg):
        """Video pages have no textabsatz but do have a player -- they must not
        be replaced by generic extraction."""
        mock_media.return_value = "<video>player</video>"
        html = f"<html><body><article><p>{self.BROADCASTER_BODY}</p></article></body></html>"

        result = tages_agg.extract_content(
            html, {"name": "T", "identifier": "u", "content": "<p>rss</p>"}
        )

        assert self.BROADCASTER_BODY not in result
        assert "rss" not in result

    @patch("core.aggregators.tagesschau.aggregator.extract_media_header")
    def test_media_header_is_parsed_once_and_shared_with_process_content(
        self, mock_media, tages_agg
    ):
        """extract_content and process_content run on the same article dict
        during a real aggregation pass. The media header must be parsed once
        and shared between them -- not re-parsed by process_content -- and
        the cache key must not survive past process_content."""
        mock_media.return_value = "<video>player</video>"
        html = f"<html><body><article><p>{self.BROADCASTER_BODY}</p></article></body></html>"
        article = {"name": "T", "identifier": "u", "content": "<p>rss</p>", "raw_content": html}

        tages_agg.extract_content(html, article)

        with patch(
            "core.aggregators.website.FullWebsiteAggregator.process_content",
            side_effect=lambda x, y: x,
        ):
            processed = tages_agg.process_content("Body", article)

        assert mock_media.call_count == 1
        assert _MEDIA_HEADER_CACHE_KEY not in article
        assert "<video>player</video>Body" in processed


def _media_player_html(mc: dict, plugin_data: dict | None = None) -> str:
    """A minimal MediaPlayer div carrying the given ``mc``/``pluginData`` payload."""
    player_data = {"mc": mc, "pluginData": plugin_data or {}}
    data_v = json.dumps(player_data)
    return f'<div data-v-type="MediaPlayer" class="mediaplayer" data-v=\'{data_v}\'></div>'


def _entity_encoded_media_player_html(mc: dict, plugin_data: dict | None = None) -> str:
    """
    Same as ``_media_player_html``, but HTML-entity-encodes the JSON payload
    before embedding it, matching real Tagesschau markup (see
    ``_parse_player_data``'s comment: "Tagesschau uses some HTML entities in
    the JSON string"). Needed whenever a malicious value must itself contain
    a raw quote character (e.g. a single-quoted ``src`` inside an injected
    ``embedCode``) -- ``_media_player_html``'s naive single-quote wrapping
    would let that quote prematurely terminate the outer ``data-v``
    attribute, which is a limitation of the test fixture, not the code
    under test.
    """
    player_data = {"mc": mc, "pluginData": plugin_data or {}}
    raw = json.dumps(player_data)
    encoded = (
        raw.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    return f'<div data-v-type="MediaPlayer" class="mediaplayer" data-v="{encoded}"></div>'


REMOTE_IMAGE_URL = "https://www.tagesschau.de/multimedia/bild-123~1280x720.jpg"
STORED_REF = f"yana-img://{'a' * 64}"


class TestTagesschauMediaHeaderImageLocalization:
    """
    `_get_player_image` resolves the publisher's image URL to absolute form,
    but nothing stored it -- every Tagesschau image/poster stayed a raw
    remote URL while every other aggregator's images became `yana-img://`
    refs. The fix localizes once at that resolution point, so both the
    `<video poster>` and the audio-only `<img src>` (fallback-from-streams
    and embed-code branches alike) get the reference.
    """

    VIDEO_HTML = _media_player_html(
        {
            "streams": [
                {
                    "isAudioOnly": False,
                    "media": [{"url": "https://dl.example/video.mp4", "mimeType": "video/mp4"}],
                }
            ],
            "image": "/multimedia/bild-123~1280x720.jpg",
        }
    )

    AUDIO_STREAMS_HTML = _media_player_html(
        {
            "streams": [
                {
                    "isAudioOnly": True,
                    "media": [{"url": "https://dl.example/audio.mp3", "mimeType": "audio/mpeg"}],
                }
            ],
            "image": "/multimedia/bild-123~1280x720.jpg",
        }
    )

    AUDIO_EMBED_HTML = _media_player_html(
        {"streams": [{"isAudioOnly": True}], "image": "/multimedia/bild-123~1280x720.jpg"},
        plugin_data={
            "sharing@web": {
                "embedCode": '<iframe src="//www.tagesschau.de/multimedia/embed-777.html"></iframe>'
            }
        },
    )

    @patch("core.aggregators.tagesschau.media_processor.store_image_ref_from_url")
    def test_video_poster_uses_the_stored_ref(self, mock_store):
        mock_store.return_value = STORED_REF

        result = extract_media_header(self.VIDEO_HTML)

        assert result is not None
        assert f'poster="{STORED_REF}"' in result
        mock_store.assert_called_once_with(REMOTE_IMAGE_URL, is_header=True)

    @patch(
        "core.aggregators.tagesschau.media_processor.store_image_ref_from_url", return_value=None
    )
    def test_video_poster_falls_back_to_the_remote_url_when_storage_returns_none(self, mock_store):
        result = extract_media_header(self.VIDEO_HTML)

        assert result is not None
        assert f'poster="{REMOTE_IMAGE_URL}"' in result

    @patch(
        "core.aggregators.tagesschau.media_processor.store_image_ref_from_url",
        side_effect=RuntimeError("boom"),
    )
    def test_video_poster_falls_back_to_the_remote_url_when_storage_raises(self, mock_store):
        result = extract_media_header(self.VIDEO_HTML)

        assert result is not None
        assert f'poster="{REMOTE_IMAGE_URL}"' in result

    @patch("core.aggregators.tagesschau.media_processor.store_image_ref_from_url")
    def test_audio_only_streams_image_uses_the_stored_ref(self, mock_store):
        mock_store.return_value = STORED_REF

        result = extract_media_header(self.AUDIO_STREAMS_HTML)

        assert result is not None
        assert f'<img src="{STORED_REF}"' in result

    @patch(
        "core.aggregators.tagesschau.media_processor.store_image_ref_from_url", return_value=None
    )
    def test_audio_only_streams_image_falls_back_to_the_remote_url(self, mock_store):
        result = extract_media_header(self.AUDIO_STREAMS_HTML)

        assert result is not None
        assert f'<img src="{REMOTE_IMAGE_URL}"' in result

    @patch("core.aggregators.tagesschau.media_processor.store_image_ref_from_url")
    def test_audio_only_embed_code_image_uses_the_stored_ref(self, mock_store):
        mock_store.return_value = STORED_REF

        result = extract_media_header(self.AUDIO_EMBED_HTML)

        assert result is not None
        assert f'<img src="{STORED_REF}"' in result

    @patch(
        "core.aggregators.tagesschau.media_processor.store_image_ref_from_url", return_value=None
    )
    def test_audio_only_embed_code_image_falls_back_to_the_remote_url(self, mock_store):
        result = extract_media_header(self.AUDIO_EMBED_HTML)

        assert result is not None
        assert f'<img src="{REMOTE_IMAGE_URL}"' in result


@patch("core.aggregators.tagesschau.media_processor.store_image_ref_from_url", return_value=None)
class TestTagesschauMediaHeaderHtmlInjection:
    """
    Every field pulled from the page's embedded `data-v` JSON (stream URLs,
    mime types, the embed iframe's `src`) or the surrounding DOM
    (`_get_player_image`) is attacker-reachable if the scraped Tagesschau page
    is compromised, and was being spliced straight into the header markup by
    f-string interpolation with no escaping and no scheme check.
    """

    def test_video_stream_url_and_mime_type_are_escaped(self, mock_store):
        malicious_url = 'https://dl.example/video.mp4"><script>alert(1)</script>'
        malicious_mime = 'video/mp4"><script>alert(2)</script>'
        html_ = _media_player_html(
            {
                "streams": [
                    {
                        "isAudioOnly": False,
                        "media": [{"url": malicious_url, "mimeType": malicious_mime}],
                    }
                ],
            }
        )

        result = extract_media_header(html_)

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find("script") is None
        source = soup.find("source")
        assert source is not None
        assert source["src"] == malicious_url
        assert source["type"] == malicious_mime

    def test_audio_stream_url_and_mime_type_are_escaped(self, mock_store):
        malicious_url = 'https://dl.example/audio.mp3"><script>alert(1)</script>'
        malicious_mime = 'audio/mpeg"><script>alert(2)</script>'
        html_ = _media_player_html(
            {
                "streams": [
                    {
                        "isAudioOnly": True,
                        "media": [{"url": malicious_url, "mimeType": malicious_mime}],
                    }
                ],
            }
        )

        result = extract_media_header(html_)

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find("script") is None
        source = soup.find("source")
        assert source is not None
        assert source["src"] == malicious_url
        assert source["type"] == malicious_mime

    def test_unsafe_scheme_stream_url_is_skipped(self, mock_store):
        """A `javascript:`/`data:` stream URL is not a link -- it's media --
        so it's skipped entirely rather than rendered bare."""
        html_ = _media_player_html(
            {
                "streams": [
                    {
                        "isAudioOnly": False,
                        "media": [
                            {"url": "javascript:alert(1)", "mimeType": "video/mp4"},
                        ],
                    }
                ],
            }
        )

        result = extract_media_header(html_)

        assert result is None

    def test_unsafe_scheme_image_url_skips_the_image_only(self, mock_store):
        """An unsafe poster/preview image is skipped, but the safe video
        stream itself still renders."""
        html_ = _media_player_html(
            {
                "streams": [
                    {
                        "isAudioOnly": False,
                        "media": [{"url": "https://dl.example/video.mp4", "mimeType": "video/mp4"}],
                    }
                ],
                "image": "javascript:alert(1)",
            }
        )

        result = extract_media_header(html_)

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find("script") is None
        video = soup.find("video")
        assert video is not None
        assert not video.has_attr("poster")
        assert soup.find("source") is not None

    def test_embed_code_iframe_src_quote_does_not_break_the_attribute(self, mock_store):
        # The injected embed markup quotes its `src` with single quotes so the
        # literal double quote in `malicious_src` survives BeautifulSoup's
        # *first* parse (of the untrusted embed code itself) intact -- this
        # isolates the case under test: whether *our own* reconstructed
        # `<iframe src="...">` (always double-quoted) escapes that value
        # before splicing it in.
        malicious_src = '//www.tagesschau.de/multimedia/embed-777.html"><script>alert(1)</script>'
        html_ = _entity_encoded_media_player_html(
            {"streams": [{"isAudioOnly": True}]},
            plugin_data={"sharing@web": {"embedCode": f"<iframe src='{malicious_src}'></iframe>"}},
        )

        result = extract_media_header(html_)

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find("script") is None
        iframe = soup.find("iframe")
        assert iframe is not None
        assert iframe["src"] == "https:" + malicious_src

    def test_embed_code_unsafe_scheme_falls_back_to_streams(self, mock_store):
        """An unsafe iframe `src` is dropped entirely; the aggregator falls
        back to rendering the HTML5 stream player instead of a broken/unsafe
        embed."""
        html_ = _media_player_html(
            {
                "streams": [
                    {
                        "isAudioOnly": True,
                        "media": [
                            {"url": "https://dl.example/audio.mp3", "mimeType": "audio/mpeg"}
                        ],
                    }
                ],
            },
            plugin_data={
                "sharing@web": {"embedCode": '<iframe src="javascript:alert(1)"></iframe>'}
            },
        )

        result = extract_media_header(html_)

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find("iframe") is None
        assert soup.find("script") is None
        assert soup.find("audio") is not None
