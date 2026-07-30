from unittest.mock import patch

import pytest

from core.aggregators.tagesschau.aggregator import _MEDIA_HEADER_CACHE_KEY, TagesschauAggregator


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
