"""WordPress "Embed Privacy" consent-gate recovery (Spec 2 / A6)."""

import pytest
from bs4 import BeautifulSoup

from core.aggregators.utils.youtube import proxy_youtube_embeds, recover_consent_gated_embeds

CONSENT_TEXT = "Hier klicken, um den Inhalt von YouTube anzuzeigen"


def _gate(href: str | None) -> str:
    link = (
        f'<div class="embed-privacy-url"><a href="{href}">Direkt öffnen</a></div>' if href else ""
    )
    return f'<div class="embed-privacy-container"><p>{CONSENT_TEXT}</p>{link}</div>'


class TestRecoverConsentGatedEmbeds:
    def test_a_recoverable_gate_becomes_a_youtube_iframe(self):
        soup = BeautifulSoup(_gate("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "html.parser")

        recover_consent_gated_embeds(soup)

        iframe = soup.find("iframe")
        assert iframe is not None
        assert iframe["src"] == "https://www.youtube.com/embed/dQw4w9WgXcQ"
        assert CONSENT_TEXT not in soup.get_text()

    def test_an_unrecognizable_url_drops_the_gate(self):
        soup = BeautifulSoup(_gate("https://example.com/not-a-video"), "html.parser")

        recover_consent_gated_embeds(soup)

        assert soup.find("iframe") is None
        assert CONSENT_TEXT not in soup.get_text()
        assert soup.select(".embed-privacy-container") == []

    def test_a_gate_without_a_link_is_dropped(self):
        soup = BeautifulSoup(_gate(None), "html.parser")

        recover_consent_gated_embeds(soup)

        assert CONSENT_TEXT not in soup.get_text()

    def test_surrounding_content_is_untouched(self):
        html = f"<div><p>Real prose.</p>{_gate('https://youtu.be/dQw4w9WgXcQ')}<p>More.</p></div>"
        soup = BeautifulSoup(html, "html.parser")

        recover_consent_gated_embeds(soup)

        assert "Real prose." in soup.get_text()
        assert "More." in soup.get_text()

    def test_multiple_gates_are_each_handled(self):
        html = _gate("https://youtu.be/dQw4w9WgXcQ") + _gate("https://example.com/x")
        soup = BeautifulSoup(html, "html.parser")

        recover_consent_gated_embeds(soup)

        assert len(soup.find_all("iframe")) == 1
        assert CONSENT_TEXT not in soup.get_text()


@pytest.mark.django_db
class TestRecoveryRunsBeforeTheFacadePass:
    def test_a_recovered_embed_becomes_a_facade_like_any_other(self):
        soup = BeautifulSoup(_gate("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "html.parser")

        proxy_youtube_embeds(soup)

        html = str(soup)
        assert "youtube-embed-container" in html
        assert "https://www.youtube.com/watch?v=dQw4w9WgXcQ" in html
        assert "<iframe" not in html
        assert CONSENT_TEXT not in soup.get_text()
