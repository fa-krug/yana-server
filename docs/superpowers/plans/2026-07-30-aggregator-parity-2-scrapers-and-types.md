# Aggregator Parity 2 — Scraper Fixes & New Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the six iOS scraper fixes the server never got, add the two iOS-only aggregator types (The Verge, Ars Technica), and close the mein_mmo comment-option gap — so all 16 server aggregator types match iOS and produce the same article body.

**Architecture:** Every fix is a selector list, an include predicate, or a fallback branch inside the existing `fetch → parse → filter → enrich → finalize` template. Two changes touch shared code: `utils/youtube.py` gains consent-gate recovery that runs before the embed-proxy pass (so every scraper inherits it), and `utils/content_formatter.py` gains `build_header_html()` returning `Optional[str]` so "no header" and "empty header" stop being the same value. The two new aggregators are ordinary `FullWebsiteAggregator` subclasses whose only interesting property is the *opposite* setting of `uses_first_content_match`.

**Tech Stack:** Python 3.13, Django 6.0, BeautifulSoup 4 / soupsieve, pytest + pytest-django, ruff, mypy, uv.

**Spec:** [2026-07-29-aggregator-parity-2-scrapers-and-types-design.md](../specs/2026-07-29-aggregator-parity-2-scrapers-and-types-design.md)
**Depends on:** Spec 1, landed — `uses_first_content_match`, `extract_main_content_if_present`, `generic_content_if_present`, and `content_selectors` (plural list) all exist already.

## Global Constraints

- Line length 100, double quotes, `ruff format` output. Enabled ruff rules: `E`, `F`, `W`, `I`, `B`, `SIM`, `C4`, `DJ`.
- Every command runs under `uv run` (no venv activation).
- Type hints on all new/changed signatures; `uv run mypy core/` must stay clean.
- Commit format `<type>(<scope>): <Description>` — e.g. `fix(merkur): Strip follow-us buttons`.
- Run `uv run pytest` at the end of every task. A task is not done while any test fails.
- **Extraction fallbacks never raise.** A missing container returns `None`/`""` and the caller degrades to the next tier; a DOM change on one site must not fail the run.
- **The generic-content floor stays exactly 80 characters** (`website.GENERIC_CONTENT_MIN_TEXT_LENGTH`). Do not touch it in this plan.
- **MacTechNews' `TechTicker:` filter is prefix-matched and case-sensitive. Heise's title skip-list is substring-matched and case-insensitive. Do not unify them** — see Task 4.
- Class attribute is `content_selectors: List[str]` (plural list). The spec's prose says `content_selector`; read it as the plural list attribute (Spec 1 plan, deviation 2).
- No new third-party dependencies.
- Out of scope: feed discovery / URL resolution / AI selector suggestion (Spec 3), base64 removal and image hosting (Spec 4), block conversion (Spec 5). Do not "fix" base64 inlining while touching Reddit in Task 5.

## Deviations from the spec (deliberate, reviewed)

1. **A2 keeps Heise's `uses_first_content_match = True` and `content_selectors = ["#meldung", ".StoryContent"]` as-is.** Spec 2 lists both as changes to make; Spec 1 already landed them (`core/aggregators/heise/aggregator.py:74,77`). Only the second half of A2 — `extract_main_content_if_present` plus an RSS-summary fallback instead of `<body>` — remains.
2. **A3 does not rewire Tagesschau onto the shared extractor.** The spec adds `generic_content_if_present` as a *middle* tier; the bespoke `textabsatz` parser stays the first tier, so a feed's `content_selectors` option still has no effect on Tagesschau. `core/tests/test_selector_options.py::test_tagesschau_currently_ignores_content_selectors_option` therefore stays green — its docstring is corrected in Task 10 to say this is the end state, not a gap.
3. **A3 mirrors iOS's `!extracted.isEmpty || mediaHeader != nil` guard**, so a media-player-only page (no `textabsatz`) keeps its media header instead of being replaced by generic extraction. The server extracts the media header in `process_content`, so Task 3 introduces a small per-article cache to avoid parsing the page twice.
4. **A5's server shape differs from iOS's.** iOS builds the header inline in `buildArticle`; the server splits the work between `finalize_articles` (resolve URL, inline base64) and `process_content` (render). The fix keeps that split but computes the header **once** in `finalize_articles` and passes the rendered HTML through `article["header_html"]`, so a Twitter embed is never fetched twice and the strip decision uses the exact header that will ship.
5. **A5 keeps the "failed image download" case as `header from the original URL`, not `no header`.** The server already falls back to the un-inlined URL when `fetch_single_image` fails, which still renders an image; only a header that genuinely cannot be built (no URL, or a failed tweet embed) suppresses stripping. Task 5 pins both behaviors with tests.
6. **A6 hangs recovery off `proxy_youtube_embeds()`** rather than adding a call site to each scraper. That function is already the shared embed-rewrite pass (`website.py`, `merkur`, `heise`, `mactechnews`, `mein_mmo` all call it), and the spec requires recovery to run *before* the rewrite — one call at the top of that function satisfies both, and Caschy's Blog gets it via `super().process_content()`.
7. **B1/B2 do not override `get_configuration_fields()`.** The spec calls both "AI-options-only — no extra per-feed toggles". Not overriding means they inherit `FullWebsiteAggregator`'s shared `content_selectors` / `ignore_selectors` fields and add nothing bespoke, which is the closest server equivalent. (Merkur/Heise *replace* those fields; that is their legacy, not a pattern to copy.)
8. **B1/B2 each need a Django migration.** `Feed.aggregator` is a `CharField(choices=AGGREGATOR_CHOICES)`, and Django records `choices` in migration state, so `makemigrations` emits an `AlterField`. It is a no-op for SQLite's schema, exactly as the spec predicted ("new choices need no schema change, but run it") — but the migration file must be generated and committed or `makemigrations --check` drifts.
9. **C reads comments from the first page, not `raw_content`.** `mein_mmo/multipage_handler.fetch_all_pages()` returns *only* the concatenated `div.entry-content` blocks, so for a multi-page article `article["raw_content"]` no longer contains the wpDiscuz thread. Task 9 stashes the first page's HTML on the aggregator instance (one article is fetched and processed at a time inside `enrich_articles`) and prefers it. iOS reads `article.rawContent`, which on iOS *is* the first page.

---

## File Structure

**Modified**
- `core/aggregators/merkur/aggregator.py` — A1: one `selectors_to_remove` entry.
- `core/aggregators/heise/aggregator.py` — A2: `extract_content` → `_if_present` + RSS fallback.
- `core/aggregators/tagesschau/aggregator.py` — A3: generic middle tier, media-header cache, stale NOTE.
- `core/aggregators/mactechnews/aggregator.py` — A4: `filter_articles` TechTicker predicate.
- `core/aggregators/reddit/aggregator.py` — A5: header built once, strip only after it renders.
- `core/aggregators/utils/content_formatter.py` — A5: `build_header_html()`, `header_html` parameter.
- `core/aggregators/utils/youtube.py` — A6: `recover_consent_gated_embeds()`, called from `proxy_youtube_embeds()`.
- `core/aggregators/utils/__init__.py` — export `build_header_html`.
- `core/aggregators/mein_mmo/aggregator.py` — C: two option fields, comment wiring, first-page stash.
- `core/choices.py`, `core/aggregators/registry.py` — B1/B2 registration.
- `core/tests/test_selector_options.py` — B2: Ars joins MacTechNews as a union scraper; Task 10 docstring fix.
- `CLAUDE.md`, `core/aggregators/README.md` — Task 10: 14 → 16 types, two new entries.

**Created**
- `core/aggregators/the_verge/__init__.py`, `core/aggregators/the_verge/aggregator.py`
- `core/aggregators/ars_technica/__init__.py`, `core/aggregators/ars_technica/aggregator.py`
- `core/aggregators/mein_mmo/comment_extractor.py`
- `core/migrations/00XX_alter_feed_aggregator.py` ×2 (generated, one per new type)
- `core/tests/test_embed_privacy.py`
- `core/tests/test_the_verge_aggregator.py`
- `core/tests/test_ars_technica_aggregator.py`

---

## Task 1: A1 — Merkur strips follow-us buttons

**Files:**
- Modify: `core/aggregators/merkur/aggregator.py:98-120` (`selectors_to_remove`)
- Test: `core/tests/test_merkur_aggregator.py`

**Interfaces:**
- Consumes: `FullWebsiteAggregator.get_ignore_selectors()` (class list + feed option), already present.
- Produces: nothing other aggregators consume.

- [ ] **Step 1: Write the failing test**

Append to `core/tests/test_merkur_aggregator.py`, inside `class TestMerkurAggregator`:

```python
    def test_extract_content_strips_follow_buttons(self, merkur_agg):
        """Merkur embeds "Uns auf Google/YouTube folgen" as standalone
        InteractionBar anchors inside the story flow; only the shared
        FollowButton suffix covers every network."""
        html = (
            "<html><body><div class='idjs-Story'>"
            "<p>Real story body.</p>"
            "<a class='id-Story-googleFollowButton' href='https://news.google.com/x'>"
            "Uns auf Google folgen</a>"
            "<a class='id-Story-youtubeFollowButton' href='https://youtube.com/x'>"
            "Uns auf YouTube folgen</a>"
            "<a href='https://www.merkur.de/lokales/story'>Ordinary story link</a>"
            "</div></body></html>"
        )

        result = merkur_agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "Real story body." in result
        assert "Uns auf Google folgen" not in result
        assert "Uns auf YouTube folgen" not in result
        assert "Ordinary story link" in result
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run pytest core/tests/test_merkur_aggregator.py::TestMerkurAggregator::test_extract_content_strips_follow_buttons -v
```

Expected: FAIL — both follow-button anchors survive (no existing selector matches them).

- [ ] **Step 3: Add the selector**

In `core/aggregators/merkur/aggregator.py`, add one entry to `selectors_to_remove`, directly after `".id-Story-interactionBar"`:

```python
        ".id-Story-interactionBar",
        # Standalone "Uns auf Google/YouTube folgen" anchors that leak into the
        # story flow outside the interaction bar. The class name varies per
        # network, so match the shared suffix instead of enumerating each.
        "[class*='FollowButton']",
```

(iOS writes this unquoted as `[class*=FollowButton]`; the quoted form is identical to soupsieve and matches this repo's style — see `DEFAULT_IGNORE_SELECTORS`.)

- [ ] **Step 4: Run the test to verify it passes**

```bash
uv run pytest core/tests/test_merkur_aggregator.py -v
```

Expected: PASS (all tests in the file).

- [ ] **Step 5: Run the suite and the linters**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

- [ ] **Step 6: Commit**

```bash
git add core/aggregators/merkur/aggregator.py core/tests/test_merkur_aggregator.py
git commit -m "fix(merkur): Strip standalone follow-us buttons from the body"
```

---

## Task 2: A2 — Heise falls back to the RSS summary, never to `<body>`

**Files:**
- Modify: `core/aggregators/heise/aggregator.py:9-17` (imports), `:169-180` (`extract_content`)
- Test: `core/tests/test_heise_aggregator.py`

**Interfaces:**
- Consumes: `utils.extract_main_content_if_present(html, content_selectors, remove_selectors, first_match_only) -> Optional[str]`; `self.get_content_selectors()`, `self.get_ignore_selectors()`, `self.uses_first_content_match` (all existing).
- Produces: `HeiseAggregator.extract_content(html, article) -> str` — returns `article["content"]` (the RSS summary, still unmodified at this point in `enrich_articles`) when no story container matched.

**Context the implementer needs:** `RssAggregator.parse_to_raw_articles` seeds `article["content"]` with the RSS summary, and `FullWebsiteAggregator.enrich_articles` only overwrites it *after* `extract_content` returns. So `article.get("content", "")` inside `extract_content` is the RSS summary.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/test_heise_aggregator.py`, inside `class TestHeiseAggregator`:

```python
    def test_extract_content_keeps_only_the_story_container(self, heise_agg):
        """Heise pages carry sibling <article> teaser cards; the union must not
        splice them into the body."""
        html = (
            "<html><body>"
            "<nav>Startseite Newsticker Themen</nav>"
            '<article id="meldung"><p>The real story body.</p></article>'
            "<article><p>Teaser one</p></article>"
            "<article><p>Teaser two</p></article>"
            "<article><p>Teaser three</p></article>"
            "</body></html>"
        )

        result = heise_agg.extract_content(
            html, {"name": "T", "identifier": "u", "content": "<p>rss summary</p>"}
        )

        assert "The real story body." in result
        assert "Teaser one" not in result
        assert "Startseite Newsticker Themen" not in result

    def test_extract_content_falls_back_to_the_rss_summary(self, heise_agg):
        """Magazine/paywall gate pages have a different DOM. Dumping <body>
        surfaced the whole site chrome as the article, so degrade to RSS."""
        html = (
            "<html><body>"
            "<nav>Startseite Newsticker Themen</nav>"
            '<div class="paywall">Jetzt heise+ lesen</div>'
            "</body></html>"
        )

        result = heise_agg.extract_content(
            html, {"name": "T", "identifier": "u", "content": "<p>rss summary</p>"}
        )

        assert result == "<p>rss summary</p>"
        assert "Startseite Newsticker Themen" not in result
        assert "Jetzt heise+ lesen" not in result

    def test_extract_content_falls_back_to_empty_when_there_is_no_rss_summary(self, heise_agg):
        result = heise_agg.extract_content("<html><body><nav>chrome</nav></body></html>", {"name": "T"})

        assert result == ""
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_heise_aggregator.py -k "story_container or rss_summary" -v
```

Expected: FAIL — the current `super().extract_content()` path falls back to `<body>`, so the nav text and the paywall text both leak in.

- [ ] **Step 3: Rewrite `HeiseAggregator.extract_content`**

Add `extract_main_content_if_present` to the existing `from ..utils import (...)` block in `core/aggregators/heise/aggregator.py` (keep the list alphabetical: `clean_html, extract_main_content_if_present, fetch_html, format_article_content, remove_image_by_url, sanitize_class_names`), then replace `extract_content` (currently lines 169-180):

```python
    def extract_content(self, html: str, article: Dict[str, Any]) -> str:
        """Extract the Heise story container, degrading to the RSS summary.

        Heise pages carry many sibling ``<article>`` teaser cards and a
        page-chrome ``.article-content`` container, so a ``<body>`` fallback
        surfaces the whole site as the article -- magazine and paywall gate
        pages have a different DOM and hit that path routinely. Report the miss
        instead and let the RSS summary stand.
        """
        extracted = extract_main_content_if_present(
            html,
            content_selectors=self.get_content_selectors(),
            remove_selectors=self.get_ignore_selectors(),
            first_match_only=self.uses_first_content_match,
        )

        if extracted is None:
            self.logger.info(
                "[extract_content] No Heise story container for %s -- using the RSS summary",
                article.get("identifier"),
            )
            return article.get("content", "")

        # Remove empty elements (p/div/span with no text and no images).
        soup = BeautifulSoup(extracted, "html.parser")
        for tag in soup.find_all(["p", "div", "span"]):
            if not tag.get_text(strip=True) and not tag.find_all("img"):
                tag.decompose()

        return str(soup)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_heise_aggregator.py core/tests/test_selector_options.py -v
```

Expected: PASS. `test_selector_options.py` matters here — two of its cases drive Heise's option resolution through `extract_content`.

- [ ] **Step 5: Run the suite and the linters**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

- [ ] **Step 6: Commit**

```bash
git add core/aggregators/heise/aggregator.py core/tests/test_heise_aggregator.py
git commit -m "fix(heise): Fall back to the RSS summary instead of the page body"
```

---

## Task 3: A3 — Tagesschau gains the generic middle tier

**Files:**
- Modify: `core/aggregators/tagesschau/aggregator.py:1-10` (imports), `:20-41` (stale NOTE), `:207-244` (`extract_content`, `process_content`)
- Test: `core/tests/test_tagesschau_aggregator.py`

**Interfaces:**
- Consumes: `FullWebsiteAggregator.generic_content_if_present(raw_html, article) -> Optional[str]` (Spec 1; uses `DEFAULT_CONTENT_SELECTORS` and enforces the 80-char floor); `tagesschau.media_processor.extract_media_header(html) -> Optional[str]` (pure parsing, no network).
- Produces: `TagesschauAggregator._media_header(html, article) -> Optional[str]` — parses once per article and caches under the private key `_MEDIA_HEADER_CACHE_KEY`; `process_content` consumes and then pops it.

**Tier order to implement:** `tagesschau-specific extraction → generic <article>/main extraction (≥80 chars) → RSS summary`. A media-player-only page keeps tier 1 (empty body + media header), mirroring iOS's `!extracted.isEmpty || mediaHeader != nil` guard.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/test_tagesschau_aggregator.py`, inside `class TestTagesschauAggregator`:

```python
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
            {"name": "T", "identifier": "https://www.tagesschau.de/wetter", "content": "<p>rss</p>"},
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_tagesschau_aggregator.py -v
```

Expected: FAIL for the four new non-`@patch` cases (today `extract_content` returns the empty `<div data-sanitized-class="article-content">` for all of them, so no assertion about broadcaster text or the RSS summary holds). The `@patch` case may pass incidentally — keep it; it pins the guard.

- [ ] **Step 3: Implement the tiers**

In `core/aggregators/tagesschau/aggregator.py`, update the imports and add the module constant:

```python
from typing import Any, Dict, List, Optional, Tuple

from bs4 import BeautifulSoup

from ..website import FullWebsiteAggregator
from .content_extraction import extract_tagesschau_content
from .media_processor import extract_media_header

logger = logging.getLogger(__name__)

# Per-article cache for the parsed media header: extract_content needs it to
# decide whether a page is genuinely empty, process_content needs it to render.
# Parsing the page twice per article is pure waste.
_MEDIA_HEADER_CACHE_KEY = "_tagesschau_media_header"
```

Replace the stale NOTE block (lines 21-25) with:

```python
    # Extraction runs three tiers: the bespoke textabsatz parser below, then
    # the shared generic extractor (Spec 2 / A3), then the RSS summary. Only
    # the generic tier reads ``selectors_to_remove`` (via get_ignore_selectors);
    # ``uses_first_content_match`` stays inert because the generic tier unions
    # its matches by design. A feed's ``content_selectors`` option has no effect
    # here -- the bespoke parser is the point of this aggregator.
```

Replace `extract_content` and the media-header handling in `process_content`:

```python
    def extract_content(self, html: str, article: Dict[str, Any]) -> str:
        """Extract content: textabsatz, then generic extraction, then RSS.

        Regional feeds syndicate items that link straight to an external ARD
        broadcaster page (mdr.de, ndr.de, ...). Those templates carry none of
        tagesschau.de's textabsatz/MediaPlayer markup, so tier 1 finds nothing
        and the article used to land empty. Tier 2 is the shared generic
        extractor with its 80-character floor; widget pages (the DWD weather
        pages) match no container at all and correctly reach tier 3.
        """
        extracted = extract_tagesschau_content(html)

        if self._has_real_content(extracted) or self._media_header(html, article):
            return extracted

        generic = self.generic_content_if_present(html, article)
        if generic:
            self.logger.info(
                "[extract_content] Using generic extraction for %s", article.get("identifier")
            )
            return generic

        self.logger.info(
            "[extract_content] No usable page content for %s -- using the RSS summary",
            article.get("identifier"),
        )
        return article.get("content", "")

    @staticmethod
    def _has_real_content(html: str) -> bool:
        """True when the bespoke extractor produced text or embedded media."""
        soup = BeautifulSoup(html, "html.parser")
        if soup.get_text(strip=True):
            return True
        return soup.find(["img", "iframe", "video", "audio"]) is not None

    def _media_header(self, html: str, article: Dict[str, Any]) -> Optional[str]:
        """Parse the MediaPlayer header once per article and cache the result."""
        if _MEDIA_HEADER_CACHE_KEY in article:
            cached: Optional[str] = article[_MEDIA_HEADER_CACHE_KEY]
            return cached

        media_header: Optional[str] = None
        if html:
            try:
                media_header = extract_media_header(html)
            except Exception as e:
                self.logger.debug(
                    f"Failed to extract media header for {article.get('identifier')}: {e}"
                )

        article[_MEDIA_HEADER_CACHE_KEY] = media_header
        return media_header

    def process_content(self, html: str, article: Dict[str, Any]) -> str:
        """Process content and add media header if available."""
        raw_html = article.get("raw_content", "")
        media_header = self._media_header(raw_html, article)
        # The cache is per-run scratch space; don't let it reach the ORM layer.
        article.pop(_MEDIA_HEADER_CACHE_KEY, None)

        # If we have a media_header, temporarily remove header_data so
        # super().process_content() doesn't add a duplicate (less specific) header image.
        header_data = article.get("header_data")
        if media_header and header_data:
            article["header_data"] = None

        try:
            processed = super().process_content(html, article)
        finally:
            if media_header and header_data:
                article["header_data"] = header_data

        if media_header:
            return media_header + processed

        return processed
```

Note `List` and `Tuple` stay in the `typing` import (used by `get_identifier_choices`); `logging` is already imported.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_tagesschau_aggregator.py core/tests/test_selector_options.py -v
```

Expected: PASS, including the pre-existing `test_extract_content`, `test_process_content_adds_media_header`, and `test_tagesschau_currently_ignores_content_selectors_option`.

- [ ] **Step 5: Run the suite and the linters**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

- [ ] **Step 6: Commit**

```bash
git add core/aggregators/tagesschau/aggregator.py core/tests/test_tagesschau_aggregator.py
git commit -m "fix(tagesschau): Extract external broadcaster pages generically"
```

---

## Task 4: A4 — MacTechNews skips TechTicker roundups

**Files:**
- Modify: `core/aggregators/mactechnews/aggregator.py:1-31` (imports/class head), add `filter_articles`
- Test: `core/tests/test_mactechnews_aggregator.py`

**Interfaces:**
- Consumes: `BaseAggregator.filter_articles(articles) -> List[Dict]` (age check) via `super()`.
- Produces: module constant `TECHTICKER_TITLE_PREFIX = "TechTicker:"`; `MactechnewsAggregator.filter_articles(articles) -> List[Dict[str, Any]]`.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/test_mactechnews_aggregator.py` as a new top-level class (the file's existing fixtures are per-class; define a local one):

```python
@pytest.mark.django_db
class TestMactechnewsTechTickerFilter:
    @pytest.fixture
    def mtn_agg(self, rss_feed):
        rss_feed.aggregator = "mactechnews"
        rss_feed.identifier = "https://www.mactechnews.de/Rss/News.x"
        return MactechnewsAggregator(rss_feed)

    def test_techticker_roundups_are_skipped(self, mtn_agg):
        articles = [
            {"name": "Apple releases iOS 26.2", "date": None},
            {"name": "TechTicker: Kurz notiert am Freitag", "date": None},
        ]

        with patch(
            "core.aggregators.website.FullWebsiteAggregator.filter_articles",
            side_effect=lambda x: x,
        ):
            filtered = mtn_agg.filter_articles(articles)

        assert [a["name"] for a in filtered] == ["Apple releases iOS 26.2"]

    def test_the_word_mid_title_is_kept(self, mtn_agg):
        """Prefix match, not substring: a real article merely mentioning the
        word must survive."""
        articles = [{"name": "Warum der TechTicker beliebt ist", "date": None}]

        with patch(
            "core.aggregators.website.FullWebsiteAggregator.filter_articles",
            side_effect=lambda x: x,
        ):
            filtered = mtn_agg.filter_articles(articles)

        assert len(filtered) == 1

    def test_the_match_is_case_sensitive(self, mtn_agg):
        """Mirrors iOS's hasPrefix. Heise's skip-list is case-INsensitive
        because its terms appear mid-title with varying case (commit 338e62a);
        TechTicker is a generated prefix with a fixed form. Do not unify."""
        articles = [{"name": "techticker: lowercase variant", "date": None}]

        with patch(
            "core.aggregators.website.FullWebsiteAggregator.filter_articles",
            side_effect=lambda x: x,
        ):
            filtered = mtn_agg.filter_articles(articles)

        assert len(filtered) == 1

    def test_missing_title_does_not_raise(self, mtn_agg):
        with patch(
            "core.aggregators.website.FullWebsiteAggregator.filter_articles",
            side_effect=lambda x: x,
        ):
            filtered = mtn_agg.filter_articles([{"date": None}])

        assert len(filtered) == 1
```

Check the file's existing imports — it already imports `pytest`, `patch`, and `MactechnewsAggregator`; add only what is missing.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_mactechnews_aggregator.py::TestMactechnewsTechTickerFilter -v
```

Expected: FAIL on `test_techticker_roundups_are_skipped` (no filter exists yet); the other three pass trivially and exist to lock the contract.

- [ ] **Step 3: Add the filter**

In `core/aggregators/mactechnews/aggregator.py`, add the constant after the imports:

```python
# Recurring "TechTicker:" link-roundup posts are noise. Prefix match, case
# sensitive -- mirroring iOS's shouldInclude. A looser `contains` would drop
# legitimate articles that merely mention the word. Heise's title skip-list is
# deliberately the opposite (substring, case-insensitive); do not unify them.
TECHTICKER_TITLE_PREFIX = "TechTicker:"
```

Widen the typing import to `from typing import Any, Dict, List` and add the method right after `get_configuration_fields`:

```python
    def filter_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Drop TechTicker link roundups, then apply the base age filter."""
        articles = super().filter_articles(articles)

        kept = []
        for article in articles:
            if article.get("name", "").startswith(TECHTICKER_TITLE_PREFIX):
                self.logger.info(
                    f"[filter_articles] Skipping TechTicker roundup: {article.get('name')}"
                )
                continue
            kept.append(article)

        return kept
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_mactechnews_aggregator.py -v
```

- [ ] **Step 5: Run the suite and the linters**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

- [ ] **Step 6: Commit**

```bash
git add core/aggregators/mactechnews/aggregator.py core/tests/test_mactechnews_aggregator.py
git commit -m "fix(mactechnews): Skip TechTicker link roundups"
```

---

## Task 5: A5 — Reddit strips the body's image only after a header renders

**Files:**
- Modify: `core/aggregators/utils/content_formatter.py:1-84` (extract `build_header_html`, add `header_html` param)
- Modify: `core/aggregators/utils/__init__.py:13,28-51` (export)
- Modify: `core/aggregators/reddit/aggregator.py:20` (import), `:531-566` (`process_content`), `:568-647` (`finalize_articles`)
- Test: `core/tests/test_reddit_aggregator.py`

**Interfaces:**
- Produces:
  - `utils.content_formatter.build_header_html(header_image_url: Optional[str], title: str, header_caption_html: Optional[str] = None) -> Optional[str]` — the rendered `<header>…</header>` block, or `None` when no header can be produced (no URL, or a tweet embed whose fetch failed). `""` and `None` must stay distinguishable; conflating them is what caused this bug.
  - `format_article_content(..., header_html: Optional[str] = None)` — when `header_html` is given it is used verbatim; otherwise the header is built from `header_image_url`. Every existing keyword keeps its meaning.
  - `RedditAggregator._inline_header_image(url: str, article: Dict[str, Any]) -> str` — returns a base64 data URI, or `url` unchanged when fetch/encode fails.
  - `article["header_html"]` — internal, set in `finalize_articles`, read by `process_content`, popped before the article leaves.
- Consumes: `fetch_single_image`, `compress_and_encode_image`, `extract_youtube_video_id`, `is_twitter_url`, `self._strip_image_from_content`, `self._strip_youtube_link_from_content` (all existing).

**The bug:** `finalize_articles` strips the body's copy of the image whenever `_reddit_header_image_url` merely *exists* — before knowing whether `include_header_image` is on, and before knowing whether a header can be rendered. For a direct-image/GIF link post the image lives **only** in the body (added by the link-media step), so that removed the sole image with nothing replacing it.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/test_reddit_aggregator.py`:

```python
class TestBuildHeaderHtml:
    """`None` (no header possible) must stay distinguishable from `""`."""

    def test_returns_none_without_a_url(self):
        from core.aggregators.utils.content_formatter import build_header_html

        assert build_header_html(None, title="T") is None
        assert build_header_html("", title="T") is None

    def test_returns_none_when_the_tweet_embed_cannot_be_fetched(self):
        from core.aggregators.utils.content_formatter import build_header_html

        with patch(
            "core.aggregators.utils.content_formatter.build_tweet_embed_html", return_value=None
        ):
            assert build_header_html("https://x.com/a/status/1", title="T") is None

    def test_renders_an_image_header(self):
        from core.aggregators.utils.content_formatter import build_header_html

        header = build_header_html("https://i.redd.it/a.jpg", title="Title")

        assert header is not None
        assert '<img src="https://i.redd.it/a.jpg"' in header
        assert header.startswith("<header")

    def test_renders_a_youtube_header(self):
        from core.aggregators.utils.content_formatter import build_header_html

        header = build_header_html("https://youtu.be/sl2YybDiluQ", title="Title")

        assert header is not None
        assert "youtube-embed-container" in header

    def test_format_article_content_uses_a_prebuilt_header_verbatim(self):
        from core.aggregators.utils.content_formatter import format_article_content

        result = format_article_content(
            content="<p>body</p>",
            title="T",
            url="https://example.com/a",
            header_html="<header>prebuilt</header>",
        )

        assert "<header>prebuilt</header>" in result


@pytest.mark.django_db
class TestRedditDirectImagePostKeepsItsImage:
    """A direct-image/GIF link post has its image ONLY in the body."""

    @pytest.fixture
    def reddit_agg(self, reddit_feed, user_with_settings):
        return RedditAggregator(reddit_feed)

    @staticmethod
    def _gif_article():
        return {
            "name": "Cool GIF",
            "identifier": "https://reddit.com/r/gifs/comments/abc123/cool/",
            "raw_content": '<p><img src="https://i.redd.it/cool.gif"/></p>',
            "content": '<p><img src="https://i.redd.it/cool.gif"/></p>',
            "date": None,
            "author": "someone",
            "_reddit_header_image_url": "https://i.redd.it/cool.gif",
            "_reddit_video_url": None,
        }

    def test_body_image_survives_when_header_images_are_disabled(self, reddit_agg):
        reddit_agg.feed.options = {"include_header_image": False}

        finalized = reddit_agg.finalize_articles([self._gif_article()])

        assert "i.redd.it/cool.gif" in finalized[0]["content"]
        assert "<header" not in finalized[0]["content"]

    @patch("core.aggregators.reddit.aggregator.compress_and_encode_image")
    @patch("core.aggregators.reddit.aggregator.fetch_single_image")
    def test_body_copy_is_stripped_once_a_header_renders(self, mock_fetch, mock_encode, reddit_agg):
        mock_fetch.return_value = {"imageData": b"gif-bytes", "contentType": "image/gif"}
        mock_encode.return_value = {"dataUri": "data:image/gif;base64,AAA"}

        content = reddit_agg.finalize_articles([self._gif_article()])[0]["content"]

        assert "data:image/gif;base64,AAA" in content
        assert "i.redd.it/cool.gif" not in content

    @patch("core.aggregators.reddit.aggregator.build_header_html", return_value=None)
    @patch("core.aggregators.reddit.aggregator.compress_and_encode_image")
    @patch("core.aggregators.reddit.aggregator.fetch_single_image")
    def test_body_image_survives_when_no_header_can_be_rendered(
        self, mock_fetch, mock_encode, mock_header, reddit_agg
    ):
        mock_fetch.return_value = {"imageData": b"gif-bytes", "contentType": "image/gif"}
        mock_encode.return_value = {"dataUri": "data:image/gif;base64,AAA"}

        content = reddit_agg.finalize_articles([self._gif_article()])[0]["content"]

        assert "i.redd.it/cool.gif" in content
        assert "<header" not in content

    @patch("core.aggregators.reddit.aggregator.fetch_single_image", return_value=None)
    def test_failed_download_still_renders_the_header_from_the_original_url(
        self, mock_fetch, reddit_agg
    ):
        """Server behavior, deliberately kept: a failed inline degrades to the
        remote URL, which still shows the image exactly once."""
        content = reddit_agg.finalize_articles([self._gif_article()])[0]["content"]

        assert '<img src="https://i.redd.it/cool.gif"' in content
        assert content.count("i.redd.it/cool.gif") == 1

    def test_internal_keys_do_not_leak(self, reddit_agg):
        reddit_agg.feed.options = {"include_header_image": False}

        finalized = reddit_agg.finalize_articles([self._gif_article()])

        assert "header_html" not in finalized[0]
        assert "_reddit_header_image_url" not in finalized[0]
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_reddit_aggregator.py -k "BuildHeaderHtml or DirectImagePost" -v
```

Expected: FAIL — `build_header_html` does not exist, and `finalize_articles` strips the body image regardless of `include_header_image`.

- [ ] **Step 3: Extract `build_header_html` in the formatter**

Replace the header-building block of `core/aggregators/utils/content_formatter.py` so the module reads:

```python
"""Content formatting utilities."""

from typing import Optional

from .twitter import build_tweet_embed_html, is_twitter_url
from .youtube import create_youtube_embed_html, extract_youtube_video_id


def build_header_html(
    header_image_url: Optional[str],
    title: str,
    header_caption_html: Optional[str] = None,
) -> Optional[str]:
    """
    Build the article's lead-media header, or None when none can be rendered.

    Returning None instead of "" is load-bearing: callers strip a body's
    duplicate image only once a header actually exists for it. Conflating "no
    header" with "empty header" is what made direct-image Reddit posts lose
    their only image.

    Args:
        header_image_url: Image URL, data URI, YouTube URL, or Twitter/X URL
        title: Article title (used for image alt text)
        header_caption_html: Optional HTML to display below the header media

    Returns:
        A <header> block, or None (no URL, or an embed that could not be built)
    """
    if not header_image_url:
        return None

    youtube_video_id = extract_youtube_video_id(header_image_url)
    if youtube_video_id:
        youtube_embed = create_youtube_embed_html(youtube_video_id, header_caption_html or "")
        return "\n".join(
            [
                '<header style="margin-bottom: 1.5em; text-align: center;">',
                youtube_embed,
                "</header>",
            ]
        )

    if is_twitter_url(header_image_url):
        tweet_embed = build_tweet_embed_html(header_image_url)
        if not tweet_embed:
            return None
        return "\n".join(
            ['<header style="margin-bottom: 1.5em;">', tweet_embed, "</header>"]
        )

    header_parts = [
        '<header style="margin-bottom: 1.5em; text-align: center;">',
        f'<img src="{header_image_url}" alt="{title}" style="max-width: 100%; height: auto; border-radius: 8px;">',
    ]
    if header_caption_html:
        header_parts.append(header_caption_html)
    header_parts.append("</header>")
    return "\n".join(header_parts)


def format_article_content(
    content: str,
    title: str,
    url: str,
    header_image_url: Optional[str] = None,
    header_caption_html: Optional[str] = None,
    comments_content: Optional[str] = None,
    header_html: Optional[str] = None,
) -> str:
    """
    Format article content with an optional header, the main content, and a footer.

    Note: Title, author, and date are NOT added to the content as these
    are typically handled by the RSS reader client.

    Args:
        content: Main article content HTML
        title: Article title (used for image alt text)
        url: Article URL (used for footer source link)
        header_image_url: Optional URL of a header image
        header_caption_html: Optional HTML to display below the header image
        comments_content: Optional HTML content for the comments section
        header_html: Pre-built header block, used verbatim when given. Callers
            that must know whether a header rendered build it themselves with
            build_header_html() and pass the result here.

    Returns:
        Formatted HTML string
    """
    parts = []

    header = (
        header_html
        if header_html is not None
        else build_header_html(header_image_url, title, header_caption_html)
    )
    if header:
        parts.append(header)

    # Main content section
    parts.append(f'<section data-sanitized-class="article-content">{content}</section>')

    # Comments section
    if comments_content:
        parts.append(
            f'<section data-sanitized-class="article-comments">{comments_content}</section>'
        )

    # Footer section
    parts.append(
        f'<footer><p>Source: <a href="{url}" target="_blank" rel="noopener">{url}</a></p></footer>'
    )

    return "\n\n".join(parts)
```

Then export it from `core/aggregators/utils/__init__.py`: change the import to
`from .content_formatter import build_header_html, format_article_content` and add
`"build_header_html",` to `__all__`.

- [ ] **Step 4: Run the formatter tests**

```bash
uv run pytest core/tests/test_reddit_aggregator.py::TestBuildHeaderHtml core/tests/test_reddit_aggregator.py::TestContentFormatterYouTubeEmbed core/tests/test_twitter_embed.py -v
```

Expected: PASS. The existing `TestContentFormatterYouTubeEmbed` cases assert the old markup — the refactor must not change a byte of it.

- [ ] **Step 5: Rewire Reddit's `finalize_articles` and `process_content`**

In `core/aggregators/reddit/aggregator.py`, widen the utils import:

```python
from ..utils import build_header_html, format_article_content
```

Replace `process_content` (currently lines 531-566):

```python
    def process_content(self, content: str, article: Dict[str, Any]) -> str:
        """
        Format Reddit content around the header prepared by finalize_articles.

        Uses a header block only (no title/meta) to avoid a redundant masthead.
        """
        header_html = article.get("header_html")

        if header_html is None and self.feed.options.get("include_header_image", True):
            # Article reloads go through the shared header-element extractor
            # instead of the aggregation path, so no header was prepared.
            header_data = article.get("header_data")
            if header_data:
                header_url = getattr(header_data, "base64_data_uri", None) or getattr(
                    header_data, "image_url", None
                )
                header_html = build_header_html(header_url, title=article["name"])

        return format_article_content(
            content=content,
            title=article["name"],
            url=article["identifier"],
            header_html=header_html,
        )
```

Replace the body of the `for article in articles:` loop in `finalize_articles` (currently lines 585-645) with:

```python
        for article in articles:
            include_header_image = self.feed.options.get("include_header_image", True)
            header_source_url = (
                article.get("_reddit_header_image_url") if include_header_image else None
            )

            header_html = None
            if header_source_url:
                is_youtube_header = bool(extract_youtube_video_id(header_source_url))
                is_twitter_header = is_twitter_url(header_source_url)

                # YouTube/Twitter headers are embedded from their source URL;
                # plain images are inlined as base64 (removed in Spec 4).
                render_url = header_source_url
                if not (is_youtube_header or is_twitter_header):
                    render_url = self._inline_header_image(header_source_url, article)

                # Only show "View Video" when the header is not already the video.
                header_caption_html = None
                video_url = article.get("_reddit_video_url")
                if video_url and not is_youtube_header:
                    header_caption_html = f'<p><a href="{video_url}">▶ View Video</a></p>'

                header_html = build_header_html(
                    render_url,
                    title=article["name"],
                    header_caption_html=header_caption_html,
                )

                if header_html and article.get("content"):
                    # Strip the body's duplicate only now that a header was
                    # actually rendered for it. For a direct-image/GIF link post
                    # the image lives ONLY in the body (added by the link-media
                    # step), so stripping it when the header is disabled or
                    # unbuildable removed the sole image with nothing replacing
                    # it -- the GIF vanished entirely.
                    article["content"] = self._strip_image_from_content(
                        article["content"], header_source_url
                    )
                    if is_youtube_header:
                        article["content"] = self._strip_youtube_link_from_content(
                            article["content"], header_source_url
                        )

            article["header_html"] = header_html

            # Process content with formatting. A rendered header is enough on
            # its own: for a direct-image post whose body was nothing but the
            # duplicate image, the strip above empties the body, and skipping
            # formatting here would drop the header too -- the same vanishing
            # act, one step later.
            content = article.get("content", "")
            if content or header_html:
                article["content"] = self.process_content(content, article)

            # Clean up internal Reddit-specific fields
            article.pop("_reddit_post_data", None)
            article.pop("_reddit_subreddit", None)
            article.pop("_reddit_is_cross_post", None)
            article.pop("_reddit_num_comments", None)
            article.pop("_reddit_header_image_url", None)
            article.pop("_reddit_video_url", None)
            article.pop("header_html", None)

            finalized.append(article)

        return finalized

    def _inline_header_image(self, header_image_url: str, article: Dict[str, Any]) -> str:
        """Inline a header image as a base64 data URI, or return it unchanged."""
        if not header_image_url.startswith("http"):
            return header_image_url

        try:
            image_data_result = fetch_single_image(header_image_url)
            if image_data_result:
                encoded = compress_and_encode_image(
                    image_data_result["imageData"],
                    image_data_result["contentType"],
                    is_header=True,
                )
                if encoded:
                    return str(encoded["dataUri"])
        except Exception as e:
            logger.warning(f"Failed to inline header image for {article.get('name')}: {e}")

        return header_image_url
```

`_reddit_video_url` was previously left on the article; popping it alongside the rest is the intended cleanup (the loop is the last consumer).

- [ ] **Step 6: Run the Reddit tests to verify they pass**

```bash
uv run pytest core/tests/test_reddit_aggregator.py core/tests/test_reddit_comments.py core/tests/test_reddit_posts.py -v
```

Expected: PASS, including the pre-existing `TestRedditYouTubeEmbed` cases.

- [ ] **Step 7: Run the suite and the linters**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

- [ ] **Step 8: Commit**

```bash
git add core/aggregators/utils/content_formatter.py core/aggregators/utils/__init__.py core/aggregators/reddit/aggregator.py core/tests/test_reddit_aggregator.py
git commit -m "fix(reddit): Keep a direct-image post's image when no header renders"
```

---

## Task 6: A6 — Recover consent-gated (Embed Privacy) YouTube embeds

**Files:**
- Modify: `core/aggregators/utils/youtube.py:1-16` (imports/logger), `:151-177` (`proxy_youtube_embeds`)
- Test: `core/tests/test_embed_privacy.py` (create)

**Interfaces:**
- Produces: `utils.youtube.recover_consent_gated_embeds(soup: BeautifulSoup) -> None` — mutates in place; each `.embed-privacy-container` becomes a plain YouTube `<iframe>` or is removed. Called first from `proxy_youtube_embeds`, so recovered iframes are proxied like any other embed.
- Consumes: `extract_youtube_video_id(url) -> Optional[str]` (same module).

**Why removal on failure matters:** the consent boilerplate ("Hier klicken, um den Inhalt von YouTube anzuzeigen…") is the *visible* half of the gate; the real player only exists inside a `<script>` template that sanitization strips. Leaving an unrecoverable gate in place is the stray-paragraph bug this fixes.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_embed_privacy.py`:

```python
"""WordPress "Embed Privacy" consent-gate recovery (Spec 2 / A6)."""

import pytest
from bs4 import BeautifulSoup

from core.aggregators.utils.youtube import proxy_youtube_embeds, recover_consent_gated_embeds

CONSENT_TEXT = "Hier klicken, um den Inhalt von YouTube anzuzeigen"


def _gate(href: str | None) -> str:
    link = f'<div class="embed-privacy-url"><a href="{href}">Direkt öffnen</a></div>' if href else ""
    return (
        '<div class="embed-privacy-container">'
        f"<p>{CONSENT_TEXT}</p>"
        f"{link}"
        "</div>"
    )


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
class TestRecoveryRunsBeforeTheProxyPass:
    def test_a_recovered_embed_is_proxied_like_any_other(self):
        soup = BeautifulSoup(_gate("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "html.parser")

        proxy_youtube_embeds(soup)

        html = str(soup)
        assert "youtube-embed-container" in html
        assert "/api/youtube-proxy?v=dQw4w9WgXcQ" in html
        assert CONSENT_TEXT not in soup.get_text()
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_embed_privacy.py -v
```

Expected: FAIL with `ImportError: cannot import name 'recover_consent_gated_embeds'`.

- [ ] **Step 3: Implement recovery in `utils/youtube.py`**

Add `import logging` and `contextlib` to the imports and a module logger (the module has none today):

```python
import contextlib
import logging
import re
from typing import Optional

from django.conf import settings

from bs4 import BeautifulSoup, Tag

logger = logging.getLogger(__name__)

# WordPress' "Embed Privacy" plugin replaces a video <iframe> with a consent
# gate. The real player lives only in a <script> template, which sanitization
# strips, so the visible boilerplate is all that survives.
EMBED_PRIVACY_CONTAINER_SELECTOR = ".embed-privacy-container"
EMBED_PRIVACY_URL_SELECTOR = ".embed-privacy-url a[href]"
```

Add the function directly above `proxy_youtube_embeds`:

```python
def recover_consent_gated_embeds(soup: BeautifulSoup) -> None:
    """
    Turn "Embed Privacy" consent gates back into YouTube iframes.

    The gate's "open directly" footer link is a real anchor that survives
    sanitization, so the canonical URL can be recovered from it. On failure the
    container is removed rather than left in place -- otherwise its consent
    boilerplate leaks into the article as stray paragraphs, which is the bug
    this fixes.

    Args:
        soup: BeautifulSoup object to modify in-place
    """
    for container in soup.select(EMBED_PRIVACY_CONTAINER_SELECTOR):
        try:
            link = container.select_one(EMBED_PRIVACY_URL_SELECTOR)
            href = link.get("href") if isinstance(link, Tag) else None
            if isinstance(href, list):
                href = href[0] if href else None

            video_id = extract_youtube_video_id(str(href)) if href else None
            if not video_id:
                container.decompose()
                continue

            replacement = BeautifulSoup(
                f'<iframe src="https://www.youtube.com/embed/{video_id}"></iframe>',
                "html.parser",
            ).find("iframe")
            if replacement is None:
                container.decompose()
                continue

            container.replace_with(replacement)
        except Exception as exc:
            # One malformed gate must not abort the article.
            logger.warning("Failed to recover a consent-gated embed: %s", exc)
            with contextlib.suppress(Exception):
                container.decompose()
```

Then make `proxy_youtube_embeds` run it first:

```python
def proxy_youtube_embeds(soup: BeautifulSoup) -> None:
    """
    Find and replace YouTube iframes with proxy embeds.

    Consent gates are recovered first so the iframes they hide go through the
    same proxy rewrite as any other embed.

    Args:
        soup: BeautifulSoup object to modify in-place
    """
    recover_consent_gated_embeds(soup)

    for iframe in soup.find_all("iframe"):
        ...  # unchanged
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_embed_privacy.py core/tests/test_caschys_blog_aggregator.py core/tests/test_youtube_proxy.py -v
```

Expected: PASS. Caschy's Blog is the site this targets and its `process_content` reaches `proxy_youtube_embeds` through `super().process_content()`; its existing iframe allow-list test must stay green.

- [ ] **Step 5: Run the suite and the linters**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

- [ ] **Step 6: Commit**

```bash
git add core/aggregators/utils/youtube.py core/tests/test_embed_privacy.py
git commit -m "fix(aggregators): Recover consent-gated YouTube embeds"
```

---

## Task 7: B1 — The Verge aggregator

**Files:**
- Create: `core/aggregators/the_verge/__init__.py`, `core/aggregators/the_verge/aggregator.py`
- Modify: `core/choices.py`, `core/aggregators/registry.py`
- Create: `core/tests/test_the_verge_aggregator.py`
- Generated: `core/migrations/00XX_alter_feed_aggregator.py`

**Interfaces:**
- Consumes: `FullWebsiteAggregator` (extraction, option accessors, `enrich_articles`), `utils.IFRAME_SANITIZE_SELECTOR`.
- Produces: `TheVergeAggregator` registered as `"the_verge"`; `TheVergeAggregator.DEFAULT_FEED = "https://www.theverge.com/rss/index.xml"`.

**Why `uses_first_content_match = True` is essential:** a Verge article page embeds ~22 sibling `article-body-component` divs — the main article **plus** related/"stream" article bodies. Spec 1's union would splice unrelated articles into the body.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_the_verge_aggregator.py`:

```python
import pytest

from core.aggregators.the_verge.aggregator import TheVergeAggregator

BODY_SELECTOR = "duet--article--article-body-component"


@pytest.mark.django_db
class TestTheVergeAggregator:
    @pytest.fixture
    def verge_agg(self, rss_feed):
        rss_feed.aggregator = "the_verge"
        rss_feed.identifier = "https://www.theverge.com/rss/index.xml"
        return TheVergeAggregator(rss_feed)

    def test_default_identifier(self, rss_feed):
        rss_feed.identifier = ""
        agg = TheVergeAggregator(rss_feed)

        assert agg.identifier == "https://www.theverge.com/rss/index.xml"

    def test_identifier_choices_has_only_the_main_feed(self):
        """Section feeds under /<cat>/rss/index.xml return 404."""
        choices = TheVergeAggregator.get_identifier_choices()

        assert choices == [("https://www.theverge.com/rss/index.xml", "Main Feed")]

    def test_source_url(self, verge_agg):
        assert verge_agg.get_source_url() == "https://www.theverge.com"

    def test_extracts_the_article_body(self, verge_agg):
        html = (
            "<html><body>"
            f'<div class="{BODY_SELECTOR}"><p>The real story.</p></div>'
            "</body></html>"
        )

        result = verge_agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "The real story." in result

    def test_keeps_only_the_first_body_component(self, verge_agg):
        """The page repeats the class for related/"stream" stories."""
        html = (
            "<html><body>"
            f'<div class="{BODY_SELECTOR}"><p>Main article.</p></div>'
            f'<div class="{BODY_SELECTOR}"><p>Related story one.</p></div>'
            f'<div class="{BODY_SELECTOR}"><p>Related story two.</p></div>'
            "</body></html>"
        )

        result = verge_agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "Main article." in result
        assert "Related story one." not in result
        assert "Related story two." not in result

    def test_strips_noise_containers(self, verge_agg):
        html = (
            f'<div class="{BODY_SELECTOR}">'
            "<p>Body text.</p>"
            '<div class="duet--ad--slot">Advertisement</div>'
            '<div class="duet--recirculation--related-list">Read more</div>'
            '<div class="newsletter-signup">Subscribe</div>'
            "<aside>Sidebar</aside>"
            "</div>"
        )

        result = verge_agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "Body text." in result
        assert "Advertisement" not in result
        assert "Read more" not in result
        assert "Subscribe" not in result
        assert "Sidebar" not in result

    def test_registry_resolves_the_type(self):
        from core.aggregators.registry import AggregatorRegistry

        assert AggregatorRegistry.get("the_verge") is TheVergeAggregator

    def test_choice_is_offered(self):
        from core.choices import AGGREGATOR_CHOICES

        assert dict(AGGREGATOR_CHOICES)["the_verge"] == "The Verge"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_the_verge_aggregator.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'core.aggregators.the_verge'`.

- [ ] **Step 3: Create the aggregator**

`core/aggregators/the_verge/__init__.py`:

```python
"""The Verge aggregator modules."""

from .aggregator import TheVergeAggregator

__all__ = ["TheVergeAggregator"]
```

`core/aggregators/the_verge/aggregator.py`:

```python
"""The Verge aggregator implementation."""

from typing import Any, List, Optional, Tuple

from ..utils import IFRAME_SANITIZE_SELECTOR
from ..website import FullWebsiteAggregator


class TheVergeAggregator(FullWebsiteAggregator):
    """Aggregator for The Verge (theverge.com) US tech/culture news."""

    THE_VERGE_URL = "https://www.theverge.com"
    DEFAULT_FEED = "https://www.theverge.com/rss/index.xml"

    def __init__(self, feed):
        super().__init__(feed)
        if not self.identifier or self.identifier == "":
            self.identifier = self.DEFAULT_FEED

    def get_source_url(self) -> str:
        """Return The Verge website URL."""
        return self.THE_VERGE_URL

    @classmethod
    def get_identifier_choices(
        cls, query: Optional[str] = None, user: Optional[Any] = None
    ) -> List[Tuple[str, str]]:
        """The only feed The Verge exposes -- section feeds return 404."""
        return [(cls.DEFAULT_FEED, "Main Feed")]

    @classmethod
    def get_default_identifier(cls) -> str:
        """Get default The Verge identifier."""
        return cls.DEFAULT_FEED

    # Essential: the page embeds ~22 sibling article-body-component divs -- the
    # main article plus related/"stream" article bodies. Unioning them would
    # splice unrelated articles into the body.
    uses_first_content_match = True

    # WordPress-backed with Vox's "Duet" design system; the prose lives in
    # .duet--article--dangerously-set-cms-markup blocks inside this container.
    content_selectors = [".duet--article--article-body-component"]

    selectors_to_remove = [
        IFRAME_SANITIZE_SELECTOR,
        "aside",
        "[class*='duet--recirculation']",
        "[class*='duet--ad']",
        "[class*='newsletter']",
        "script",
        "style",
        "noscript",
        "svg",
    ]
```

Register it — in `core/choices.py`, after the `mein_mmo` entry:

```python
    ("mein_mmo", "Mein-MMO"),
    ("the_verge", "The Verge"),
```

In `core/aggregators/registry.py`, add the import (`from .the_verge import TheVergeAggregator`, keeping isort order) and the mapping entry after `"mein_mmo"`:

```python
        "the_verge": TheVergeAggregator,
```

- [ ] **Step 4: Generate the choices migration**

```bash
uv run python manage.py makemigrations core
```

Expected: one `AlterField` migration for `feed.aggregator` (choices only — no SQLite schema change). Then apply it:

```bash
uv run python manage.py migrate
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_the_verge_aggregator.py core/tests/test_selector_options.py core/tests/test_aggregator_registry.py -v
```

Expected: PASS — including `test_scrapers_with_a_dedicated_container_opt_out`, which walks the registry and requires `uses_first_content_match is True` for every scraper except MacTechNews.

- [ ] **Step 6: Run the suite and the linters**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest && uv run python manage.py makemigrations --check --dry-run
```

- [ ] **Step 7: Commit**

```bash
git add core/aggregators/the_verge core/choices.py core/aggregators/registry.py core/migrations core/tests/test_the_verge_aggregator.py
git commit -m "feat(aggregators): Add The Verge aggregator"
```

---

## Task 8: B2 — Ars Technica aggregator (the one scraper that unions)

**Files:**
- Create: `core/aggregators/ars_technica/__init__.py`, `core/aggregators/ars_technica/aggregator.py`
- Modify: `core/choices.py`, `core/aggregators/registry.py`, `core/tests/test_selector_options.py:96-114`
- Create: `core/tests/test_ars_technica_aggregator.py`
- Generated: `core/migrations/00XX_alter_feed_aggregator.py`

**Interfaces:**
- Consumes: `FullWebsiteAggregator` default union extraction (`uses_first_content_match = False`), `utils.IFRAME_SANITIZE_SELECTOR`.
- Produces: `ArsTechnicaAggregator` registered as `"ars_technica"`; `ArsTechnicaAggregator.DEFAULT_FEED = "https://arstechnica.com/feed/"`.

**Why it unions:** Ars renders every "page" of an article in the single fetched HTML as sibling `div.post-content.post-content-double` blocks separated by `<a data-page="N">` trackers. Even a single-page news article splits into 2 genuine blocks, so first-match would **truncate** the article. Blocks are distinct segments — **do not de-duplicate them**. No extra HTTP fetches: appending `/N/` to an Ars URL redirects to a `#page-N` anchor on the same URL.

The Verge and Ars are instructive as a pair: they need **opposite** settings of the same flag.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_ars_technica_aggregator.py`:

```python
import pytest

from core.aggregators.ars_technica.aggregator import ArsTechnicaAggregator


@pytest.mark.django_db
class TestArsTechnicaAggregator:
    @pytest.fixture
    def ars_agg(self, rss_feed):
        rss_feed.aggregator = "ars_technica"
        rss_feed.identifier = "https://arstechnica.com/feed/"
        return ArsTechnicaAggregator(rss_feed)

    def test_default_identifier(self, rss_feed):
        rss_feed.identifier = ""
        agg = ArsTechnicaAggregator(rss_feed)

        assert agg.identifier == "https://arstechnica.com/feed/"

    def test_identifier_choices(self):
        choices = ArsTechnicaAggregator.get_identifier_choices()

        assert choices == [
            ("https://arstechnica.com/feed/", "Main Feed"),
            ("https://arstechnica.com/gadgets/feed/", "Gadgets"),
            ("https://arstechnica.com/science/feed/", "Science"),
            ("https://arstechnica.com/gaming/feed/", "Gaming"),
        ]

    def test_source_url(self, ars_agg):
        assert ars_agg.get_source_url() == "https://arstechnica.com"

    def test_merges_every_in_page_post_content_block(self, ars_agg):
        """Even single-page articles split into multiple .post-content blocks --
        keeping only the first would truncate the article."""
        html = (
            "<html><body>"
            '<div class="post-content post-content-double"><p>Segment one.</p></div>'
            '<a data-page="2">Page 2</a>'
            '<div class="post-content post-content-double"><p>Segment two.</p></div>'
            "</body></html>"
        )

        result = ars_agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "Segment one." in result
        assert "Segment two." in result

    def test_does_not_deduplicate_repeated_segment_text(self, ars_agg):
        """Blocks are distinct article segments, not repeats."""
        html = (
            '<div class="post-content"><p>Same words.</p></div>'
            '<div class="post-content"><p>Same words.</p></div>'
        )

        result = ars_agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert result.count("Same words.") == 2

    def test_strips_ad_and_share_containers(self, ars_agg):
        html = (
            '<div class="post-content">'
            "<p>Body text.</p>"
            '<div class="ad--mid-content">Advertisement</div>'
            '<div class="ad-wrapper-rail">Rail ad</div>'
            '<div class="social-share">Share this</div>'
            "<aside>Sidebar</aside>"
            "</div>"
        )

        result = ars_agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "Body text." in result
        assert "Advertisement" not in result
        assert "Rail ad" not in result
        assert "Share this" not in result
        assert "Sidebar" not in result

    def test_unions_matches_by_design(self):
        assert ArsTechnicaAggregator.uses_first_content_match is False

    def test_registry_resolves_the_type(self):
        from core.aggregators.registry import AggregatorRegistry

        assert AggregatorRegistry.get("ars_technica") is ArsTechnicaAggregator

    def test_choice_is_offered(self):
        from core.choices import AGGREGATOR_CHOICES

        assert dict(AGGREGATOR_CHOICES)["ars_technica"] == "Ars Technica"
        assert len(AGGREGATOR_CHOICES) == 16
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_ars_technica_aggregator.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'core.aggregators.ars_technica'`.

- [ ] **Step 3: Create the aggregator**

`core/aggregators/ars_technica/__init__.py`:

```python
"""Ars Technica aggregator modules."""

from .aggregator import ArsTechnicaAggregator

__all__ = ["ArsTechnicaAggregator"]
```

`core/aggregators/ars_technica/aggregator.py`:

```python
"""Ars Technica aggregator implementation."""

from typing import Any, List, Optional, Tuple

from ..utils import IFRAME_SANITIZE_SELECTOR
from ..website import FullWebsiteAggregator


class ArsTechnicaAggregator(FullWebsiteAggregator):
    """Aggregator for Ars Technica (arstechnica.com) US tech/science news."""

    ARS_TECHNICA_URL = "https://arstechnica.com"
    DEFAULT_FEED = "https://arstechnica.com/feed/"

    def __init__(self, feed):
        super().__init__(feed)
        if not self.identifier or self.identifier == "":
            self.identifier = self.DEFAULT_FEED

    def get_source_url(self) -> str:
        """Return the Ars Technica website URL."""
        return self.ARS_TECHNICA_URL

    @classmethod
    def get_identifier_choices(
        cls, query: Optional[str] = None, user: Optional[Any] = None
    ) -> List[Tuple[str, str]]:
        """Get available Ars Technica RSS feed choices."""
        return [
            (cls.DEFAULT_FEED, "Main Feed"),
            ("https://arstechnica.com/gadgets/feed/", "Gadgets"),
            ("https://arstechnica.com/science/feed/", "Science"),
            ("https://arstechnica.com/gaming/feed/", "Gaming"),
        ]

    @classmethod
    def get_default_identifier(cls) -> str:
        """Get default Ars Technica identifier."""
        return cls.DEFAULT_FEED

    # The one scraper for which unioning is exactly right: Ars serves every
    # "page" of an article in the single fetched HTML as sibling
    # div.post-content.post-content-double blocks separated by <a data-page="N">
    # trackers, and even a single-page news article splits into 2 genuine
    # blocks. First-match would truncate the article. The blocks are distinct
    # segments, never repeats, so they are not de-duplicated. Appending /N/ to
    # an Ars URL only redirects to a #page-N anchor on the same URL, so no
    # pagination fetching is needed either.
    uses_first_content_match = False

    content_selectors = [".post-content"]

    selectors_to_remove = [
        IFRAME_SANITIZE_SELECTOR,
        ".ad",
        "[class*='ad-wrapper']",
        ".ad--mid-content",
        ".ad--rail",
        ".social-share",
        "aside",
        "script",
        "style",
        "noscript",
        "svg",
    ]
```

Register it — `core/choices.py`, after `the_verge`:

```python
    ("the_verge", "The Verge"),
    ("ars_technica", "Ars Technica"),
```

`core/aggregators/registry.py`: add `from .ars_technica import ArsTechnicaAggregator` (isort order puts it near the top) and the mapping entry after `"the_verge"`:

```python
        "ars_technica": ArsTechnicaAggregator,
```

- [ ] **Step 4: Update the first-match registry sweep**

`core/tests/test_selector_options.py::TestFirstMatchOptOut::test_scrapers_with_a_dedicated_container_opt_out` currently hardcodes MacTechNews as the sole union scraper. Replace its body with a named exemption set:

```python
    def test_scrapers_with_a_dedicated_container_opt_out(self):
        from core.aggregators.ars_technica import ArsTechnicaAggregator
        from core.aggregators.mactechnews.aggregator import MactechnewsAggregator
        from core.aggregators.registry import AggregatorRegistry

        assert FullWebsiteAggregator.uses_first_content_match is False

        # Scrapers whose page legitimately holds the body in SIBLING containers,
        # where keeping only the first match would truncate the article:
        #   MacTechNews -- fetch_all_pages combines pages into sibling
        #     .MtnArticle containers (one per fetched page).
        #   Ars Technica -- the single fetched page already contains sibling
        #     .post-content blocks, one per article "page".
        union_scrapers = {MactechnewsAggregator, ArsTechnicaAggregator}

        for name, agg_class in AggregatorRegistry.get_all().items():
            if agg_class is FullWebsiteAggregator or not issubclass(
                agg_class, FullWebsiteAggregator
            ):
                continue
            if agg_class in union_scrapers:
                assert agg_class.uses_first_content_match is False, name
                continue
            assert agg_class.uses_first_content_match is True, name
```

- [ ] **Step 5: Generate the choices migration**

```bash
uv run python manage.py makemigrations core && uv run python manage.py migrate
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_ars_technica_aggregator.py core/tests/test_selector_options.py core/tests/test_choices.py -v
```

- [ ] **Step 7: Run the suite and the linters**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest && uv run python manage.py makemigrations --check --dry-run
```

- [ ] **Step 8: Commit**

```bash
git add core/aggregators/ars_technica core/choices.py core/aggregators/registry.py core/migrations core/tests/test_ars_technica_aggregator.py core/tests/test_selector_options.py
git commit -m "feat(aggregators): Add Ars Technica aggregator with merged page blocks"
```

---

## Task 9: C — mein_mmo comment options

**Files:**
- Create: `core/aggregators/mein_mmo/comment_extractor.py`
- Modify: `core/aggregators/mein_mmo/aggregator.py:1-9` (imports), `:41-53` (`get_configuration_fields`), `:78-123` (`fetch_article_content`), `:137-180` (`process_content`)
- Test: `core/tests/test_mein_mmo_aggregator.py`

**Interfaces:**
- Produces: `mein_mmo.comment_extractor.extract_comments(html: str, article_url: str, max_comments: int = 5, logger: Optional[logging.Logger] = None) -> Optional[str]` — same signature and output shape as `mactechnews.comment_extractor.extract_comments`; returns an HTML `<section>` or `None`.
- Produces: `MeinMmoAggregator._first_page_html: Optional[str]` — the last fetched first-page HTML, used as the comment source.
- Consumes: `utils.format_article_content(..., comments_content=...)`.

**wpDiscuz DOM (from iOS):** thread container `div.wpd-thread-list`; each comment (including nested replies) is a `div.wpd-comment`; author `div.wpd-comment-author` (prefer the inner `<a>` text); date `div.wpd-comment-date` (prefer its `title` attribute); text `div.wpd-comment-text`; the anchor id lives on the inner `div.wpd-comment-right`. Within one comment element, `select_one` resolves to that comment's own fields because a parent's fields precede any nested reply's in document order.

**Why the first page:** `mein_mmo/multipage_handler.fetch_all_pages()` returns *only* the concatenated `div.entry-content` blocks, so `article["raw_content"]` loses the comment thread for multi-page articles.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/test_mein_mmo_aggregator.py` (check the existing imports first; add `from unittest.mock import patch` and `pytest` if absent):

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_mein_mmo_aggregator.py -v
```

Expected: FAIL — `core.aggregators.mein_mmo.comment_extractor` does not exist and the option fields are absent.

- [ ] **Step 3: Create the comment extractor**

`core/aggregators/mein_mmo/comment_extractor.py`:

```python
"""Comment extraction for Mein-MMO articles (wpDiscuz)."""

import logging
from typing import Optional

from bs4 import BeautifulSoup, Tag


def extract_comments(
    html: str,
    article_url: str,
    max_comments: int = 5,
    logger: Optional[logging.Logger] = None,
) -> Optional[str]:
    """
    Extract wpDiscuz comments from a Mein-MMO article page.

    Comments are server-rendered on the article page itself (outside the content
    div), so they survive selectors_to_remove and are read from the raw page
    HTML. Output mirrors the Heise/MacTechNews comment shape.

    Args:
        html: Full article page HTML
        article_url: Article URL for building anchor links
        max_comments: Maximum number of comments to extract
        logger: Optional logger instance

    Returns:
        HTML string with formatted comments, or None if no comments found
    """
    if max_comments <= 0:
        return None

    if logger is None:
        logger = logging.getLogger(__name__)

    soup = BeautifulSoup(html, "html.parser")

    thread = soup.select_one("div.wpd-thread-list")
    if not thread:
        logger.debug("No wpd-thread-list container found")
        return None

    comments = thread.select("div.wpd-comment")
    if not comments:
        logger.debug("No wpd-comment elements found")
        return None

    logger.info(f"Found {len(comments)} comments, extracting up to {max_comments}")

    comment_parts = []
    for comment_el in comments[:max_comments]:
        comment_html = _process_comment(comment_el, article_url)
        if comment_html:
            comment_parts.append(comment_html)

    if not comment_parts:
        return None

    comments_url = f"{article_url}#comments"
    header = f'<h3><a href="{comments_url}">Comments</a></h3>'
    return f"<section>{header}{''.join(comment_parts)}</section>"


def _process_comment(comment_el: Tag, article_url: str) -> Optional[str]:
    """Process a single wpDiscuz comment element into a blockquote.

    Every field is read with select_one *within* the comment element: in
    document order a parent's own fields precede any nested reply's, so this
    always resolves to this comment rather than a child.
    """
    author = "Unknown"
    author_el = comment_el.select_one("div.wpd-comment-author")
    if author_el:
        link = author_el.select_one("a")
        text = link.get_text(strip=True) if link else author_el.get_text(strip=True)
        if text:
            author = text

    timestamp = ""
    date_el = comment_el.select_one("div.wpd-comment-date")
    if date_el:
        title = date_el.get("title")
        if isinstance(title, list):
            title = title[0] if title else None
        timestamp = str(title) if title else date_el.get_text(strip=True)

    text_el = comment_el.select_one("div.wpd-comment-text")
    if not text_el:
        return None

    comment_text = text_el.decode_contents()
    if not comment_text.strip():
        return None

    anchor_url = f"{article_url}#comments"
    right_el = comment_el.select_one("div.wpd-comment-right")
    if right_el:
        comment_id = right_el.get("id")
        if isinstance(comment_id, list):
            comment_id = comment_id[0] if comment_id else None
        if comment_id:
            anchor_url = f"{article_url}#{comment_id}"

    ts_display = f" ({timestamp})" if timestamp else ""

    return (
        f"<blockquote>"
        f"<p><strong>{author}</strong>{ts_display} | "
        f'<a href="{anchor_url}">source</a></p>'
        f"<div>{comment_text}</div>"
        f"</blockquote>"
    )
```

- [ ] **Step 4: Wire the options into the aggregator**

In `core/aggregators/mein_mmo/aggregator.py`, import the extractor — isort puts
`comment_extractor` before `content_extraction`, so the local import block becomes:

```python
from .comment_extractor import extract_comments
from .content_extraction import extract_mein_mmo_content
from .multipage_handler import detect_pagination, fetch_all_pages
```

Add the two fields to `get_configuration_fields`, after `combine_pages`:

```python
            "include_comments": forms.BooleanField(
                initial=True,
                label="Include Comments",
                help_text="Extract wpDiscuz reader comments from the article page.",
                required=False,
            ),
            "max_comments": forms.IntegerField(
                initial=5,
                label="Max Comments",
                help_text="Maximum number of comments to extract per article.",
                required=False,
                min_value=0,
                max_value=20,
            ),
```

Remember the first page in `fetch_article_content` — add the instance attribute in `__init__`:

```python
    def __init__(self, feed):
        super().__init__(feed)
        # Comment source: fetch_all_pages returns only the combined
        # entry-content blocks, so the multi-page raw_content has no thread.
        self._first_page_html: Optional[str] = None
        # Use Mein-MMO RSS feed if identifier is not set
        if not self.identifier or self.identifier == "":
            self.identifier = "https://mein-mmo.de/feed/"
```

and record it right after the first fetch in `fetch_article_content`:

```python
        first_page_html = super().fetch_article_content(url)
        self._first_page_html = first_page_html
```

Add comments to `process_content`, replacing its `format_article_content` call:

```python
        # wpDiscuz comments live on the article page outside the content div.
        comments_html = None
        include_comments = self.feed.options.get("include_comments", True)
        max_comments = self.feed.options.get("max_comments", 5)

        if include_comments:
            try:
                comment_source = self._first_page_html or article.get("raw_content", "")
                if comment_source:
                    comments_html = extract_comments(
                        comment_source,
                        article["identifier"],
                        max_comments=max_comments,
                        logger=self.logger,
                    )
            except Exception as e:
                self.logger.warning(f"[process_content] Failed to extract comments: {e}")

        # Format with header (image only), comments, and footer
        self.logger.debug("[process_content] Formatting content with header image only")
        formatted = format_article_content(
            cleaned,
            title=article["name"],
            url=article["identifier"],
            header_image_url=header_image_url,
            comments_content=comments_html,
        )
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_mein_mmo_aggregator.py -v
```

- [ ] **Step 6: Run the suite and the linters**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

- [ ] **Step 7: Commit**

```bash
git add core/aggregators/mein_mmo core/tests/test_mein_mmo_aggregator.py
git commit -m "feat(mein_mmo): Add include_comments and max_comments options"
```

---

## Task 10: Docs and end-to-end verification

**Files:**
- Modify: `CLAUDE.md:13,77,219` (14 → 16)
- Modify: `core/aggregators/README.md:19-33` (two new entries)
- Modify: `core/tests/test_selector_options.py:193-212` (stale "gap" docstring)

- [ ] **Step 1: Update the aggregator counts in `CLAUDE.md`**

Three edits, values only:
- line 13: `- 14 pluggable aggregator implementations` → `16`
- line 77: `│   ├── choices.py                # AGGREGATOR_CHOICES (14 types)` → `(16 types)`
- line 219: `| 14 aggregator types |` → `| 16 aggregator types |`

- [ ] **Step 2: List the new aggregators in `core/aggregators/README.md`**

Under **Managed Aggregators (Site-Specific)**, after the `MeinMmoAggregator` line:

```markdown
- `TheVergeAggregator` - The Verge (first content match only: the page embeds related article bodies)
- `ArsTechnicaAggregator` - Ars Technica (merges every in-page `.post-content` block)
```

- [ ] **Step 3: Correct the stale "documented gap" docstring**

In `core/tests/test_selector_options.py`, rename and re-document the Tagesschau case (the behavior is unchanged and now deliberate):

```python
    def test_tagesschau_ignores_the_content_selectors_option_by_design(self, rss_feed):
        """TagesschauAggregator.extract_content runs its bespoke textabsatz
        parser first and only falls back to the shared generic extractor (which
        uses DEFAULT_CONTENT_SELECTORS, not get_content_selectors()). A feed's
        content_selectors option therefore has no effect -- deliberate as of
        Spec 2 / A3, not a gap.
        """
```

Leave the `mein_mmo` case's docstring alone except for its final sentence — Spec 2 does not rewire mein_mmo's extractor either, so change "A feed's `content_selectors` option has no effect until this is rewired. See docs/…-parity-2-…" to "A feed's `content_selectors` option has no effect. Spec 2 deliberately left this alone; the bespoke extractor is the point of the aggregator."

- [ ] **Step 4: Verify the docs mention nothing stale**

```bash
grep -rn "14 " CLAUDE.md core/aggregators/README.md | grep -i aggregat
grep -rn "until Spec 2\|Documented gap for Spec 2" core/
```

Expected: no output from either command.

- [ ] **Step 5: Run the whole suite and every check**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest && uv run python manage.py makemigrations --check --dry-run
```

Expected: all green, no pending migrations.

- [ ] **Step 6: Manual verification via admin and `test_aggregator`**

These need network access and a running DB; report the output rather than asserting on it.

```bash
uv run python manage.py migrate
```

```bash
uv run python manage.py test_aggregator the_verge --dry-run --verbose --limit 2 --first 1
```

```bash
uv run python manage.py test_aggregator ars_technica --dry-run --verbose --limit 2 --first 1
```

Confirm: The Verge bodies carry no unrelated article text; Ars bodies contain every segment (not truncated at the first `.post-content`).

Then, in `http://localhost:8000/admin/` (`uv run python manage.py runserver`):
1. Create a The Verge feed and an Ars Technica feed — both must appear in the aggregator dropdown with the display names "The Verge" / "Ars Technica", and the identifier picker must offer 1 and 4 feeds respectively.
2. For an existing Heise feed: `uv run python manage.py test_aggregator <heise id> --first 1 --verbose` — no navigation text in the body.
3. For an existing Caschy's Blog feed: `uv run python manage.py test_aggregator <caschys id> --first 1 --verbose` — no "Hier klicken, um den Inhalt von YouTube anzuzeigen" boilerplate.
4. Open a few resulting articles in admin and read the `content` field.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md core/aggregators/README.md core/tests/test_selector_options.py
git commit -m "docs(aggregators): Document the two new types and the Spec 2 end state"
```

---

## Spec coverage map

| Spec item | Task |
|---|---|
| A1 Merkur follow buttons | 1 |
| A2 Heise article body, not site navigation | 2 (Spec 1 already landed `#meldung` + first-match — deviation 1) |
| A3 Tagesschau empty external-broadcaster articles | 3 |
| A4 MacTechNews TechTicker skip | 4 |
| A5 Reddit direct-image/GIF header vs body | 5 |
| A6 Embed Privacy consent-gate recovery | 6 |
| B1 The Verge | 7 |
| B2 Ars Technica | 8 |
| C mein_mmo `include_comments` / `max_comments` | 9 |
| Registry/choices resolution, 14 → 16 | 7, 8 (asserted in both new test files) |
| Testing table (per-item cases) | 1–9, one class per item |
| Verification via admin | 10 |
| Out of scope: Spec 3/4/5 items, MKBHD, extra per-feed toggles | not planned — see Global Constraints |
