from unittest.mock import patch

from django.utils import timezone

import pytest
from bs4 import BeautifulSoup

from core.aggregators.podcast.aggregator import PodcastAggregator
from core.models import Feed


@pytest.mark.django_db
class TestPodcastAggregator:
    @pytest.fixture
    def podcast_feed(self, db):
        return Feed.objects.create(
            name="Podcast Feed",
            identifier="https://feeds.npr.org/510289/podcast.xml",
            daily_limit=5,
        )

    @pytest.fixture
    def aggregator(self, podcast_feed):
        return PodcastAggregator(podcast_feed)

    def test_parse_duration_to_seconds(self, aggregator):
        assert aggregator._parse_duration_to_seconds("01:02:03") == 3723
        assert aggregator._parse_duration_to_seconds("02:03") == 123
        assert aggregator._parse_duration_to_seconds("3600") == 3600
        assert aggregator._parse_duration_to_seconds("invalid") is None
        assert aggregator._parse_duration_to_seconds("") is None

    def test_format_duration(self, aggregator):
        assert aggregator._format_duration(3723) == "1:02:03"
        assert aggregator._format_duration(123) == "2:03"
        assert aggregator._format_duration(59) == "0:59"

    def test_parse_to_raw_articles_podcast(self, aggregator):
        source_data = {
            "entries": [
                {
                    "title": "Episode 1",
                    "link": "https://example.com/ep1",
                    "published": "Fri, 12 Dec 2025 18:59:37 -0500",
                    "summary": "Summary 1",
                    "enclosures": [{"url": "https://example.com/ep1.mp3", "type": "audio/mpeg"}],
                    "itunes_duration": "00:30:00",
                    "itunes_image": {"href": "https://example.com/art.jpg"},
                },
                {
                    "title": "No Audio",
                    "link": "https://example.com/no-audio",
                    "enclosures": [],
                },
            ]
        }

        # Mock time to ensure limit allows fetching
        midday = timezone.now().replace(hour=12, minute=0, second=0, microsecond=0)

        with patch("django.utils.timezone.now", return_value=midday):
            articles = aggregator.parse_to_raw_articles(source_data)

        assert len(articles) == 1
        assert articles[0]["name"] == "Episode 1"
        assert articles[0]["_media_url"] == "https://example.com/ep1.mp3"
        assert articles[0]["_duration"] == 1800
        assert articles[0]["_image_url"] == "https://example.com/art.jpg"

    def test_enrich_articles_builds_player(self, aggregator):
        articles = [
            {
                "name": "Episode 1",
                "identifier": "https://example.com/ep1",
                "content": "Original Summary",
                "date": timezone.now(),
                "_media_url": "https://example.com/ep1.mp3",
                "_media_type": "audio/mpeg",
                "_duration": 1800,
                "_image_url": "https://example.com/art.jpg",
            }
        ]

        enriched = aggregator.enrich_articles(articles)
        content = enriched[0]["content"]

        assert "<audio controls" in content
        assert 'src="https://example.com/ep1.mp3"' in content
        assert "30:00" in content
        assert 'src="https://example.com/art.jpg"' in content
        assert "Original Summary" in content

    @staticmethod
    def _base_article(**overrides):
        article = {
            "name": "Episode 1",
            "identifier": "https://example.com/ep1",
            "content": "",
            "date": timezone.now(),
            "_media_url": "https://example.com/ep1.mp3",
            "_media_type": "audio/mpeg",
            "_duration": None,
            "_image_url": "",
        }
        article.update(overrides)
        return article

    def test_enrich_articles_escapes_script_and_quote_in_media_type(self, aggregator):
        """A malicious enclosure `type` must not break out of the `type`
        attribute or inject a real `<script>` element."""
        malicious_type = 'audio/mpeg"><script>alert(1)</script>'
        articles = [self._base_article(_media_type=malicious_type)]

        enriched = aggregator.enrich_articles(articles)
        soup = BeautifulSoup(enriched[0]["content"], "html.parser")

        assert soup.find("script") is None
        source = soup.find("source")
        assert source is not None
        assert source["type"] == malicious_type

    def test_enrich_articles_escapes_quote_in_media_url(self, aggregator):
        """A malicious enclosure URL must not break out of `src`/`href` and
        inject a real element."""
        malicious_url = 'https://example.com/ep1.mp3"><script>alert(1)</script>'
        articles = [self._base_article(_media_url=malicious_url)]

        enriched = aggregator.enrich_articles(articles)
        soup = BeautifulSoup(enriched[0]["content"], "html.parser")

        assert soup.find("script") is None
        source = soup.find("source")
        assert source is not None
        assert source["src"] == malicious_url
        download_link = soup.find(attrs={"data-sanitized-class": "podcast-download"})
        assert download_link is not None
        assert download_link.name == "a"
        assert download_link["href"] == malicious_url

    def test_enrich_articles_skips_unsafe_media_and_image_urls(self, aggregator):
        """A `javascript:`/`data:` scheme must disable the player and image,
        and degrade the download link to bare text."""
        articles = [
            self._base_article(
                _media_url="javascript:alert(document.cookie)",
                _image_url="data:text/html,<script>alert(1)</script>",
                _duration=90,
            )
        ]

        enriched = aggregator.enrich_articles(articles)
        soup = BeautifulSoup(enriched[0]["content"], "html.parser")

        assert soup.find("audio") is None
        assert soup.find("img") is None
        assert soup.find("script") is None
        download = soup.find(attrs={"data-sanitized-class": "podcast-download"})
        assert download is not None
        assert download.name != "a"
        assert download.get_text() == "Download Episode"

    def test_enrich_articles_sanitizes_show_notes_html(self, aggregator):
        """Show-notes HTML is third-party markup: sanitize (strip
        script/on*), never escape (which would show literal `&lt;p&gt;`)."""
        malicious_description = '<p onclick="evil()">Good <b>text</b></p><script>alert(1)</script>'
        articles = [self._base_article(content=malicious_description)]

        enriched = aggregator.enrich_articles(articles)
        content = enriched[0]["content"]
        soup = BeautifulSoup(content, "html.parser")

        assert soup.find("script") is None
        bold = soup.find("b")
        assert bold is not None
        assert bold.get_text() == "text"
        p_tag = bold.find_parent("p")
        assert p_tag is not None
        assert "onclick" not in p_tag.attrs
        assert "&lt;p&gt;" not in content

    def test_enrich_articles_download_link_and_player_present_with_safe_input(self, aggregator):
        """Regression guard: benign input still renders the player, artwork,
        and (feature, defaults on) download link exactly as before."""
        articles = [
            self._base_article(
                content="Some notes",
                _duration=90,
                _image_url="https://example.com/art.jpg",
            )
        ]

        enriched = aggregator.enrich_articles(articles)
        soup = BeautifulSoup(enriched[0]["content"], "html.parser")

        download_link = soup.find(attrs={"data-sanitized-class": "podcast-download"})
        assert download_link is not None
        assert download_link.name == "a"
        assert download_link["href"] == "https://example.com/ep1.mp3"
        assert download_link.get_text() == "Download Episode"
        assert soup.find("audio") is not None
        assert soup.find("img", attrs={"alt": "Episode artwork"}) is not None
