import pytest
from bs4 import BeautifulSoup, Tag

from core.aggregators.mein_mmo.aggregator import MeinMmoAggregator
from core.aggregators.utils.block_parser import blocks_from_html
from core.blocks.types import EmbedBlock


@pytest.mark.django_db
class TestMeinMmoAggregator:
    @pytest.fixture
    def mein_mmo_agg(self, rss_feed):
        rss_feed.aggregator = "mein_mmo"
        rss_feed.identifier = "https://mein-mmo.de/feed/"
        return MeinMmoAggregator(rss_feed)

    def test_extract_content_removes_affiliate_widget(self, mein_mmo_agg):
        html = """
<div class="entry-content">
<p>Some content</p>
<div class="wp-block-wbd-affiliate-widget swiper js-ga-view"><div class="products swiper-wrapper">
<a class="wp-block-wbd-affiliate-widget-product product swiper-slide js-ga" href="https://ndirect.ppro.de/click/pBy1" rel="noopener nofollow sponsored" target="_blank"><div class="image"><img alt="HBO Max mit WaipuTV" decoding="async" src="https://images-toolbox.webediagaming.de/wp-content/uploads/2026/01/hbo-max-waipu.jpg"/></div><div class="name">HBO Max mit WaipuTV</div><div class="descript">HBO MAX mit über 300 HD-Sendern und mehr als 40.000 zusätzlich abrufbaren Inhalten.</div><div class="prices"><span class="price">Ab 17,99 €</span></div><button class="button">zu Waipu</button></a>
<a class="wp-block-wbd-affiliate-widget-product product swiper-slide js-ga" href="https://www.awin1.com/cread.php?awinmid=16040&amp;awinaffid=699701&amp;clickref=gam&amp;ued=https%3A%2F%2Fwww.hbomax.com%2Fde%2Fde%2Fbundle%2Frtl-plus" rel="noopener nofollow sponsored" target="_blank"><div class="image"><img alt="HBO Max mit RTL+" decoding="async" src="https://images-toolbox.webediagaming.de/wp-content/uploads/2026/01/hbo-max-rtl.jpg"/></div><div class="name">HBO Max mit RTL+</div><div class="descript">HBO MAX inklusive RTL Plus Premium und Downloads – im ersten Monat spart ihr extra!</div><div class="prices"><span class="price">Ab 9,99€ €</span></div><button class="button">zu RTL+</button></a>
<a class="wp-block-wbd-affiliate-widget-product product swiper-slide js-ga" href="https://www.hbomax.com/de/de" rel="noopener nofollow sponsored" target="_blank"><div class="image"><img alt="HBO Max" decoding="async" src="https://images-toolbox.webediagaming.de/wp-content/uploads/2026/01/hbo-max.jpg"/></div><div class="name">HBO Max</div><div class="descript">Drei Abomodelle mit und ohne Werbung und optional mit Sport-Paket, von Full-HD bis 4K.</div><div class="prices"><span class="price">Ab 5,99 €</span></div><button class="button">zu HBO Max</button></a>
</div><nav class="swiper-scrollbar"></nav></div>
<p>More content</p>
</div>
        """
        extracted = mein_mmo_agg.extract_content(html, {"name": "Test", "identifier": "test-url"})

        # Verify normal content is preserved
        assert "<p>Some content</p>" in extracted
        assert "<p>More content</p>" in extracted

        # Verify affiliate widget is removed
        assert "wp-block-wbd-affiliate-widget" not in extracted
        assert "HBO Max" not in extracted

    def test_dailymotion_facade_survives_selector_removal(self, mein_mmo_agg):
        """
        Regression test: `selectors_to_remove` used to contain
        ".dailymotion-embed-container" -- the very class the Dailymotion
        converter builds -- so the removal loop that runs right after the
        conversion deleted the facade it had just created, and every
        MeinMMO Dailymotion video was silently dropped.
        """
        html = (
            '<div class="entry-content"><p>before</p>\n'
            '<div class="wp-block-mmo-video"><div class="title">Trailer</div>\n'
            "<script>var o = { dmVideoId: 'x9yt07o' };</script></div>\n"
            "<p>after</p></div>"
        )

        extracted = mein_mmo_agg.extract_content(html, {"name": "Test", "identifier": "test-url"})

        assert "dailymotion.com/video/x9yt07o" in extracted
        blocks = blocks_from_html(extracted)
        assert (
            EmbedBlock(
                provider="dailymotion",
                external_url="https://www.dailymotion.com/video/x9yt07o",
            )
            in blocks
        )


WPDISCUZ_THREAD = """
<div class="wpd-thread-list">
  <div class="wpd-comment">
    <div class="wpd-comment-right" id="comment-101">
      <div class="wpd-comment-author"><a href="#">Spieler1</a></div>
      <div class="wpd-comment-date" title="12. Juli 2026 um 10:22">vor 3 Stunden</div>
      <div class="wpd-comment-text"><p>Erster Kommentar.</p></div>
    </div>
  </div>
  <div class="wpd-comment">
    <div class="wpd-comment-right" id="comment-102">
      <div class="wpd-comment-author"><a href="#">Spieler2</a></div>
      <div class="wpd-comment-date">gerade eben</div>
      <div class="wpd-comment-text"><p>Zweiter Kommentar.</p></div>
    </div>
  </div>
  <div class="wpd-comment">
    <div class="wpd-comment-right" id="comment-103">
      <div class="wpd-comment-author"><a href="#">Spieler3</a></div>
      <div class="wpd-comment-text"><p>Dritter Kommentar.</p></div>
    </div>
  </div>
</div>
"""


class TestMeinMmoCommentExtractor:
    ARTICLE_URL = "https://mein-mmo.de/some-article/"

    def test_extracts_comments_with_author_timestamp_and_anchor(self):
        from core.aggregators.mein_mmo.comment_extractor import extract_comments

        result = extract_comments(WPDISCUZ_THREAD, self.ARTICLE_URL, max_comments=5)

        assert result is not None
        assert "Spieler1" in result
        assert "12. Juli 2026 um 10:22" in result
        assert "Erster Kommentar." in result
        assert f"{self.ARTICLE_URL}#comment-101" in result

    def test_caps_at_max_comments(self):
        from core.aggregators.mein_mmo.comment_extractor import extract_comments

        result = extract_comments(WPDISCUZ_THREAD, self.ARTICLE_URL, max_comments=2)

        assert result is not None
        assert "Erster Kommentar." in result
        assert "Zweiter Kommentar." in result
        assert "Dritter Kommentar." not in result

    def test_zero_max_comments_returns_none(self):
        from core.aggregators.mein_mmo.comment_extractor import extract_comments

        assert extract_comments(WPDISCUZ_THREAD, self.ARTICLE_URL, max_comments=0) is None

    def test_no_thread_returns_none(self):
        from core.aggregators.mein_mmo.comment_extractor import extract_comments

        assert extract_comments("<div>no comments here</div>", self.ARTICLE_URL) is None


class TestMeinMmoCommentSanitization:
    """HTML-injection regression tests for scraped wpDiscuz comment rendering.

    Comment HTML is spliced into stored article content with no sanitizer
    downstream, so these assert on the PARSED structure, not just substring
    absence, to prove the markup stays well-formed rather than merely
    pattern-matching escaped text.
    """

    ARTICLE_URL = "https://mein-mmo.de/some-article/"

    def _comment_el(self, inner_html: str) -> Tag:
        soup = BeautifulSoup(f'<div class="wpd-comment">{inner_html}</div>', "html.parser")
        element = soup.select_one("div.wpd-comment")
        assert element is not None
        return element

    def test_author_with_script_is_escaped(self):
        from core.aggregators.mein_mmo.comment_extractor import _process_comment

        el = self._comment_el(
            """
            <div class="wpd-comment-right" id="comment-1">
                <div class="wpd-comment-author">
                    <a href="#">&lt;script&gt;alert(1)&lt;/script&gt;</a>
                </div>
                <div class="wpd-comment-text"><p>Nice comment.</p></div>
            </div>
            """
        )

        result = _process_comment(el, self.ARTICLE_URL)

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []
        assert soup.find("strong").get_text() == "<script>alert(1)</script>"

    def test_timestamp_with_quote_and_markup_injects_nothing(self):
        from core.aggregators.mein_mmo.comment_extractor import _process_comment

        el = self._comment_el(
            """
            <div class="wpd-comment-right" id="comment-1">
                <div class="wpd-comment-author"><a href="#">Spieler1</a></div>
                <div class="wpd-comment-date" title='"quote" &lt;script&gt;alert(1)&lt;/script&gt;'>
                    vor 3 Stunden
                </div>
                <div class="wpd-comment-text"><p>Nice comment.</p></div>
            </div>
            """
        )

        result = _process_comment(el, self.ARTICLE_URL)

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []
        # Exactly one blockquote injected -- no extra element from the timestamp.
        assert len(soup.find_all("blockquote")) == 1

    def test_content_script_and_onerror_removed_legit_markup_survives(self):
        from core.aggregators.mein_mmo.comment_extractor import _process_comment

        el = self._comment_el(
            """
            <div class="wpd-comment-right" id="comment-1">
                <div class="wpd-comment-author"><a href="#">Spieler1</a></div>
                <div class="wpd-comment-text">
                    <p>Great <strong>comment</strong>!
                    <a href="https://example.com/ref">link</a></p>
                    <script>alert(1)</script>
                    <img src="x.jpg" onerror="alert(2)">
                </div>
            </div>
            """
        )

        result = _process_comment(el, self.ARTICLE_URL)

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert soup.find_all("script") == []
        assert all("onerror" not in tag.attrs for tag in soup.find_all(True))
        assert "alert(2)" not in result
        assert soup.find_all("strong")[-1].get_text() == "comment"
        ref_link = soup.find("a", href="https://example.com/ref")
        assert ref_link is not None
        assert ref_link.get_text() == "link"

    def test_javascript_article_url_not_rendered_as_href(self):
        from core.aggregators.mein_mmo.comment_extractor import _process_comment

        el = self._comment_el(
            """
            <div class="wpd-comment-right" id="comment-1">
                <div class="wpd-comment-author"><a href="#">Spieler1</a></div>
                <div class="wpd-comment-text"><p>Nice comment.</p></div>
            </div>
            """
        )

        result = _process_comment(el, "javascript:alert(1)")

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        for a in soup.find_all("a"):
            assert not a.get("href", "").lower().startswith("javascript:")

    def test_header_link_javascript_article_url_not_rendered_as_href(self):
        from core.aggregators.mein_mmo.comment_extractor import extract_comments

        result = extract_comments(WPDISCUZ_THREAD, "javascript:alert(1)", max_comments=1)

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        for a in soup.find_all("a"):
            assert not a.get("href", "").lower().startswith("javascript:")

    def test_normal_comment_regression(self):
        from core.aggregators.mein_mmo.comment_extractor import extract_comments

        result = extract_comments(WPDISCUZ_THREAD, self.ARTICLE_URL, max_comments=1)

        assert result is not None
        soup = BeautifulSoup(result, "html.parser")
        assert len(soup.find_all("blockquote")) == 1
        assert soup.find_all("strong")[0].get_text() == "Spieler1"
        assert "Erster Kommentar." in result
        assert soup.find("a", href=f"{self.ARTICLE_URL}#comment-101") is not None


@pytest.mark.django_db
class TestMeinMmoCommentOptions:
    @pytest.fixture
    def mmo_agg(self, rss_feed):
        from core.aggregators.mein_mmo import MeinMmoAggregator

        rss_feed.aggregator = "mein_mmo"
        rss_feed.identifier = "https://mein-mmo.de/feed/"
        return MeinMmoAggregator(rss_feed)

    def test_options_are_offered_with_ios_defaults(self):
        from core.aggregators.mein_mmo import MeinMmoAggregator

        fields = MeinMmoAggregator.get_configuration_fields()

        assert fields["include_comments"].initial is True
        assert fields["max_comments"].initial == 5

    def test_comments_are_appended_when_enabled(self, mmo_agg):
        article = {
            "name": "T",
            "identifier": "https://mein-mmo.de/some-article/",
            "raw_content": WPDISCUZ_THREAD,
        }

        result = mmo_agg.process_content("<p>body</p>", article)

        assert "Erster Kommentar." in result
        assert "article-comments" in result

    def test_comments_are_absent_when_disabled(self, mmo_agg):
        mmo_agg.feed.options = {"include_comments": False}
        article = {
            "name": "T",
            "identifier": "https://mein-mmo.de/some-article/",
            "raw_content": WPDISCUZ_THREAD,
        }

        result = mmo_agg.process_content("<p>body</p>", article)

        assert "Erster Kommentar." not in result

    def test_max_comments_option_is_honored(self, mmo_agg):
        mmo_agg.feed.options = {"max_comments": 1}
        article = {
            "name": "T",
            "identifier": "https://mein-mmo.de/some-article/",
            "raw_content": WPDISCUZ_THREAD,
        }

        result = mmo_agg.process_content("<p>body</p>", article)

        assert "Erster Kommentar." in result
        assert "Zweiter Kommentar." not in result

    def test_multipage_articles_read_comments_from_the_first_page(self, mmo_agg, monkeypatch):
        """fetch_all_pages returns only the combined entry-content blocks, so
        raw_content loses the comment thread -- the first page is the source."""
        first_page = f'<div class="entry-content"><p>page one</p></div>{WPDISCUZ_THREAD}'
        monkeypatch.setattr(
            "core.aggregators.website.FullWebsiteAggregator.fetch_article_content",
            lambda self, url: first_page,
        )

        mmo_agg.fetch_article_content("https://mein-mmo.de/some-article/")
        article = {
            "name": "T",
            "identifier": "https://mein-mmo.de/some-article/",
            "raw_content": '<div class="entry-content"><p>page one</p></div>',
        }

        result = mmo_agg.process_content("<p>body</p>", article)

        assert "Erster Kommentar." in result
