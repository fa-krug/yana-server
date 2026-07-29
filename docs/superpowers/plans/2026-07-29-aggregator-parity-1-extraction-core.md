# Aggregator Parity 1 — Extraction Core & Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the server's shared extraction code to iOS parity — selector *lists* unioned instead of a single first match, `use_full_content` removed, `<template>` stripped, and real article publish dates preserved.

**Architecture:** All four changes land in shared code that the 14 aggregators inherit: `core/aggregators/utils/content_extractor.py` (selection + sanitization), `core/aggregators/website.py` (option plumbing and fallback hooks), `core/aggregators/base.py` (date filter, `uses_first_content_match` flag), plus two Django migrations (options conversion, `created_at` indexes). Per-scraper selector tuning is Spec 2 and explicitly out of scope here.

**Tech Stack:** Python 3.13, Django 6.0, BeautifulSoup 4 / soupsieve, pytest + pytest-django, ruff, mypy, uv.

**Spec:** [2026-07-29-aggregator-parity-1-extraction-core-design.md](../specs/2026-07-29-aggregator-parity-1-extraction-core-design.md)

## Global Constraints

- Line length 100, double quotes, `ruff format` output. Enabled ruff rules: `E`, `F`, `W`, `I`, `B`, `SIM`, `C4`, `DJ`.
- Every command runs under `uv run` (no venv activation).
- Type hints on all new/changed function signatures; `uv run mypy core/` must stay clean.
- Commit format `<type>(<scope>): <Description>` — e.g. `feat(aggregators): Union content selector lists`.
- The generic-fallback text floor is **exactly 80 characters** — iOS's shipped value. Do not round it.
- `DEFAULT_CONTENT_SELECTORS` and `DEFAULT_IGNORE_SELECTORS` are copied verbatim from iOS's shipped
  `AggregatorOptions.swift` (4 and 8 entries respectively). Do not "improve" the lists.
- Mandatory sanitization is hardcoded and no user option may disable it. It splits in two:
  `script`, `style`, `noscript`, `template` live in the extractor's `MANDATORY_REMOVE_SELECTORS`;
  the non-YouTube `iframe` rule stays "hardcoded in the aggregator" (spec §1) as
  `IFRAME_SANITIZE_SELECTOR` in `FullWebsiteAggregator.selectors_to_remove`. See deviation 7.
- Do **not** touch per-scraper selector values (Spec 2), feed URL discovery (Spec 3), base64 image
  conversion (Spec 4), or block conversion (Spec 5).
- Run `uv run pytest` at the end of every task. A task is not done while any test fails.

## Deviations from the spec (deliberate, reviewed)

1. **`extract_main_content` also takes `first_match_only`.** The spec puts the flag only on the
   `_if_present` variant, but `BaseAggregator.uses_first_content_match` must be honored on the
   normal path too (generic `full_website` feeds go through it). It is an extra keyword with a
   `False` default, so the spec's signature stays valid.
2. **Class attribute renamed `content_selector` → `content_selectors: list[str]`.** The spec only
   renames the *option* keys, but the class attribute feeds the same list parameter; keeping a
   singular string attribute next to a plural list option guarantees confusion. Spec 2's prose uses
   the singular name for new scrapers — read those as the plural list attribute.
3. **The flag is not uniform across managed scrapers.** The spec introduces the hook and leaves the
   per-scraper flip to Spec 2. The rule this plan actually applies: a scraper whose fetch step
   yields a *single* page sets `uses_first_content_match = True`, because leaving it on the union
   would *introduce* the exact Heise navigation bug the hook exists to prevent. MacTechNews is the
   one exception — its multipage fetch (`fetch_all_pages`) deliberately returns combined HTML as
   sibling `.MtnArticle` containers, one per page, so it keeps `uses_first_content_match = False` and
   unions them; a whole-branch review caught that the first draft of this plan set it to `True`
   uniformly, which would have silently re-truncated multipage articles to page 1. Spec 2 can relax
   individual scrapers further.
4. **`filter_articles` normalizes naive datetimes to aware.** Not in the spec, but required: today
   every date is replaced by an aware `timezone.now()`, so naive dates never reached the ORM. Once we
   stop rewriting, `parsedate_to_datetime` results without a timezone would hit SQLite as naive and
   trigger Django's naive-datetime warning. Normalizing the *representation* preserves the instant;
   it is not a rewrite.
5. **`AggregatorService` also stops overwriting the date.** The spec names only
   `base.py filter_articles`, but `core/services/aggregator_service.py:106` hardcodes
   `date=timezone.now()` on create. Without this the whole of spec §4 is a no-op.
6. **The non-YouTube `iframe` rule is not in the extractor's mandatory set.** Spec §1 groups it with
   the mandatory removals, but it also says those "stay hardcoded **in the aggregator**" — and that
   is where the iframe rule lives today, in `FullWebsiteAggregator.selectors_to_remove`. Caschys
   deliberately *omits* it from its own class list so Twitter/X embeds survive extraction and reach
   its `process_content` allow-list (`core/tests/test_caschys_blog_aggregator.py::test_iframe_filtering`).
   Moving the rule into the extractor would make that allow-list unreachable and silently kill
   Twitter embeds. So: the extractor's `MANDATORY_REMOVE_SELECTORS` is `script`, `style`, `noscript`,
   `template`; the iframe rule becomes the named constant `IFRAME_SANITIZE_SELECTOR`, kept in
   `FullWebsiteAggregator.selectors_to_remove` where a feed's `ignore_selectors` still cannot
   disable it (options only add to the class list).
7. **Blank admin selector input means "use defaults", not "explicitly empty".** The read path honors
   an explicit `[]` when the key is present (per spec), but a blank admin field cleans to `None` and
   `save_options` drops the key — otherwise the first save of any feed would silently write `[]` and
   disable the defaults. A deliberate empty list is reachable via fixtures/API; Spec 3 owns the UI.

---

## File Structure

**Modified**
- `core/aggregators/utils/content_extractor.py` — selection, union, nesting resolution, mandatory
  sanitization, both public extract functions, the shared default lists.
- `core/aggregators/utils/__init__.py` — exports.
- `core/aggregators/base.py` — `uses_first_content_match`, `save_options` key-drop, `filter_articles`.
- `core/aggregators/website.py` — option accessors, config fields, `generic_content_if_present`,
  `use_full_content` removal.
- `core/aggregators/rss.py` — timezone-aware `_parse_date`.
- `core/aggregators/{heise,merkur,tagesschau,explosm,dark_legacy,caschys_blog,mactechnews,oglaf,mein_mmo}/aggregator.py`
  — attribute rename + `uses_first_content_match`.
- `core/aggregators/mactechnews/multipage_handler.py` — selector list parameter.
- `core/services/aggregator_service.py` — persist the real date.
- `core/models.py` — two `Article` indexes.
- `core/management/commands/test_aggregator.py` — `--selector-debug` output.
- `CLAUDE.md`, `core/aggregators/README.md` — docs.

**Created**
- `core/aggregators/form_fields.py` — `SelectorListField`.
- `core/aggregators/utils/legacy_options.py` — pure option-conversion helpers (testable, imported by
  the migration).
- `core/migrations/0027_migrate_selector_options.py`
- `core/migrations/0028_article_created_at_indexes.py`
- `core/tests/test_content_extractor.py`
- `core/tests/test_selector_options.py`
- `core/tests/test_legacy_options_migration.py`
- `core/tests/test_article_dates.py`

---

## Task 1: Selector-list extraction core

**Files:**
- Modify: `core/aggregators/utils/content_extractor.py` (full rewrite)
- Modify: `core/aggregators/utils/__init__.py`
- Modify: `core/aggregators/website.py:117-131` (call site only)
- Modify: `core/aggregators/merkur/aggregator.py:135-137` (call site only)
- Test: `core/tests/test_content_extractor.py` (create)
- Test: `core/tests/test_caschys_blog_aggregator.py:96` and `:129` (call sites)
- Test: `core/tests/test_merkur_aggregator.py:31` (assertion)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `MANDATORY_REMOVE_SELECTORS: list[str]`
  - `DEFAULT_CONTENT_SELECTORS: list[str]`, `DEFAULT_IGNORE_SELECTORS: list[str]`
  - `select_content_elements(root: BeautifulSoup | Tag, content_selectors: list[str], first_match_only: bool = False) -> list[Tag]`
  - `extract_main_content(html: str, content_selectors: list[str], remove_selectors: list[str] | None = None, first_match_only: bool = False) -> str`
  - `extract_main_content_if_present(html: str, content_selectors: list[str], remove_selectors: list[str] | None = None, first_match_only: bool = False) -> str | None`

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_content_extractor.py`:

```python
"""Tests for the shared content extraction core."""

from core.aggregators.utils.content_extractor import (
    DEFAULT_CONTENT_SELECTORS,
    DEFAULT_IGNORE_SELECTORS,
    IFRAME_SANITIZE_SELECTOR,
    extract_main_content,
    extract_main_content_if_present,
    select_content_elements,
)


class TestSelectorUnion:
    def test_sibling_containers_both_captured(self):
        """The truncation this change fixes: two sibling matches, both kept."""
        html = """
        <html><body>
          <article><p>first half</p></article>
          <article><p>second half</p></article>
        </body></html>
        """

        result = extract_main_content(html, content_selectors=["article"])

        assert "first half" in result
        assert "second half" in result

    def test_nested_match_dropped_outermost_wins(self):
        html = "<html><body><main><article><p>body text</p></article></main></body></html>"

        result = extract_main_content(html, content_selectors=["main", "article"])

        assert result.count("body text") == 1
        assert result.strip().startswith("<main")

    def test_element_matched_by_two_selectors_appears_once(self):
        html = '<html><body><article class="entry-content"><p>once</p></article></body></html>'

        result = extract_main_content(html, content_selectors=["article", ".entry-content"])

        assert result.count("once") == 1

    def test_output_is_document_order_not_selector_order(self):
        html = """
        <html><body>
          <div class="entry-content"><p>alpha</p></div>
          <section class="article-content"><p>beta</p></section>
        </body></html>
        """

        result = extract_main_content(
            html, content_selectors=[".article-content", ".entry-content"]
        )

        assert result.index("alpha") < result.index("beta")

    def test_first_match_only_keeps_first_sibling(self):
        html = """
        <html><body>
          <article><p>keep me</p></article>
          <article><p>teaser card</p></article>
        </body></html>
        """

        result = extract_main_content(html, content_selectors=["article"], first_match_only=True)

        assert "keep me" in result
        assert "teaser card" not in result

    def test_select_content_elements_returns_tags_in_document_order(self):
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(
            "<body><p id='a' class='x'>1</p><p id='b' class='x'>2</p></body>", "html.parser"
        )

        elements = select_content_elements(soup, [".x"])

        assert [element["id"] for element in elements] == ["a", "b"]


class TestRemoveSelectors:
    def test_ignore_selectors_applied_to_every_container(self):
        html = """
        <html><body>
          <article><p>keep one</p><div class="ad">buy</div></article>
          <article><p>keep two</p><div class="ad">buy</div></article>
        </body></html>
        """

        result = extract_main_content(
            html, content_selectors=["article"], remove_selectors=[".ad"]
        )

        assert "keep one" in result
        assert "keep two" in result
        assert "buy" not in result

    def test_invalid_selector_is_skipped_and_others_still_apply(self):
        html = "<html><body><article><p>survivor</p></article></body></html>"

        result = extract_main_content(html, content_selectors=["!!!nonsense", "article"])

        assert "survivor" in result

    def test_invalid_remove_selector_is_skipped(self):
        html = '<html><body><article><p>text</p><div class="ad">buy</div></article></body></html>'

        result = extract_main_content(
            html, content_selectors=["article"], remove_selectors=["!!!nonsense", ".ad"]
        )

        assert "text" in result
        assert "buy" not in result


class TestFallbackBehavior:
    def test_no_match_falls_back_to_body(self):
        html = "<html><body><div class='mystery'>only content</div></body></html>"

        result = extract_main_content(html, content_selectors=["article"])

        assert "only content" in result

    def test_fallback_still_applies_remove_selectors(self):
        html = """
        <html><body><div class="mystery">only content</div><div class="ad">buy</div></body></html>
        """

        result = extract_main_content(
            html, content_selectors=["article"], remove_selectors=[".ad"]
        )

        assert "only content" in result
        assert "buy" not in result

    def test_if_present_returns_none_on_no_match(self):
        html = "<html><body><div class='mystery'>site navigation</div></body></html>"

        result = extract_main_content_if_present(html, content_selectors=["article"])

        assert result is None

    def test_if_present_returns_content_on_match(self):
        html = "<html><body><article><p>real body</p></article></body></html>"

        result = extract_main_content_if_present(html, content_selectors=["article"])

        assert result is not None
        assert "real body" in result


class TestMandatorySanitization:
    def test_template_content_is_stripped(self):
        html = "<html><body><template><p>ghost</p></template><p>real</p></body></html>"

        result = extract_main_content(html, content_selectors=["article"])

        assert "ghost" not in result
        assert "real" in result

    def test_template_nested_in_container_is_stripped(self):
        html = """
        <html><body><article><template><p>ghost</p></template><p>real</p></article></body></html>
        """

        result = extract_main_content(html, content_selectors=["article"])

        assert "ghost" not in result
        assert "real" in result

    def test_script_style_and_noscript_are_stripped(self):
        html = """
        <html><body><article>
          <script>evil()</script>
          <style>.x{}</style>
          <noscript>enable js</noscript>
          <p>real</p>
        </article></body></html>
        """

        result = extract_main_content(html, content_selectors=["article"])

        assert "evil()" not in result
        assert ".x{}" not in result
        assert "enable js" not in result
        assert "real" in result

    def test_iframes_are_left_to_the_aggregators_policy(self):
        """Iframe filtering is a per-scraper decision -- see IFRAME_SANITIZE_SELECTOR."""
        html = """
        <html><body><article>
          <iframe src="https://platform.twitter.com/embed/tweet"></iframe>
        </article></body></html>
        """

        result = extract_main_content(html, content_selectors=["article"])

        assert "platform.twitter.com" in result

    def test_iframe_sanitize_selector_drops_foreign_iframes_and_keeps_youtube(self):
        html = """
        <html><body><article>
          <iframe src="https://ads.example.com/x"></iframe>
          <iframe src="https://www.youtube.com/embed/abc"></iframe>
        </article></body></html>
        """

        result = extract_main_content(
            html, content_selectors=["article"], remove_selectors=[IFRAME_SANITIZE_SELECTOR]
        )

        assert "ads.example.com" not in result
        assert "youtube.com/embed/abc" in result

    def test_sanitization_cannot_be_disabled_by_empty_ignore_list(self):
        html = "<html><body><article><script>evil()</script><p>real</p></article></body></html>"

        result = extract_main_content(html, content_selectors=["article"], remove_selectors=[])

        assert "evil()" not in result


class TestSharedDefaults:
    def test_default_content_selectors_match_ios(self):
        assert DEFAULT_CONTENT_SELECTORS == [
            "article",
            ".article-content",
            ".entry-content",
            "main",
        ]

    def test_default_ignore_selectors_match_ios(self):
        assert DEFAULT_IGNORE_SELECTORS == [
            ".advertisement",
            ".ad",
            ".ads",
            "[class*='advert']",
            "[class*='sponsor']",
            ".social-share",
            ".newsletter",
            ".related-articles",
        ]
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_content_extractor.py -v
```

Expected: collection error or failures — `ImportError` for `extract_main_content_if_present`,
`select_content_elements`, `DEFAULT_CONTENT_SELECTORS`, `DEFAULT_IGNORE_SELECTORS`.

- [ ] **Step 3: Rewrite `core/aggregators/utils/content_extractor.py`**

Replace the whole file with:

```python
"""Content extraction utilities using BeautifulSoup."""

import logging
from typing import List, Optional, Union

from bs4 import BeautifulSoup, Tag

logger = logging.getLogger(__name__)

# Always removed before content selection. Not user-configurable: emptying
# ``ignore_selectors`` must never be able to disable sanitization.
MANDATORY_REMOVE_SELECTORS: List[str] = [
    "script",
    "style",
    "noscript",
    "template",
]

# Iframe sanitization is an aggregator-level policy, not an extractor one: some
# scrapers allow additional embed hosts (Caschy's Blog allows Twitter/X) and
# filter iframes themselves in process_content. Kept in
# FullWebsiteAggregator.selectors_to_remove, where feed options cannot disable it.
IFRAME_SANITIZE_SELECTOR = "iframe:not([src*='youtube.com']):not([src*='youtu.be'])"

# Defaults mirrored from the iOS client's shipped AggregatorOptions.swift.
DEFAULT_CONTENT_SELECTORS: List[str] = ["article", ".article-content", ".entry-content", "main"]
DEFAULT_IGNORE_SELECTORS: List[str] = [
    ".advertisement",
    ".ad",
    ".ads",
    "[class*='advert']",
    "[class*='sponsor']",
    ".social-share",
    ".newsletter",
    ".related-articles",
]

SoupOrTag = Union[BeautifulSoup, Tag]


def _remove_matching(root: SoupOrTag, selectors: List[str]) -> None:
    """Remove every element matching any selector. Invalid selectors are skipped."""
    for selector in selectors:
        try:
            matches = root.select(selector)
        except Exception as exc:
            logger.warning("Skipping invalid remove selector %r: %s", selector, exc)
            continue
        for element in matches:
            element.decompose()


def select_content_elements(
    root: SoupOrTag, content_selectors: List[str], first_match_only: bool = False
) -> List[Tag]:
    """
    Collect the content containers matching any of ``content_selectors``.

    Matches are returned in document order (not selector order), de-duplicated,
    and reduced to the outermost elements -- a match nested inside another match
    is dropped so its body is not captured twice.

    Args:
        root: Soup or tag to search within
        content_selectors: CSS selectors marking places to look for the body
        first_match_only: Keep only the first match in document order

    Returns:
        List of matching tags, possibly empty
    """
    matched_ids = set()
    for selector in content_selectors:
        try:
            matches = root.select(selector)
        except Exception as exc:
            logger.warning("Skipping invalid content selector %r: %s", selector, exc)
            continue
        for element in matches:
            if isinstance(element, Tag):
                matched_ids.add(id(element))

    if not matched_ids:
        return []

    # Walking the tree yields document order and de-duplicates for free.
    ordered = [tag for tag in root.find_all(True) if id(tag) in matched_ids]

    # Outermost wins.
    outermost = [
        tag for tag in ordered if not any(id(parent) in matched_ids for parent in tag.parents)
    ]

    if first_match_only:
        return outermost[:1]
    return outermost


def extract_main_content_if_present(
    html: str,
    content_selectors: List[str],
    remove_selectors: Optional[List[str]] = None,
    first_match_only: bool = False,
) -> Optional[str]:
    """
    Extract article content, reporting a miss instead of falling back to <body>.

    Used by scrapers with a dedicated article container, where a ``<body>``
    fallback would surface site navigation as the article.

    Returns:
        Extracted HTML, or None when no content selector matched
    """
    soup = BeautifulSoup(html, "html.parser")
    _remove_matching(soup, MANDATORY_REMOVE_SELECTORS)

    elements = select_content_elements(soup, content_selectors, first_match_only=first_match_only)
    if not elements:
        return None

    for element in elements:
        _remove_matching(element, remove_selectors or [])

    return "\n".join(str(element) for element in elements)


def extract_main_content(
    html: str,
    content_selectors: List[str],
    remove_selectors: Optional[List[str]] = None,
    first_match_only: bool = False,
) -> str:
    """
    Extract main content from HTML using a list of CSS selectors.

    Every selector is applied and the surviving containers are concatenated, so
    an article split across sibling containers is no longer truncated.

    Args:
        html: Full HTML document
        content_selectors: CSS selectors marking places to look for the body
        remove_selectors: CSS selectors for elements to remove from the result
        first_match_only: Keep only the first match in document order

    Returns:
        Extracted HTML content, falling back to <body> when nothing matched
    """
    extracted = extract_main_content_if_present(
        html,
        content_selectors=content_selectors,
        remove_selectors=remove_selectors,
        first_match_only=first_match_only,
    )
    if extracted is not None:
        return extracted

    soup = BeautifulSoup(html, "html.parser")
    _remove_matching(soup, MANDATORY_REMOVE_SELECTORS)
    body = soup.find("body")
    target: SoupOrTag = body if isinstance(body, Tag) else soup
    _remove_matching(target, remove_selectors or [])
    return str(target)
```

- [ ] **Step 4: Export the new names**

In `core/aggregators/utils/__init__.py`, replace the `content_extractor` import line and extend
`__all__`:

```python
from .content_extractor import (
    DEFAULT_CONTENT_SELECTORS,
    DEFAULT_IGNORE_SELECTORS,
    IFRAME_SANITIZE_SELECTOR,
    MANDATORY_REMOVE_SELECTORS,
    extract_main_content,
    extract_main_content_if_present,
    select_content_elements,
)
```

Add these entries to `__all__` next to the existing `"extract_main_content"`:

```python
    "DEFAULT_CONTENT_SELECTORS",
    "DEFAULT_IGNORE_SELECTORS",
    "IFRAME_SANITIZE_SELECTOR",
    "MANDATORY_REMOVE_SELECTORS",
    "extract_main_content_if_present",
    "select_content_elements",
```

- [ ] **Step 5: Update the two production call sites to the new signature**

This step is signature-compatibility only — the attribute rename is Task 2. A comma-group string
like `"#meldung, .StoryContent"` passed as a single list entry keeps working, because soupsieve
already returns all matches of the group.

`core/aggregators/website.py`, in `extract_content` (currently line 129):

```python
        return extract_main_content(
            html, content_selectors=[content_selector], remove_selectors=remove_selectors
        )
```

`core/aggregators/merkur/aggregator.py`, in `extract_content` (currently line 135):

```python
        extracted = extract_main_content(
            html,
            content_selectors=[self.content_selector],
            remove_selectors=self.selectors_to_remove,
        )
```

- [ ] **Step 6: Update the affected existing tests**

`core/tests/test_caschys_blog_aggregator.py` — both call sites (lines 96 and 129):

```python
        content = extract_main_content(
            html, content_selectors=[self.aggregator.content_selector]
        )
```

`core/tests/test_merkur_aggregator.py:31` — the kwarg assertion:

```python
        assert kwargs["content_selectors"] == [".idjs-Story"]
```

- [ ] **Step 7: Run the tests**

```bash
uv run pytest core/tests/test_content_extractor.py core/tests/test_caschys_blog_aggregator.py core/tests/test_merkur_aggregator.py -v
```

Expected: all PASS.

- [ ] **Step 8: Run the full suite and the linters**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

Expected: clean, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add core/aggregators/utils/content_extractor.py core/aggregators/utils/__init__.py core/aggregators/website.py core/aggregators/merkur/aggregator.py core/tests/test_content_extractor.py core/tests/test_caschys_blog_aggregator.py core/tests/test_merkur_aggregator.py
git commit -m "feat(aggregators): Union content selector lists and strip templates"
```

---

## Task 2: Rename `content_selector` to a `content_selectors` list

Mechanical rename across every aggregator, so no scraper silently loses its dedicated container.

**Files:**
- Modify: `core/aggregators/website.py:35` (and the `extract_content` call site from Task 1)
- Modify: `core/aggregators/heise/aggregator.py:74`
- Modify: `core/aggregators/merkur/aggregator.py:93` (and its `extract_content` call site)
- Modify: `core/aggregators/explosm/aggregator.py:48`
- Modify: `core/aggregators/dark_legacy/aggregator.py:50`
- Modify: `core/aggregators/caschys_blog/aggregator.py:49`
- Modify: `core/aggregators/mactechnews/aggregator.py:64` and `:119`
- Modify: `core/aggregators/oglaf/aggregator.py:60`
- Modify: `core/aggregators/mein_mmo/aggregator.py:56`
- Modify: `core/aggregators/mactechnews/multipage_handler.py:62-111`
- Modify: `core/management/commands/test_aggregator.py:108-111`
- Test: `core/tests/test_mactechnews_aggregator.py:148,172`
- Test: `core/tests/test_caschys_blog_aggregator.py:96,129`
- Test: `core/tests/test_merkur_aggregator.py:31` (already correct after Task 1 — verify only)

**Interfaces:**
- Consumes: `extract_main_content`, `select_content_elements`, `DEFAULT_CONTENT_SELECTORS` (Task 1).
- Produces:
  - `FullWebsiteAggregator.content_selectors: List[str]` — overridden by every scraper.
  - `fetch_all_pages(base_url: str, page_numbers: Set[int], content_selectors: List[str], fetcher: Callable[[str], str], logger: logging.Logger, first_page_html: str | None = None) -> str`

- [ ] **Step 1: Write the failing test**

Append to `core/tests/test_content_extractor.py`:

```python
class TestAggregatorSelectorAttributes:
    """Every FullWebsiteAggregator subclass exposes a selector *list*."""

    def test_all_website_aggregators_use_selector_lists(self):
        from core.aggregators.registry import AggregatorRegistry
        from core.aggregators.website import FullWebsiteAggregator

        for name, agg_class in AggregatorRegistry._registry.items():
            if not issubclass(agg_class, FullWebsiteAggregator):
                continue
            selectors = agg_class.content_selectors
            assert isinstance(selectors, list), f"{name}: content_selectors must be a list"
            assert all(isinstance(entry, str) for entry in selectors), f"{name}: entries must be str"
            assert not hasattr(agg_class, "content_selector"), (
                f"{name}: legacy singular content_selector still present"
            )
```

- [ ] **Step 2: Run it to verify it fails**

```bash
uv run pytest core/tests/test_content_extractor.py::TestAggregatorSelectorAttributes -v
```

Expected: FAIL — `AttributeError: type object 'FullWebsiteAggregator' has no attribute 'content_selectors'`.

- [ ] **Step 3: Rename the attribute in `website.py`**

Replace line 35 of `core/aggregators/website.py`:

```python
    # Places to look for the main content (override in subclasses)
    content_selectors: List[str] = list(DEFAULT_CONTENT_SELECTORS)
```

Add `DEFAULT_CONTENT_SELECTORS` to the existing `from .utils import (...)` block, and update the
Task 1 call site in `extract_content`:

```python
        content_selectors = (
            self.feed.options.get("custom_content_selector") or self.content_selectors
        )
        if isinstance(content_selectors, str):
            content_selectors = [content_selectors]
```

(The legacy option read disappears in Task 3; keep it working for now.)

- [ ] **Step 4: Rename in every scraper**

Exact replacements — the value is today's comma-group string split into list entries:

| File | Old | New |
|---|---|---|
| `heise/aggregator.py:74` | `content_selector = "#meldung, .StoryContent"` | `content_selectors = ["#meldung", ".StoryContent"]` |
| `merkur/aggregator.py:93` | `content_selector = ".idjs-Story"` | `content_selectors = [".idjs-Story"]` |
| `explosm/aggregator.py:48` | `content_selector = "#comic"` | `content_selectors = ["#comic"]` |
| `dark_legacy/aggregator.py:50` | `content_selector = "#gallery"` | `content_selectors = ["#gallery"]` |
| `caschys_blog/aggregator.py:49` | `content_selector = ".entry-inner"` | `content_selectors = [".entry-inner"]` |
| `mactechnews/aggregator.py:64` | `content_selector = ".MtnArticle"` | `content_selectors = [".MtnArticle"]` |
| `oglaf/aggregator.py:60` | `content_selector = "div.content"` | `content_selectors = ["div.content"]` |
| `mein_mmo/aggregator.py:56` | `content_selector = "div.entry-content"` | `content_selectors = ["div.entry-content"]` |

Tagesschau defines no content selector of its own — leave it alone.

In `merkur/aggregator.py`'s `extract_content`, use the list directly:

```python
        extracted = extract_main_content(
            html,
            content_selectors=self.content_selectors,
            remove_selectors=self.selectors_to_remove,
        )
```

- [ ] **Step 5: Take a selector list in the multipage handler**

`core/aggregators/mactechnews/multipage_handler.py` — change the parameter and the per-page
selection. Add `from ..utils.content_extractor import select_content_elements` to the imports, then:

```python
def fetch_all_pages(
    base_url: str,
    page_numbers: Set[int],
    content_selectors: List[str],
    fetcher: Callable[[str], str],
    logger: logging.Logger,
    first_page_html: str | None = None,
) -> str:
```

Update the docstring line to `content_selectors: CSS selectors for the content container`, and
replace the `select_one` block (currently lines 103-111):

```python
            # Extract content using the provided selectors (dedicated container: first match)
            soup = BeautifulSoup(page_html, "html.parser")
            matches = select_content_elements(soup, content_selectors, first_match_only=True)

            if matches:
                content_html = str(matches[0])
                content_parts.append(content_html)
                logger.debug(f"Page {page_num}: Content extracted ({len(content_html)} bytes)")
            else:
                logger.warning(f"Page {page_num}: No content found with {content_selectors}")
```

Add `List` to the `typing` import if it is not already there.

In `core/aggregators/mactechnews/aggregator.py:119`, pass the list:

```python
            content_selectors=self.content_selectors,
```

- [ ] **Step 6: Update the `--selector-debug` output**

`core/management/commands/test_aggregator.py`, replacing lines 108-111:

```python
            if selector_debug and hasattr(aggregator, "content_selectors"):
                self._print_field("Content selectors", ", ".join(aggregator.content_selectors))
            if selector_debug and hasattr(aggregator, "selectors_to_remove"):
                self._print_field("Selectors to remove", ", ".join(aggregator.selectors_to_remove))
```

- [ ] **Step 7: Update the affected tests**

`core/tests/test_mactechnews_aggregator.py` — both `fetch_all_pages` calls (lines 148 and 172):

```python
            content_selectors=[".MtnArticle"],
```

`core/tests/test_caschys_blog_aggregator.py` — both call sites:

```python
        content = extract_main_content(
            html, content_selectors=self.aggregator.content_selectors
        )
```

- [ ] **Step 8: Verify nothing references the old name**

```bash
grep -rn "content_selector\b" core/ CLAUDE.md
```

Expected: only `CLAUDE.md:261` (the docs example, fixed in Task 8) and no `core/` hits.

- [ ] **Step 9: Run the suite and linters**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

Expected: clean, all tests pass.

- [ ] **Step 10: Commit**

```bash
git add core/ && git commit -m "refactor(aggregators): Make content_selectors a list on every scraper"
```

---

## Task 3: Options schema — `content_selectors` / `ignore_selectors`, drop `use_full_content`

**Files:**
- Create: `core/aggregators/form_fields.py`
- Modify: `core/aggregators/base.py` (add `uses_first_content_match`, fix `save_options`)
- Modify: `core/aggregators/website.py` (config fields, accessors, `extract_content`, remove the
  `use_full_content` branch, empty the class ignore list)
- Modify: `core/aggregators/mactechnews/aggregator.py:25-27` (drop the forced option)
- Modify: `core/aggregators/merkur/aggregator.py` `extract_content` (honor the flag + options)
- Modify: the 9 scraper classes (set `uses_first_content_match = True`)
- Test: `core/tests/test_selector_options.py` (create)

**Interfaces:**
- Consumes: Task 1's `extract_main_content`, `DEFAULT_IGNORE_SELECTORS`; Task 2's `content_selectors`.
- Produces:
  - `SelectorListField(forms.CharField)` — `clean()` returns `list[str] | None`, `prepare_value()` joins lists.
  - `BaseAggregator.uses_first_content_match: bool = False`
  - `FullWebsiteAggregator.get_content_selectors() -> List[str]`
  - `FullWebsiteAggregator.get_ignore_selectors() -> List[str]`
  - Option keys `content_selectors: list[str]`, `ignore_selectors: list[str]`. `use_full_content`,
    `custom_content_selector`, `custom_selectors_to_remove` no longer exist.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_selector_options.py`:

```python
"""Tests for selector option resolution and the removal of use_full_content."""

import pytest

from core.aggregators.form_fields import SelectorListField
from core.aggregators.utils.content_extractor import (
    DEFAULT_CONTENT_SELECTORS,
    DEFAULT_IGNORE_SELECTORS,
)
from core.aggregators.website import FullWebsiteAggregator


@pytest.mark.django_db
class TestSelectorOptionResolution:
    def test_defaults_apply_when_key_absent(self, rss_feed):
        rss_feed.options = {}
        agg = FullWebsiteAggregator(rss_feed)

        assert agg.get_content_selectors() == DEFAULT_CONTENT_SELECTORS

    def test_option_overrides_class_default(self, rss_feed):
        rss_feed.options = {"content_selectors": ["div.body", ".extra"]}
        agg = FullWebsiteAggregator(rss_feed)

        assert agg.get_content_selectors() == ["div.body", ".extra"]

    def test_explicit_empty_list_is_preserved_not_defaulted(self, rss_feed):
        rss_feed.options = {"content_selectors": []}
        agg = FullWebsiteAggregator(rss_feed)

        assert agg.get_content_selectors() == []

    def test_option_entries_are_stripped_and_emptied_entries_dropped(self, rss_feed):
        rss_feed.options = {"content_selectors": [" article ", "", "  "]}
        agg = FullWebsiteAggregator(rss_feed)

        assert agg.get_content_selectors() == ["article"]

    def test_ignore_defaults_apply_when_key_absent(self, rss_feed):
        rss_feed.options = {}
        agg = FullWebsiteAggregator(rss_feed)

        assert agg.get_ignore_selectors() == DEFAULT_IGNORE_SELECTORS

    def test_ignore_option_replaces_defaults_and_keeps_class_selectors(self, rss_feed):
        rss_feed.options = {"ignore_selectors": [".sidebar"]}
        agg = FullWebsiteAggregator(rss_feed)
        agg.selectors_to_remove = [".site-chrome"]

        assert agg.get_ignore_selectors() == [".site-chrome", ".sidebar"]


@pytest.mark.django_db
class TestUseFullContentRemoved:
    def test_option_field_is_gone(self):
        assert "use_full_content" not in FullWebsiteAggregator.get_configuration_fields()

    def test_new_selector_fields_are_offered(self):
        fields = FullWebsiteAggregator.get_configuration_fields()

        assert set(fields) == {"content_selectors", "ignore_selectors"}

    def test_full_content_is_fetched_even_when_the_stale_option_is_false(self, rss_feed, monkeypatch):
        rss_feed.options = {"use_full_content": False}
        agg = FullWebsiteAggregator(rss_feed)
        monkeypatch.setattr(
            agg, "fetch_article_content", lambda url: "<article><p>fetched</p></article>"
        )
        monkeypatch.setattr(agg, "extract_header_element", lambda article: None)

        enriched = agg.enrich_articles(
            [{"name": "T", "identifier": "https://example.com/a", "content": "rss summary"}]
        )

        assert "fetched" in enriched[0]["content"]


@pytest.mark.django_db
class TestFirstMatchOptOut:
    def test_generic_full_website_unions_matches(self, rss_feed):
        agg = FullWebsiteAggregator(rss_feed)
        html = "<body><article><p>one</p></article><article><p>two</p></article></body>"

        result = agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "one" in result
        assert "two" in result

    def test_scrapers_with_a_dedicated_container_opt_out(self):
        from core.aggregators.caschys_blog.aggregator import CaschysBlogAggregator
        from core.aggregators.heise import HeiseAggregator
        from core.aggregators.merkur import MerkurAggregator

        assert FullWebsiteAggregator.uses_first_content_match is False
        for agg_class in (HeiseAggregator, MerkurAggregator, CaschysBlogAggregator):
            assert agg_class.uses_first_content_match is True

    def test_first_match_flag_is_honored_by_extract_content(self, rss_feed):
        agg = FullWebsiteAggregator(rss_feed)
        agg.uses_first_content_match = True
        html = "<body><article><p>one</p></article><article><p>two</p></article></body>"

        result = agg.extract_content(html, {"name": "T", "identifier": "u"})

        assert "one" in result
        assert "two" not in result


class TestSelectorListField:
    def test_blank_cleans_to_none_so_defaults_survive(self):
        assert SelectorListField(required=False).clean("") is None

    def test_comma_string_cleans_to_list(self):
        assert SelectorListField(required=False).clean("article, .body") == ["article", ".body"]

    def test_stray_whitespace_and_empty_segments_are_dropped(self):
        assert SelectorListField(required=False).clean(" article , , .body ,") == [
            "article",
            ".body",
        ]

    def test_prepare_value_renders_a_stored_list(self):
        assert SelectorListField(required=False).prepare_value(["article", ".body"]) == (
            "article, .body"
        )


@pytest.mark.django_db
class TestSaveOptionsDropsNone:
    def test_blank_selector_field_removes_the_key(self, rss_feed):
        rss_feed.options = {"content_selectors": ["article"]}
        agg = FullWebsiteAggregator(rss_feed)

        agg.save_options({"content_selectors": None, "ignore_selectors": None})

        assert "content_selectors" not in agg.feed.options
        assert "ignore_selectors" not in agg.feed.options
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_selector_options.py -v
```

Expected: FAIL — `ModuleNotFoundError: core.aggregators.form_fields`.

- [ ] **Step 3: Create `core/aggregators/form_fields.py`**

```python
"""Form fields for aggregator configuration."""

from typing import Any, List, Optional

from django import forms


class SelectorListField(forms.CharField):
    """
    Comma-separated CSS selector input, stored in ``Feed.options`` as a list.

    Blank input cleans to ``None`` so ``BaseAggregator.save_options`` drops the
    key entirely. An absent key means "use the code defaults", which is not the
    same as an explicitly empty list.
    """

    def prepare_value(self, value: Any) -> Any:
        if isinstance(value, (list, tuple)):
            return ", ".join(str(item) for item in value)
        return value

    def clean(self, value: Any) -> Optional[List[str]]:
        raw = super().clean(value)
        if isinstance(raw, (list, tuple)):
            parts = [str(item) for item in raw]
        else:
            parts = str(raw or "").split(",")
        cleaned = [part.strip() for part in parts if part.strip()]
        return cleaned or None
```

- [ ] **Step 4: Add the flag and fix `save_options` in `base.py`**

Under `supports_identifier_search` (around line 32):

```python
    # Scrapers whose body lives in one known container set this True: extraction
    # then keeps only the first match instead of unioning every match.
    uses_first_content_match = False
```

Replace the loop body of `save_options` (currently lines 499-501):

```python
        for field_name in config_fields:
            if field_name not in form_cleaned_data:
                continue
            value = form_cleaned_data[field_name]
            if value is None:
                # Blank input means "use the default" -- drop the key entirely.
                options.pop(field_name, None)
            else:
                options[field_name] = value
```

- [ ] **Step 5: Rework `website.py`**

Replace `get_configuration_fields` (lines 37-61) with:

```python
    @classmethod
    def get_configuration_fields(cls) -> Dict[str, Any]:
        """Get configuration fields for FullWebsiteAggregator."""
        from .form_fields import SelectorListField

        return {
            "content_selectors": SelectorListField(
                label="Content Selectors",
                help_text=(
                    "Comma-separated CSS selectors for the article body. Every match is "
                    "combined, so a body split across containers stays complete. Leave blank "
                    "for the defaults: " + ", ".join(DEFAULT_CONTENT_SELECTORS)
                ),
                required=False,
            ),
            "ignore_selectors": SelectorListField(
                label="Ignore Selectors",
                help_text=(
                    "Comma-separated CSS selectors to remove from the content. Leave blank "
                    "for the defaults: " + ", ".join(DEFAULT_IGNORE_SELECTORS)
                ),
                required=False,
            ),
        }
```

Reduce the class ignore list (line 24) to the iframe policy — `script`/`style`/`noscript`/`template`
are now mandatory in the extractor, and the ad selectors come from `DEFAULT_IGNORE_SELECTORS`:

```python
    # Scraper-specific removals, always applied on top of the feed's
    # ignore_selectors (so a feed option cannot disable them). script/style/
    # noscript/template are handled by the extractor and are not listed here;
    # the iframe rule stays here because scrapers such as Caschy's Blog widen it.
    selectors_to_remove: List[str] = [IFRAME_SANITIZE_SELECTOR]
```

Import `IFRAME_SANITIZE_SELECTOR` from `.utils` alongside the other constants.

Note for the reviewer: Tagesschau's `selectors_to_remove = FullWebsiteAggregator.selectors_to_remove + [...]`
therefore keeps the iframe rule, and Caschy's Blog keeps overriding the list without it — which is
what preserves its Twitter/X allow-list.

Delete the `use_full_content` branch from `enrich_articles` (lines 67-72) so it starts straight at
`for article in articles:`.

Replace `extract_content` (lines 117-131) with the accessors:

```python
    def get_content_selectors(self) -> List[str]:
        """Resolve the content selectors: feed option if set, else the class default."""
        options = self.feed.options or {}
        if "content_selectors" in options:
            return self._clean_selector_list(options["content_selectors"])
        return list(self.content_selectors)

    def get_ignore_selectors(self) -> List[str]:
        """Resolve removals: the class list plus the feed option (or the shared defaults)."""
        options = self.feed.options or {}
        if "ignore_selectors" in options:
            configured = self._clean_selector_list(options["ignore_selectors"])
        else:
            configured = list(DEFAULT_IGNORE_SELECTORS)
        return list(self.selectors_to_remove) + configured

    @staticmethod
    def _clean_selector_list(value: Any) -> List[str]:
        """Normalize a stored option value into a list of non-empty selectors."""
        if isinstance(value, str):
            parts = value.split(",")
        elif isinstance(value, (list, tuple)):
            parts = [str(item) for item in value]
        else:
            return []
        return [part.strip() for part in parts if part.strip()]

    def extract_content(self, html: str, article: Dict[str, Any]) -> str:
        """Extract main content from HTML."""
        return extract_main_content(
            html,
            content_selectors=self.get_content_selectors(),
            remove_selectors=self.get_ignore_selectors(),
            first_match_only=self.uses_first_content_match,
        )
```

Make sure the `from .utils import (...)` block imports `DEFAULT_CONTENT_SELECTORS`,
`DEFAULT_IGNORE_SELECTORS` and `extract_main_content`.

- [ ] **Step 6: Drop the forced option in mactechnews**

Delete lines 25-27 of `core/aggregators/mactechnews/aggregator.py` (the comment and
`self.feed.options["use_full_content"] = True`), leaving the identifier default in `__init__`.

- [ ] **Step 7: Opt the dedicated-container scrapers out of the union**

Add this line to each of the 9 scraper classes, right above their `content_selectors` (for
Tagesschau, above `selectors_to_remove`):

```python
    # Body lives in one known container -- keep the first match, never union.
    uses_first_content_match = True
```

Classes: `HeiseAggregator`, `MerkurAggregator`, `TagesschauAggregator`, `ExplosmAggregator`,
`DarkLegacyAggregator`, `CaschysBlogAggregator`, `MactechnewsAggregator`, `OglafAggregator`,
`MeinMmoAggregator`. `FullWebsiteAggregator` keeps the inherited `False`.

In `core/aggregators/merkur/aggregator.py`'s `extract_content`, honor the flag and the feed options:

```python
        extracted = extract_main_content(
            html,
            content_selectors=self.get_content_selectors(),
            remove_selectors=self.get_ignore_selectors(),
            first_match_only=self.uses_first_content_match,
        )
```

- [ ] **Step 8: Verify the legacy keys are gone from the code**

```bash
grep -rn "use_full_content\|custom_content_selector\|custom_selectors_to_remove" core/
```

Expected: no matches.

- [ ] **Step 9: Run the tests and linters**

```bash
uv run pytest core/tests/test_selector_options.py -v && uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

Expected: all PASS. If a per-scraper test fails because a scraper's `selectors_to_remove` relied on
`FullWebsiteAggregator.selectors_to_remove` carrying `script`/`style`/`.ad`, confirm the extractor's
mandatory list or `DEFAULT_IGNORE_SELECTORS` covers it and fix the test expectation, not the lists.

- [ ] **Step 10: Commit**

```bash
git add core/ && git commit -m "feat(aggregators): Replace legacy selector options with selector lists"
```

---

## Task 4: Generic fallback with the 80-character floor

**Files:**
- Modify: `core/aggregators/website.py`
- Test: `core/tests/test_selector_options.py` (append)

**Interfaces:**
- Consumes: Task 1's `extract_main_content_if_present`, `DEFAULT_CONTENT_SELECTORS`; Task 3's
  `get_ignore_selectors`.
- Produces:
  - `GENERIC_CONTENT_MIN_TEXT_LENGTH = 80` (module constant in `core/aggregators/website.py`)
  - `FullWebsiteAggregator.generic_content_if_present(raw_html: str, article: Dict[str, Any]) -> Optional[str]`

Spec 2's scrapers consume this as the middle step of
`dedicated container → generic extraction (≥80 chars) → RSS summary`.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/test_selector_options.py`:

```python
@pytest.mark.django_db
class TestGenericContentFallback:
    def test_returns_extracted_content_above_the_floor(self, rss_feed):
        agg = FullWebsiteAggregator(rss_feed)
        body = "This is a real article body with clearly more than eighty characters of prose in it."
        html = f"<html><body><main><p>{body}</p></main></body></html>"

        result = agg.generic_content_if_present(html, {"identifier": "https://example.com/a"})

        assert result is not None
        assert body in result

    def test_returns_none_below_the_floor(self, rss_feed):
        agg = FullWebsiteAggregator(rss_feed)
        html = "<html><body><main><p>By Jane Doe</p></main></body></html>"

        result = agg.generic_content_if_present(html, {"identifier": "https://example.com/a"})

        assert result is None

    def test_returns_none_when_no_generic_container_matches(self, rss_feed):
        agg = FullWebsiteAggregator(rss_feed)
        html = "<html><body><div class='mystery'>site navigation</div></body></html>"

        result = agg.generic_content_if_present(html, {"identifier": "https://example.com/a"})

        assert result is None

    def test_uses_generic_defaults_not_the_scrapers_dedicated_container(self, rss_feed):
        """The point of the hook: syndicated pages carry none of the scraper's markup."""
        agg = FullWebsiteAggregator(rss_feed)
        agg.content_selectors = [".tagesschau-only"]
        body = "Foreign broadcaster template with a long enough body to clear the eighty char floor."
        html = f"<html><body><article><p>{body}</p></article></body></html>"

        result = agg.generic_content_if_present(html, {"identifier": "https://mdr.de/a"})

        assert result is not None
        assert body in result

    def test_floor_is_exactly_eighty_characters(self):
        from core.aggregators.website import GENERIC_CONTENT_MIN_TEXT_LENGTH

        assert GENERIC_CONTENT_MIN_TEXT_LENGTH == 80
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_selector_options.py::TestGenericContentFallback -v
```

Expected: FAIL — `AttributeError: 'FullWebsiteAggregator' object has no attribute 'generic_content_if_present'`.

- [ ] **Step 3: Implement it**

In `core/aggregators/website.py`, add the module constant below the imports:

```python
# iOS's shipped floor: a container holding only a byline or breadcrumb must not
# beat the RSS summary fallback. Keep this value identical to the client's.
GENERIC_CONTENT_MIN_TEXT_LENGTH = 80
```

Add the method next to `extract_content`:

```python
    def generic_content_if_present(
        self, raw_html: str, article: Dict[str, Any]
    ) -> Optional[str]:
        """
        Try generic extraction on already-fetched HTML.

        Used by scrapers whose dedicated container is missing -- syndicated
        pages on other domains carry none of the scraper's markup. Requires at
        least GENERIC_CONTENT_MIN_TEXT_LENGTH characters of real text so a
        byline-only container does not beat the RSS summary fallback.

        Returns:
            Extracted HTML, or None when nothing usable was found
        """
        extracted = extract_main_content_if_present(
            raw_html,
            content_selectors=list(DEFAULT_CONTENT_SELECTORS),
            remove_selectors=self.get_ignore_selectors(),
        )
        if not extracted:
            return None

        text = BeautifulSoup(extracted, "html.parser").get_text(" ", strip=True)
        if len(text) < GENERIC_CONTENT_MIN_TEXT_LENGTH:
            self.logger.info(
                "[generic_content_if_present] Only %d chars of text for %s -- rejecting",
                len(text),
                article.get("identifier"),
            )
            return None

        return extracted
```

Add `extract_main_content_if_present` to the `from .utils import (...)` block and `Optional` to the
`typing` import.

- [ ] **Step 4: Run the tests**

```bash
uv run pytest core/tests/test_selector_options.py -v
```

Expected: all PASS.

- [ ] **Step 5: Run the linters and full suite**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

- [ ] **Step 6: Commit**

```bash
git add core/aggregators/website.py core/tests/test_selector_options.py
git commit -m "feat(aggregators): Add generic content fallback with an 80-char text floor"
```

---

## Task 5: Data migration for the options schema

**Files:**
- Create: `core/aggregators/utils/legacy_options.py`
- Create: `core/migrations/0027_migrate_selector_options.py`
- Modify: `core/aggregators/utils/__init__.py` (export the helpers)
- Test: `core/tests/test_legacy_options_migration.py` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks (pure dict transforms).
- Produces:
  - `convert_legacy_options(options: dict) -> tuple[dict, bool]` — returns the new options dict and
    whether the feed must become `feed_content`.
  - `revert_options(options: dict) -> dict` — approximate reverse.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_legacy_options_migration.py`:

```python
"""Tests for the legacy selector-option conversion and its migration."""

import importlib

import pytest
from django.apps import apps as global_apps

from core.aggregators.utils.legacy_options import convert_legacy_options, revert_options


class TestConvertLegacyOptions:
    def test_comma_string_becomes_a_list(self):
        options, to_feed_content = convert_legacy_options(
            {"custom_content_selector": "article, .body"}
        )

        assert options == {"content_selectors": ["article", ".body"]}
        assert to_feed_content is False

    def test_stray_whitespace_and_empty_segments_are_cleaned(self):
        options, _ = convert_legacy_options(
            {"custom_selectors_to_remove": " .ads , , .sidebar ,"}
        )

        assert options == {"ignore_selectors": [".ads", ".sidebar"]}

    def test_empty_legacy_value_is_dropped_so_defaults_apply(self):
        options, _ = convert_legacy_options(
            {"custom_content_selector": "", "custom_selectors_to_remove": "  "}
        )

        assert options == {}

    def test_existing_new_key_wins_over_legacy(self):
        options, _ = convert_legacy_options(
            {"content_selectors": [], "custom_content_selector": "article"}
        )

        assert options == {"content_selectors": []}

    def test_use_full_content_false_requests_conversion(self):
        options, to_feed_content = convert_legacy_options({"use_full_content": False})

        assert options == {}
        assert to_feed_content is True

    def test_use_full_content_true_only_drops_the_key(self):
        options, to_feed_content = convert_legacy_options(
            {"use_full_content": True, "skip_ads": True}
        )

        assert options == {"skip_ads": True}
        assert to_feed_content is False

    def test_unrelated_options_are_untouched(self):
        options, _ = convert_legacy_options({"ai_summarize": True, "max_comments": 5})

        assert options == {"ai_summarize": True, "max_comments": 5}

    def test_non_dict_options_yield_an_empty_dict(self):
        options, to_feed_content = convert_legacy_options(["not", "a", "dict"])

        assert options == {}
        assert to_feed_content is False


class TestRevertOptions:
    def test_lists_become_comma_strings(self):
        reverted = revert_options(
            {"content_selectors": ["article", ".body"], "ignore_selectors": [".ads"]}
        )

        assert reverted == {
            "custom_content_selector": "article, .body",
            "custom_selectors_to_remove": ".ads",
        }

    def test_absent_keys_stay_absent(self):
        assert revert_options({"skip_ads": True}) == {"skip_ads": True}


@pytest.mark.django_db
class TestMigrationOverRealRows:
    @staticmethod
    def _run_forwards():
        module = importlib.import_module("core.migrations.0027_migrate_selector_options")
        module.forwards(global_apps, None)

    def test_full_website_feed_keeps_its_type_and_gains_lists(self, user):
        from core.models import Feed

        feed = Feed.objects.create(
            name="Legacy",
            aggregator="full_website",
            identifier="https://example.com/rss",
            user=user,
            options={
                "use_full_content": True,
                "custom_content_selector": "article, .body",
                "custom_selectors_to_remove": ".ads",
            },
        )

        self._run_forwards()

        feed.refresh_from_db()
        assert feed.aggregator == "full_website"
        assert feed.options == {
            "content_selectors": ["article", ".body"],
            "ignore_selectors": [".ads"],
        }

    def test_summary_only_feed_becomes_feed_content(self, user):
        from core.models import Feed

        feed = Feed.objects.create(
            name="Summary only",
            aggregator="full_website",
            identifier="https://example.com/rss",
            user=user,
            options={"use_full_content": False},
        )

        self._run_forwards()

        feed.refresh_from_db()
        assert feed.aggregator == "feed_content"
        assert feed.options == {}

    def test_malformed_options_row_does_not_block_the_migration(self, user):
        from core.models import Feed

        broken = Feed.objects.create(
            name="Broken",
            aggregator="full_website",
            identifier="https://example.com/broken",
            user=user,
            options=["not", "a", "dict"],
        )
        good = Feed.objects.create(
            name="Good",
            aggregator="full_website",
            identifier="https://example.com/good",
            user=user,
            options={"custom_content_selector": "article"},
        )

        self._run_forwards()

        broken.refresh_from_db()
        good.refresh_from_db()
        assert broken.options == ["not", "a", "dict"]
        assert good.options == {"content_selectors": ["article"]}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_legacy_options_migration.py -v
```

Expected: FAIL — `ModuleNotFoundError: core.aggregators.utils.legacy_options`.

- [ ] **Step 3: Create `core/aggregators/utils/legacy_options.py`**

```python
"""Conversion helpers for the pre-Spec-1 selector options.

Kept as pure functions so migration 0027 stays thin and the behavior is
directly testable.
"""

from typing import Any, Dict, List, Tuple

LEGACY_CONTENT_KEY = "custom_content_selector"
LEGACY_IGNORE_KEY = "custom_selectors_to_remove"
LEGACY_FULL_CONTENT_KEY = "use_full_content"


def clean_selector_list(value: Any) -> List[str]:
    """Split a comma string (or normalize a list) into non-empty selectors."""
    if isinstance(value, str):
        parts = value.split(",")
    elif isinstance(value, (list, tuple)):
        parts = [str(item) for item in value]
    else:
        return []
    return [part.strip() for part in parts if part.strip()]


def convert_legacy_options(options: Any) -> Tuple[Dict[str, Any], bool]:
    """
    Convert one feed's options to the Spec 1 schema.

    An existing new-style key always wins -- it may legitimately hold an empty
    list, which means "the user cleared this" and is not the same as absent.

    Args:
        options: The feed's raw options value (may be malformed)

    Returns:
        (new_options, convert_to_feed_content)
    """
    if not isinstance(options, dict):
        return {}, False

    converted = dict(options)

    legacy_content = converted.pop(LEGACY_CONTENT_KEY, None)
    if "content_selectors" not in converted:
        selectors = clean_selector_list(legacy_content)
        if selectors:
            converted["content_selectors"] = selectors

    legacy_ignore = converted.pop(LEGACY_IGNORE_KEY, None)
    if "ignore_selectors" not in converted:
        selectors = clean_selector_list(legacy_ignore)
        if selectors:
            converted["ignore_selectors"] = selectors

    to_feed_content = False
    if LEGACY_FULL_CONTENT_KEY in converted:
        to_feed_content = converted.pop(LEGACY_FULL_CONTENT_KEY) is False

    return converted, to_feed_content


def revert_options(options: Any) -> Dict[str, Any]:
    """
    Approximate reverse: selector lists become comma strings again.

    Which ``feed_content`` feeds were originally ``full_website`` is not
    recoverable, so the aggregator type is left alone.
    """
    if not isinstance(options, dict):
        return {}

    reverted = dict(options)

    if "content_selectors" in reverted:
        reverted[LEGACY_CONTENT_KEY] = ", ".join(clean_selector_list(reverted.pop("content_selectors")))
    if "ignore_selectors" in reverted:
        reverted[LEGACY_IGNORE_KEY] = ", ".join(clean_selector_list(reverted.pop("ignore_selectors")))

    return reverted
```

Export both functions from `core/aggregators/utils/__init__.py` (import line plus `__all__`
entries: `"convert_legacy_options"`, `"revert_options"`).

- [ ] **Step 4: Create `core/migrations/0027_migrate_selector_options.py`**

```python
"""Convert legacy selector options and retire use_full_content.

Feeds carrying ``use_full_content: false`` relied on summary-only behavior, so
they become ``feed_content`` feeds rather than silently starting to scrape every
article.

The reverse operation is approximate by design: it restores the comma-string
selector keys, but cannot tell which ``feed_content`` feeds were originally
``full_website``, and does not restore ``use_full_content``. Removing the toggle
is a one-way product decision.
"""

import logging

from django.db import migrations

from core.aggregators.utils.legacy_options import convert_legacy_options, revert_options

logger = logging.getLogger(__name__)


def forwards(apps, schema_editor):
    Feed = apps.get_model("core", "Feed")

    for feed in Feed.objects.all():
        if not isinstance(feed.options, dict):
            logger.warning(
                "Feed %s: options is %s, not a dict -- skipping conversion",
                feed.pk,
                type(feed.options).__name__,
            )
            continue

        try:
            new_options, to_feed_content = convert_legacy_options(feed.options)
        except Exception as exc:
            logger.warning("Feed %s: could not convert options (%s) -- skipping", feed.pk, exc)
            continue

        update_fields = []

        if new_options != feed.options:
            feed.options = new_options
            update_fields.append("options")

        if to_feed_content and feed.aggregator == "full_website":
            logger.info(
                "Feed %s: use_full_content was false -- converting to feed_content", feed.pk
            )
            feed.aggregator = "feed_content"
            update_fields.append("aggregator")

        if update_fields:
            feed.save(update_fields=update_fields)


def backwards(apps, schema_editor):
    Feed = apps.get_model("core", "Feed")

    for feed in Feed.objects.all():
        if not isinstance(feed.options, dict):
            continue

        reverted = revert_options(feed.options)
        if reverted != feed.options:
            feed.options = reverted
            feed.save(update_fields=["options"])


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0026_delete_greaderauthtoken"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
```

- [ ] **Step 5: Run the tests**

```bash
uv run pytest core/tests/test_legacy_options_migration.py -v
```

Expected: all PASS.

- [ ] **Step 6: Check the migration applies and reverses**

```bash
uv run python manage.py migrate core 0027 && uv run python manage.py migrate core 0026 && uv run python manage.py migrate
```

Expected: all three succeed with no traceback.

- [ ] **Step 7: Run the linters and full suite**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

- [ ] **Step 8: Commit**

```bash
git add core/aggregators/utils/legacy_options.py core/aggregators/utils/__init__.py core/migrations/0027_migrate_selector_options.py core/tests/test_legacy_options_migration.py
git commit -m "feat(migrations): Convert legacy selector options and retire use_full_content"
```

---

## Task 6: Stop overwriting article publish dates

**Files:**
- Modify: `core/aggregators/base.py` `filter_articles` (lines 220-256) and the `random` import
- Modify: `core/aggregators/rss.py` `_parse_date`
- Modify: `core/services/aggregator_service.py:106`
- Test: `core/tests/test_article_dates.py` (create)
- Test: `core/aggregators/tests_base_filtering.py` (update the date assertion)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `filter_articles` keeps `article["date"]`'s instant intact (only naive → aware
  normalization); `AggregatorService` persists `article_data["date"]`.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_article_dates.py`:

```python
"""Article date semantics: real publish times, never import times."""

from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from django.utils import timezone

from core.aggregators.rss import RssAggregator
from core.models import Article


@pytest.fixture
def agg(rss_feed):
    aggregator = RssAggregator(rss_feed)
    aggregator.logger = MagicMock()
    return aggregator


@pytest.mark.django_db
class TestFilterArticlesPreservesDates:
    def test_recent_article_keeps_its_exact_date(self, agg):
        published = timezone.now() - timedelta(days=3)

        filtered = agg.filter_articles([{"name": "Recent", "date": published}])

        assert len(filtered) == 1
        assert filtered[0]["date"] == published

    def test_old_article_is_filtered_out(self, agg):
        filtered = agg.filter_articles(
            [{"name": "Ancient", "date": timezone.now() - timedelta(days=90)}]
        )

        assert filtered == []

    def test_filter_articles_never_mutates_the_date(self, agg):
        """Regression guard: this is the behavior most likely to be reintroduced."""
        published = timezone.now() - timedelta(days=10)
        articles = [{"name": "A", "date": published}, {"name": "B", "date": published}]

        agg.filter_articles(articles)

        assert [article["date"] for article in articles] == [published, published]

    def test_naive_dates_are_made_aware_without_shifting_the_instant(self, agg):
        naive = datetime(2026, 7, 20, 12, 30, 0)

        filtered = agg.filter_articles([{"name": "Naive", "date": naive}])

        assert timezone.is_aware(filtered[0]["date"])
        assert filtered[0]["date"] == timezone.make_aware(naive)

    def test_missing_date_is_left_alone(self, agg):
        filtered = agg.filter_articles([{"name": "No date", "date": None}])

        assert len(filtered) == 1
        assert filtered[0]["date"] is None


class TestRssDateParsing:
    def test_rfc822_date_with_offset_is_preserved(self, agg):
        parsed = agg._parse_date("Mon, 20 Jul 2026 12:30:00 +0200")

        assert timezone.is_aware(parsed)
        assert parsed.hour == 12
        assert parsed.utcoffset() == timedelta(hours=2)

    def test_date_without_timezone_becomes_aware(self, agg):
        parsed = agg._parse_date("Mon, 20 Jul 2026 12:30:00")

        assert timezone.is_aware(parsed)

    def test_missing_and_unparseable_dates_fall_back_to_aware_now(self, agg):
        for value in (None, "not a date"):
            parsed = agg._parse_date(value)
            assert timezone.is_aware(parsed)


@pytest.mark.django_db
class TestPersistedDates:
    def test_service_saves_the_real_publish_date(self, rss_feed):
        from core.services.aggregator_service import AggregatorService

        published = timezone.now() - timedelta(days=5)
        with patch("core.services.aggregator_service.get_aggregator") as get_agg:
            get_agg.return_value.aggregate.return_value = [
                {
                    "name": "Real date",
                    "identifier": "https://example.com/a",
                    "raw_content": "raw",
                    "content": "content",
                    "date": published,
                    "author": "",
                }
            ]

            AggregatorService.trigger_by_feed_id(rss_feed.id)

        article = Article.objects.get(identifier="https://example.com/a")
        assert article.date == published

    def test_missing_date_falls_back_to_now(self, rss_feed):
        from core.services.aggregator_service import AggregatorService

        with patch("core.services.aggregator_service.get_aggregator") as get_agg:
            get_agg.return_value.aggregate.return_value = [
                {
                    "name": "No date",
                    "identifier": "https://example.com/b",
                    "raw_content": "raw",
                    "content": "content",
                    "date": None,
                    "author": "",
                }
            ]

            AggregatorService.trigger_by_feed_id(rss_feed.id)

        article = Article.objects.get(identifier="https://example.com/b")
        assert article.date is not None

    def test_two_articles_published_in_the_same_second_both_persist(self, rss_feed):
        published = timezone.now() - timedelta(days=1)
        Article.objects.create(
            feed=rss_feed, name="One", identifier="u1", raw_content="", content="", date=published
        )
        Article.objects.create(
            feed=rss_feed, name="Two", identifier="u2", raw_content="", content="", date=published
        )

        ordered = list(
            Article.objects.filter(feed=rss_feed).order_by("-created_at", "-id").values_list(
                "name", flat=True
            )
        )

        assert ordered == ["Two", "One"]
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_article_dates.py -v
```

Expected: FAIL — dates come back as "now" instead of the publish time.

- [ ] **Step 3: Rewrite `filter_articles` in `core/aggregators/base.py`**

Replace the loop body (lines 237-254) and the docstring:

```python
    def filter_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Filter articles based on criteria.

        Default implementation drops articles older than 60 days. The article
        date is the real publish time and is never rewritten -- naive datetimes
        are only made timezone-aware, which preserves the instant. Anything that
        needs append-only ordering must use Article.created_at.

        Args:
            articles: List of article dictionaries

        Returns:
            Filtered list of articles
        """
        self.logger.debug("[filter_articles] Starting age check filter")
        cutoff_date = timezone.now() - timedelta(days=60)
        filtered = []

        for article in articles:
            article_date = article.get("date")

            # Normalize the representation only -- same instant, now comparable.
            if article_date and timezone.is_naive(article_date):
                article_date = timezone.make_aware(article_date)
                article["date"] = article_date

            if article_date and article_date < cutoff_date:
                self.logger.info(
                    f"[filter_articles] Skipping old article: {article.get('name')} ({article_date})"
                )
                continue

            filtered.append(article)
        self.logger.info(f"[filter_articles] Kept {len(filtered)}/{len(articles)} articles")
        return filtered
```

Then delete the now-unused `import random` (line 7) — confirm with `grep -n "random" core/aggregators/base.py`.

- [ ] **Step 4: Make `_parse_date` timezone-aware in `core/aggregators/rss.py`**

Add `from django.utils import timezone` to the imports and replace `_parse_date`:

```python
    def _parse_date(self, date_str: Optional[str]) -> datetime:
        """Parse an RSS date string into an aware datetime."""
        if not date_str:
            return timezone.now()
        try:
            parsed = parsedate_to_datetime(date_str)
        except Exception:
            return timezone.now()
        if timezone.is_naive(parsed):
            return timezone.make_aware(parsed)
        return parsed
```

- [ ] **Step 5: Persist the real date in `core/services/aggregator_service.py`**

Replace line 106:

```python
                            date=article_data.get("date") or timezone.now(),
```

- [ ] **Step 6: Update `core/aggregators/tests_base_filtering.py`**

Replace the trailing "dates are updated to roughly now" block with an unchanged-date assertion:

```python
        # Dates are the real publish times and must not be rewritten
        by_name = {article["name"]: article["date"] for article in filtered}
        self.assertEqual(by_name["New Article"], articles[0]["date"])
        self.assertEqual(by_name["Borderline Article (Keep)"], articles[2]["date"])
```

- [ ] **Step 7: Run the tests**

```bash
uv run pytest core/tests/test_article_dates.py core/aggregators/tests_base_filtering.py -v
```

Expected: all PASS.

- [ ] **Step 8: Run the linters and full suite**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

Expected: clean. If a scraper test asserted an import-time date, update the expectation — the new
behavior is intended.

- [ ] **Step 9: Commit**

```bash
git add core/aggregators/base.py core/aggregators/rss.py core/services/aggregator_service.py core/aggregators/tests_base_filtering.py core/tests/test_article_dates.py
git commit -m "fix(aggregators): Keep real article publish dates instead of import time"
```

---

## Task 7: `created_at` indexes for stable ordering

**Files:**
- Modify: `core/models.py:145-152` (`Article.Meta.indexes`)
- Create: `core/migrations/0028_article_created_at_indexes.py` (generated)
- Test: `core/tests/test_performance_indexes.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `Article` indexes on `("-created_at", "-id")` and `("feed", "-created_at")` — the
  groundwork for the future sync cursor.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/test_performance_indexes.py`, inside `TestPerformanceIndexes`:

```python
    def test_article_created_at_cursor_index_exists(self):
        """The sync cursor orders by created_at, tie-broken by id."""
        index_fields = [index.fields for index in Article._meta.indexes]
        assert ["-created_at", "-id"] in index_fields, (
            f"Cursor index ['-created_at', '-id'] not found in {index_fields}"
        )

    def test_article_feed_created_at_index_exists(self):
        index_fields = [index.fields for index in Article._meta.indexes]
        assert ["feed", "-created_at"] in index_fields, (
            f"Index ['feed', '-created_at'] not found in {index_fields}"
        )

    def test_existing_date_indexes_are_kept(self):
        """date is still filtered and sorted on for display."""
        index_fields = [set(index.fields) for index in Article._meta.indexes]
        assert {"date"} in index_fields
        assert {"feed", "date"} in index_fields

    def test_default_ordering_stays_display_oriented(self):
        assert Article._meta.ordering == ["-date"]
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest core/tests/test_performance_indexes.py -v
```

Expected: FAIL on both new index assertions.

- [ ] **Step 3: Add the indexes**

In `core/models.py`, extend `Article.Meta.indexes` — keep every existing entry:

```python
        indexes = [
            models.Index(fields=["feed", "identifier"]),
            models.Index(fields=["feed", "date"]),
            models.Index(fields=["date"]),
            models.Index(fields=["read"]),
            models.Index(fields=["starred"]),
            models.Index(fields=["feed", "read", "date"]),
            # Stable append-only ordering / future sync cursor
            models.Index(fields=["-created_at", "-id"]),
            models.Index(fields=["feed", "-created_at"]),
        ]
```

- [ ] **Step 4: Generate and apply the migration**

```bash
uv run python manage.py makemigrations core --name article_created_at_indexes && uv run python manage.py migrate
```

Expected: `0028_article_created_at_indexes.py` created with two `AddIndex` operations, migrate OK.

- [ ] **Step 5: Confirm no further model drift**

```bash
uv run python manage.py makemigrations --check --dry-run
```

Expected: "No changes detected".

- [ ] **Step 6: Run the tests and linters**

```bash
uv run pytest core/tests/test_performance_indexes.py -v && uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

- [ ] **Step 7: Commit**

```bash
git add core/models.py core/migrations/0028_article_created_at_indexes.py core/tests/test_performance_indexes.py
git commit -m "perf(models): Index created_at for stable article ordering"
```

---

## Task 8: Docs and end-to-end verification

**Files:**
- Modify: `CLAUDE.md:255-265` (aggregator example) and the SQLite/HTTP-adjacent notes
- Modify: `core/aggregators/README.md` (new "Content Selection" section)

**Interfaces:**
- Consumes: everything above.
- Produces: docs that match the shipped code.

- [ ] **Step 1: Fix the aggregator example in `CLAUDE.md`**

Replace the class body in the "Creating a New Aggregator" step 3 snippet (around line 261):

```python
   class MySiteAggregator(FullWebsiteAggregator):
       content_selectors = ["div.article-body"]
       selectors_to_remove = ["div.ads", ".social-buttons"]
       uses_first_content_match = True  # body lives in one known container

       def get_source_url(self):
           return "https://mysite.com/rss"
```

- [ ] **Step 2: Add a docs note on article dates in `CLAUDE.md`**

Under the "Key Models" table, add:

```markdown
**Article dates:** `Article.date` is the feed's real publish time — aggregation never rewrites it.
Use `created_at` (indexed with `id` as tie-breaker) for stable, append-only ordering such as sync
cursors; `date` is for display and retention.
```

- [ ] **Step 3: Document content selection in `core/aggregators/README.md`**

Insert a new section directly before `## Creating a New Aggregator`:

```markdown
## Content Selection

`FullWebsiteAggregator` resolves the article body from a *list* of CSS selectors. Every selector is
applied and all surviving containers are concatenated in document order, so a body split across
sibling containers is not truncated. A match nested inside another match is dropped (outermost
wins), and duplicates are collapsed.

| Hook | Where | Purpose |
|---|---|---|
| `content_selectors: list[str]` | aggregator class | Places to look for the body. Default: `article`, `.article-content`, `.entry-content`, `main` |
| `selectors_to_remove: list[str]` | aggregator class | Scraper-specific removals, always applied |
| `uses_first_content_match: bool` | aggregator class | `True` for scrapers with one known container — keeps only the first match instead of unioning |
| `content_selectors` | `Feed.options` | Per-feed override of the class list. Absent → class default; present-but-empty → deliberately empty |
| `ignore_selectors` | `Feed.options` | Per-feed removals. Absent → the shared defaults (`.advertisement`, `.ad`, `.ads`, `[class*='advert']`, `[class*='sponsor']`, `.social-share`, `.newsletter`, `.related-articles`) |

Sanitization of `script`, `style`, `noscript` and `template` is applied before selection and cannot
be disabled by any option. Iframes are an aggregator-level policy: `FullWebsiteAggregator` carries
`IFRAME_SANITIZE_SELECTOR` (everything but YouTube) in its `selectors_to_remove`, and a scraper that
supports more embed hosts — Caschy's Blog allows Twitter/X — overrides that list and filters iframes
itself in `process_content`.

Two escape hatches for scrapers with a dedicated container:

- `extract_main_content_if_present(...)` returns `None` instead of falling back to `<body>`, so a
  paywall or gate page cannot surface site navigation as the article.
- `generic_content_if_present(raw_html, article)` retries with the *generic* default selectors and
  requires at least 80 characters of real text — for syndicated pages on other domains that carry
  none of the scraper's markup.

Resolution order for such a scraper: dedicated container → generic extraction (≥80 chars) → RSS
summary.
```

- [ ] **Step 4: Verify no stale references remain**

```bash
grep -rn "use_full_content\|custom_content_selector\|custom_selectors_to_remove\|content_selector\b" core/ CLAUDE.md README.md
```

Expected: no matches (spec files under `docs/superpowers/specs/` are historical — leave them).

- [ ] **Step 5: Run every check**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/ && uv run pytest
```

Expected: clean; report the actual pass/fail counts.

- [ ] **Step 6: Verify in the admin (spec's verification list)**

```bash
uv run python manage.py migrate && uv run python manage.py runserver
```

Confirm at `http://localhost:8000/admin/`:
1. A `full_website` feed shows "Content Selectors" / "Ignore Selectors" (comma-separated text) and
   no "Fetch Full Content" checkbox; its `options` JSON has no legacy keys.
2. Any feed that had `use_full_content: false` now shows aggregator "Feed Content (RSS/Atom)".
3. Saving a feed with both selector fields blank leaves the keys absent in `options`.

Then, for a real feed (replace `<id>`):

```bash
uv run python manage.py test_aggregator <id> --first 1 --verbose --selector-debug
```

Confirm the debug output lists "Content selectors" as a comma-separated list, the extracted body
includes content from sibling containers, and the article date is the real publish date rather than
now.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md core/aggregators/README.md
git commit -m "docs(aggregators): Document selector lists and article date semantics"
```

---

## Spec coverage map

| Spec section | Task |
|---|---|
| §1 selector lists — union, document order, outermost wins, dedup, `<body>` fallback | 1 |
| §1 (a) first-match opt-out (`uses_first_content_match`) | 3 (hook + scraper opt-outs) |
| §1 (b) `extract_main_content_if_present` | 1 |
| §1 (c) `generic_content_if_present` with the 80-char floor | 4 |
| §1 options schema (`content_selectors` / `ignore_selectors`, iOS defaults, mandatory removals) | 1 (constants), 3 (plumbing) |
| §1 data migration incl. the present/absent/empty three-way | 5 |
| §2 remove `use_full_content` + convert affected feeds | 3 (code), 5 (migration) |
| §3 strip `<template>` | 1 |
| §4 stop overwriting dates | 6 |
| §4 `created_at` indexes, `Meta.ordering` unchanged | 7 |
| Error handling: invalid selector, all-miss fallback, malformed options | 1, 5 |
| Testing checklist | 1, 3, 4, 5, 6, 7 |
| Verification via admin | 8 |
