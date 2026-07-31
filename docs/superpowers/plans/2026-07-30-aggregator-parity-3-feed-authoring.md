# Aggregator Parity 3 — Feed Authoring Implementation Plan

> **Superseded by the Next.js migration (2026-07-30).** The Django implementation
> described here now lives in `old/`, read-only — paths like `core/…` are `old/core/…`
> today. This document is kept as a record of decisions that were correct when made,
> and its behavior descriptions remain the reference for porting them to TypeScript.
> See [the Next.js direction record](../specs/2026-07-30-nextjs-migration-direction.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the four feed-setup capabilities iOS has and the server lacks — feed discovery from a
homepage URL, identifier normalization, per-feed logo resolution, and AI selector suggestion.

**Architecture:** Four independent, best-effort helper layers under `core/aggregators/utils/` plus one
resolver (`core/aggregators/feed_logo.py`) and one service (`core/services/selector_suggester.py`).
Every piece is *pure function first, network second*: the parsing half takes a string and is unit
tested without HTTP, the fetching half is a thin wrapper. Nothing in this plan may raise into feed
saving — a resolve, favicon, or AI failure leaves the feed saveable and the previous value intact.
Wiring happens in exactly three places: `RssAggregator.fetch_source_data` (discovery fallback),
`FeedAdminForm` (resolve + logo on save), and `FeedAdmin` actions (Resolve & test, Refresh logo, two
Suggest actions).

**Tech Stack:** Python 3.13, Django 6.0, BeautifulSoup 4.14 (`html.parser`), feedparser 6, requests
2.32, Pillow 11 (logo background removal), pytest 9 + pytest-django, uv for all commands.

**Spec:** `docs/superpowers/specs/2026-07-29-aggregator-parity-3-feed-authoring-design.md`

## Global Constraints

- Line length **100** characters; double quotes; `ruff format` output is authoritative.
- Ruff rule sets in force: `E`, `F`, `W`, `I`, `B`, `SIM`, `C4`, `DJ`. `mypy core/` must stay clean.
- All commands run through uv — `uv run pytest`, `uv run ruff check . --fix`, `uv run ruff format .`,
  `uv run mypy .`. There is no venv to activate.
- **No test may touch the network.** Mock `fetch_html` / `fetch_bytes` / `parse_rss_feed` / `AIClient`
  at the module where the code under test imported them.
- **Only ever contact the site's own domain** for icons. No third-party favicon service, ever — that
  would leak every subscribed URL to a third party.
- Favicon background thresholds must stay byte-identical to iOS: `WHITE_THRESHOLD = 240`,
  `BORDER_WHITE_FRACTION = 0.85`.
- **RSS is preferred over Atom** when a page advertises both.
- Every helper degrades instead of raising into feed configuration. A dead favicon URL, an
  unreachable homepage, or a broken AI provider must never prevent saving a feed.
- Discovery is **not cached** in this version; it re-runs per fetch.
- Commit after every task with a `<type>(<scope>): <description>` message.

## Deviations from the spec (deliberate, reviewed)

1. **The AI prompt gets an HTML digest, not plain text.** The spec asks for "an equivalent of iOS's
   `ArticleAIText` — a plain-text extraction with a character cap". Plain text cannot support CSS
   selector suggestion: the model needs tags, classes, and ids to name a selector. Task 11 therefore
   builds `html_digest_for_selectors()` — the same idea (strip chrome, cap length) applied to markup:
   drop `script`/`style`/`noscript`/`svg`/comments, truncate each text node to 80 characters so prose
   cannot crowd out structure, then cap the whole digest at 40,000 characters. Everything else about
   item 4 (one kind at a time, current entries as candidates, overwrite only the requested list) is
   as specified.
2. **`resolve_site_icon` returns the `/favicon.ico` URL without verifying it.** The spec's fallback is
   "try `/favicon.ico` on the same origin". Verifying it would cost an extra request whose only
   outcome is `None` instead of a URL that the download step in Task 10 already handles by leaving
   `logo` empty. One request, same observable result.
3. **`the_verge` / `ars_technica` brand rows are omitted.** They do not exist until Spec 2, which is
   running in parallel. The spec explicitly says to add their rows when Spec 2 lands; Task 9 leaves a
   comment naming them so the follow-up is obvious.
4. **`suggest_selectors` raises `SelectorSuggestionError` on failure** rather than returning an empty
   list. The spec's signature is `-> list[str]` and its error rule is "never overwrite a working
   selector list with nothing"; an exception is the only way to keep both. The admin action catches it
   and reports it as a message.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `core/aggregators/utils/feed_url_resolver.py` | `normalize()` (pure), `resolve_feed_url()` (never raises) |
| `core/aggregators/utils/feed_discovery.py` | `feed_url_in_html()` (pure), `discover_feed_url()` (fetches) |
| `core/aggregators/utils/favicon.py` | `best_icon_url()` (pure), `resolve_site_icon()` (fetches) |
| `core/aggregators/utils/logo_background.py` | `remove_white_background()` — Pillow flood fill |
| `core/aggregators/feed_logo.py` | Three-tier logo priority + download/store |
| `core/services/selector_suggester.py` | AI selector suggestion + `Feed.options` write-back |
| `core/migrations/0030_feed_logo.py` | `Feed.logo`, `Feed.logo_source_url` |
| `core/tests/test_feed_url_resolver.py` | Tasks 1, 3 |
| `core/tests/test_feed_discovery.py` | Tasks 2, 4 |
| `core/tests/test_favicon.py` | Task 6 |
| `core/tests/test_logo_background.py` | Task 7 |
| `core/tests/test_feed_logo.py` | Tasks 8, 9, 10 |
| `core/tests/test_selector_suggester.py` | Tasks 11, 12 |
| `core/tests/test_feed_admin_authoring.py` | Tasks 5, 10, 12 admin surfaces |

**Modified:**

| File | Change |
|---|---|
| `core/aggregators/base.py` | `resolves_feed_url()`, `brand_site_url`, `logo_image_url()` |
| `core/aggregators/rss.py` | Discovery fallback in `fetch_source_data` |
| `core/aggregators/utils/html_fetcher.py` | Add `fetch_bytes()` |
| `core/aggregators/utils/__init__.py` | Export the new helpers |
| `core/aggregators/{heise,merkur,tagesschau,explosm,dark_legacy,caschys_blog,mactechnews,oglaf,mein_mmo}` | `brand_site_url` |
| `core/aggregators/reddit/aggregator.py`, `core/aggregators/youtube/aggregator.py` | `logo_image_url()` |
| `core/models.py` | `Feed.logo`, `Feed.logo_source_url` |
| `core/forms.py` | `clean_identifier()`, logo resolution in `save()` |
| `core/admin.py` | Four actions + `get_actions()` gating |
| `CLAUDE.md`, `core/aggregators/README.md`, `README.md` | Document the new capabilities |

---

## Task 1: URL normalization

**Files:**
- Create: `core/aggregators/utils/feed_url_resolver.py`
- Test: `core/tests/test_feed_url_resolver.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalize(raw: str) -> str`. Task 3 extends this module with
  `resolve_feed_url(raw: str) -> str`.

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_feed_url_resolver.py`:

```python
"""Tests for feed URL normalization and resolution."""

from core.aggregators.utils.feed_url_resolver import normalize


def test_bare_domain_gains_https():
    assert normalize("golem.de") == "https://golem.de"


def test_existing_http_scheme_is_preserved():
    assert normalize("http://golem.de/rss.php") == "http://golem.de/rss.php"


def test_existing_https_scheme_is_preserved():
    assert normalize("https://golem.de/rss.php") == "https://golem.de/rss.php"


def test_feed_scheme_is_rewritten_to_https():
    assert normalize("feed://golem.de/rss.php") == "https://golem.de/rss.php"


def test_uppercase_feed_scheme_is_rewritten():
    assert normalize("FEED://golem.de/rss.php") == "https://golem.de/rss.php"


def test_whitespace_is_trimmed():
    assert normalize("  golem.de  ") == "https://golem.de"


def test_empty_passes_through():
    assert normalize("") == ""
    assert normalize("   ") == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest core/tests/test_feed_url_resolver.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'core.aggregators.utils.feed_url_resolver'`

- [ ] **Step 3: Write minimal implementation**

Create `core/aggregators/utils/feed_url_resolver.py`:

```python
"""Feed URL normalization and resolution.

Mirrors the iOS client's ``FeedURLResolver``: a user may paste ``golem.de``,
``feed://golem.de/rss.php``, or a full feed URL, and all three have to end up as
something the RSS pipeline can fetch.
"""

FEED_SCHEME = "feed://"
HTTPS_SCHEME = "https://"


def normalize(raw: str) -> str:
    """Trim, prepend ``https://`` when no scheme is present, rewrite ``feed://``.

    Empty (or whitespace-only) input passes through as an empty string so a
    blank identifier stays blank.
    """
    trimmed = (raw or "").strip()
    if not trimmed:
        return ""

    if trimmed.lower().startswith(FEED_SCHEME):
        return HTTPS_SCHEME + trimmed[len(FEED_SCHEME) :]

    if "://" in trimmed:
        return trimmed

    return HTTPS_SCHEME + trimmed
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest core/tests/test_feed_url_resolver.py -v`
Expected: 7 passed

- [ ] **Step 5: Lint, format, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
git add core/aggregators/utils/feed_url_resolver.py core/tests/test_feed_url_resolver.py
git commit -m "feat(aggregators): Normalize pasted feed URLs"
```

---

## Task 2: Feed discovery from page HTML

**Files:**
- Create: `core/aggregators/utils/feed_discovery.py`
- Test: `core/tests/test_feed_discovery.py`

**Interfaces:**
- Consumes: `fetch_html(url: str, timeout: int = 30) -> str` from
  `core.aggregators.utils.html_fetcher` (raises `requests.RequestException` after 3 retries);
  `get_attr_list` / `get_attr_str` from `core.aggregators.utils.bs4_utils`.
- Produces: `feed_url_in_html(html: str, base_url: str | None) -> str | None` and
  `discover_feed_url(page_url: str) -> str | None`. Tasks 3 and 4 both call `discover_feed_url`.

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_feed_discovery.py`:

```python
"""Tests for RSS/Atom feed discovery from page HTML."""

from unittest.mock import patch

import requests

from core.aggregators.utils.feed_discovery import discover_feed_url, feed_url_in_html

RSS_LINK = '<link rel="alternate" type="application/rss+xml" href="/rss.php">'
ATOM_LINK = '<link rel="alternate" type="application/atom+xml" href="/atom.xml">'


def _page(*links: str) -> str:
    return f"<html><head>{''.join(links)}</head><body>x</body></html>"


def test_rss_link_is_found_and_resolved_absolute():
    html = _page(RSS_LINK)
    assert feed_url_in_html(html, "https://golem.de/") == "https://golem.de/rss.php"


def test_atom_only_page_is_found():
    html = _page(ATOM_LINK)
    assert feed_url_in_html(html, "https://golem.de/") == "https://golem.de/atom.xml"


def test_rss_is_preferred_when_both_are_advertised():
    html = _page(ATOM_LINK, RSS_LINK)
    assert feed_url_in_html(html, "https://golem.de/") == "https://golem.de/rss.php"


def test_absolute_href_is_left_alone():
    html = _page('<link rel="alternate" type="application/rss+xml" href="https://cdn.example/f.xml">')
    assert feed_url_in_html(html, "https://golem.de/") == "https://cdn.example/f.xml"


def test_no_alternate_link_returns_none():
    assert feed_url_in_html(_page('<link rel="stylesheet" href="/a.css">'), "https://golem.de/") is None


def test_empty_href_is_skipped():
    html = _page('<link rel="alternate" type="application/rss+xml" href="   ">', ATOM_LINK)
    assert feed_url_in_html(html, "https://golem.de/") == "https://golem.de/atom.xml"


def test_non_feed_alternate_type_is_ignored():
    html = _page('<link rel="alternate" type="text/html" href="/en/">')
    assert feed_url_in_html(html, "https://golem.de/") is None


def test_missing_base_url_returns_href_unchanged():
    assert feed_url_in_html(_page(RSS_LINK), None) == "/rss.php"


def test_empty_html_returns_none():
    assert feed_url_in_html("", "https://golem.de/") is None


def test_discover_feed_url_fetches_and_parses():
    with patch(
        "core.aggregators.utils.feed_discovery.fetch_html", return_value=_page(RSS_LINK)
    ) as fetch:
        assert discover_feed_url("https://golem.de/") == "https://golem.de/rss.php"
    fetch.assert_called_once_with("https://golem.de/")


def test_discover_feed_url_returns_none_on_network_error():
    with patch(
        "core.aggregators.utils.feed_discovery.fetch_html",
        side_effect=requests.RequestException("boom"),
    ):
        assert discover_feed_url("https://golem.de/") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest core/tests/test_feed_discovery.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'core.aggregators.utils.feed_discovery'`

- [ ] **Step 3: Write minimal implementation**

Create `core/aggregators/utils/feed_discovery.py`:

```python
"""Discover a site's advertised RSS/Atom feed.

Mirrors the iOS client's ``FeedDiscovery``. Parsing and fetching are split so
the parse half is testable without network, and so callers that already hold the
page HTML do not fetch it twice.
"""

import logging
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from .bs4_utils import get_attr_list, get_attr_str
from .html_fetcher import fetch_html

logger = logging.getLogger(__name__)

RSS_TYPE = "application/rss+xml"
ATOM_TYPE = "application/atom+xml"

# RSS before Atom: the iOS client picks RSS when a page advertises both, and the
# two implementations have to agree on which feed a given site resolves to.
FEED_TYPE_PRIORITY = (RSS_TYPE, ATOM_TYPE)


def feed_url_in_html(html: str, base_url: str | None) -> str | None:
    """First alternate RSS/Atom feed href in ``html``, resolved absolute.

    Pure -- no network. Returns ``None`` when the page advertises no feed.
    """
    soup = BeautifulSoup(html or "", "html.parser")
    first_by_type: dict[str, str] = {}

    for link in soup.find_all("link"):
        rels = [rel.lower() for rel in get_attr_list(link, "rel")]
        if "alternate" not in rels:
            continue

        link_type = get_attr_str(link, "type").strip().lower()
        if link_type not in FEED_TYPE_PRIORITY:
            continue

        href = get_attr_str(link, "href").strip()
        if not href:
            continue

        first_by_type.setdefault(link_type, href)

    for wanted in FEED_TYPE_PRIORITY:
        href = first_by_type.get(wanted)
        if href:
            return urljoin(base_url, href) if base_url else href

    return None


def discover_feed_url(page_url: str) -> str | None:
    """Fetch ``page_url`` and return its advertised feed URL, or ``None``.

    Best-effort: any fetch failure is logged and reported as ``None``.
    """
    try:
        html = fetch_html(page_url)
    except Exception as exc:
        logger.debug(f"Feed discovery could not fetch {page_url}: {exc}")
        return None

    return feed_url_in_html(html, page_url)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest core/tests/test_feed_discovery.py -v`
Expected: 11 passed

- [ ] **Step 5: Lint, format, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
git add core/aggregators/utils/feed_discovery.py core/tests/test_feed_discovery.py
git commit -m "feat(aggregators): Discover advertised feeds in page HTML"
```

---

## Task 3: `resolve_feed_url` and the per-aggregator gate

**Files:**
- Modify: `core/aggregators/utils/feed_url_resolver.py`
- Modify: `core/aggregators/base.py` (add `resolves_feed_url()` next to `supports_identifier_search`,
  around line 31)
- Modify: `core/aggregators/mactechnews/aggregator.py`, `core/aggregators/oglaf/aggregator.py`
  (override the gate — see Step 3)
- Modify: `core/aggregators/utils/__init__.py`
- Test: `core/tests/test_feed_url_resolver.py`

**Interfaces:**
- Consumes: `normalize()` (Task 1), `discover_feed_url()` (Task 2), and
  `parse_rss_feed(url) -> dict` from `core.aggregators.utils.rss_parser` — note it **raises
  `ValueError`** for an invalid URL, a bozo feed, *and* a feed with zero entries.
- Produces: `resolve_feed_url(raw: str) -> str` (never raises) and the classmethod
  `BaseAggregator.resolves_feed_url() -> bool`. Task 5 uses both.

- [ ] **Step 1: Write the failing test**

Append to `core/tests/test_feed_url_resolver.py`:

```python
from unittest.mock import patch

import pytest
import requests

from core.aggregators.registry import AggregatorRegistry
from core.aggregators.utils.feed_url_resolver import normalize, resolve_feed_url


def test_already_a_feed_returns_normalized_input_without_discovery():
    with (
        patch(
            "core.aggregators.utils.feed_url_resolver.parse_rss_feed",
            return_value={"entries": [{"title": "a"}], "feed": {}, "version": "rss20"},
        ),
        patch("core.aggregators.utils.feed_url_resolver.discover_feed_url") as discover,
    ):
        assert resolve_feed_url("golem.de/rss.php") == "https://golem.de/rss.php"
    discover.assert_not_called()


def test_homepage_resolves_to_discovered_feed():
    with (
        patch(
            "core.aggregators.utils.feed_url_resolver.parse_rss_feed",
            side_effect=ValueError("No entries found in feed"),
        ),
        patch(
            "core.aggregators.utils.feed_url_resolver.discover_feed_url",
            return_value="https://golem.de/rss.php",
        ),
    ):
        assert resolve_feed_url("golem.de") == "https://golem.de/rss.php"


def test_no_discoverable_feed_returns_normalized_input():
    with (
        patch(
            "core.aggregators.utils.feed_url_resolver.parse_rss_feed",
            side_effect=ValueError("No entries found in feed"),
        ),
        patch(
            "core.aggregators.utils.feed_url_resolver.discover_feed_url", return_value=None
        ),
    ):
        assert resolve_feed_url("golem.de") == "https://golem.de"


def test_network_failure_returns_normalized_input_without_raising():
    with (
        patch(
            "core.aggregators.utils.feed_url_resolver.parse_rss_feed",
            side_effect=requests.RequestException("boom"),
        ),
        patch(
            "core.aggregators.utils.feed_url_resolver.discover_feed_url",
            side_effect=requests.RequestException("boom"),
        ),
    ):
        assert resolve_feed_url("golem.de") == "https://golem.de"


def test_empty_input_never_hits_the_network():
    with patch("core.aggregators.utils.feed_url_resolver.parse_rss_feed") as parse:
        assert resolve_feed_url("  ") == ""
    parse.assert_not_called()


@pytest.mark.parametrize("aggregator_type", ["full_website", "feed_content", "podcast"])
def test_free_form_url_aggregators_resolve(aggregator_type):
    assert AggregatorRegistry.get(aggregator_type).resolves_feed_url() is True


@pytest.mark.parametrize(
    "aggregator_type",
    [
        "heise",
        "merkur",
        "tagesschau",
        "explosm",
        "dark_legacy",
        "caschys_blog",
        "mein_mmo",
        "mactechnews",
        "oglaf",
        "reddit",
        "youtube",
    ],
)
def test_managed_and_non_url_aggregators_do_not_resolve(aggregator_type):
    assert AggregatorRegistry.get(aggregator_type).resolves_feed_url() is False
```

`mactechnews` and `oglaf` are the two fixed-brand scrapers that publish *no*
`identifier_choices` — they hardcode a default identifier in `__init__` instead. The default gate
would call them free-form, so they need the explicit override in Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest core/tests/test_feed_url_resolver.py -v`
Expected: FAIL — `ImportError: cannot import name 'resolve_feed_url'`

- [ ] **Step 3: Write minimal implementation**

Append to `core/aggregators/utils/feed_url_resolver.py`:

```python
import logging

from .feed_discovery import discover_feed_url
from .rss_parser import parse_rss_feed

logger = logging.getLogger(__name__)


def resolve_feed_url(raw: str) -> str:
    """``normalize()``, then resolve a homepage to its advertised feed.

    Never raises. Returns the normalized input when it already parses as a feed,
    when discovery finds nothing, or on any network or parse failure -- a resolve
    failure must not block saving a feed, which is what makes this safe to call
    from a form's ``clean()``.
    """
    normalized = normalize(raw)
    if not normalized:
        return normalized

    try:
        parse_rss_feed(normalized)
        return normalized
    except Exception:
        # Not a feed (or unreachable) -- fall through to discovery.
        pass

    try:
        discovered = discover_feed_url(normalized)
    except Exception as exc:
        logger.debug(f"Feed resolution failed for {normalized}: {exc}")
        return normalized

    return discovered or normalized
```

Move the two new imports and `logging` up to the module's import block when you add them — ruff's
`I` rule will fail otherwise.

Add to `BaseAggregator` in `core/aggregators/base.py`, directly after
`supports_identifier_search = False`:

```python
    @classmethod
    def resolves_feed_url(cls) -> bool:
        """Whether a pasted identifier should be normalized and resolved.

        True only for free-form URL types (full_website, feed_content, podcast).
        Managed feeds pick their identifier from fixed ``identifier_choices``, and
        the non-URL kinds hold a subreddit name or a channel id -- normalizing
        ``swift`` into ``https://swift`` would be a real bug. Override per
        aggregator when the default reads the wrong way.
        """
        if cls.identifier_field != "identifier":
            return False
        return not cls.get_identifier_choices()
```

Add the override to `MactechnewsAggregator` (`core/aggregators/mactechnews/aggregator.py`) and
`OglafAggregator` (`core/aggregators/oglaf/aggregator.py`), in each class body:

```python
    @classmethod
    def resolves_feed_url(cls) -> bool:
        """Fixed-brand scraper: the identifier is its own hardcoded feed URL."""
        return False
```

These two publish no `identifier_choices`, so the default would treat them as free-form URL types.

Export the new helpers from `core/aggregators/utils/__init__.py` — add the imports and the
`__all__` entries:

```python
from .feed_discovery import discover_feed_url, feed_url_in_html
from .feed_url_resolver import normalize, resolve_feed_url
```

```python
    "discover_feed_url",
    "feed_url_in_html",
    "normalize",
    "resolve_feed_url",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest core/tests/test_feed_url_resolver.py -v`
Expected: all passed (7 from Task 1 + 5 resolve + 12 parametrized gate cases)

If a managed scraper's `get_identifier_choices()` turns out to make a network call, that
parametrized case will hang or error — in that case override `resolves_feed_url()` to
`return False` on that aggregator class instead of loosening the default.

- [ ] **Step 5: Run the whole suite (the gate touches every aggregator)**

Run: `uv run pytest -q`
Expected: 434 baseline tests plus the new ones, 0 failures

- [ ] **Step 6: Lint, format, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
git add core/aggregators/utils/feed_url_resolver.py core/aggregators/base.py \
  core/aggregators/utils/__init__.py core/tests/test_feed_url_resolver.py
git commit -m "feat(aggregators): Resolve pasted homepages to their feed URL"
```

---

## Task 4: Discovery fallback in the RSS pipeline

**Files:**
- Modify: `core/aggregators/rss.py` (`fetch_source_data`, around line 33)
- Test: `core/tests/test_feed_discovery.py`

**Interfaces:**
- Consumes: `discover_feed_url()` (Task 2), `parse_rss_feed()` (raises `ValueError` when the
  identifier is not a feed or has zero entries).
- Produces: no new public API. `RssAggregator.fetch_source_data` now transparently follows a
  homepage identifier to its feed.

- [ ] **Step 1: Write the failing test**

Append to `core/tests/test_feed_discovery.py`:

```python
import pytest

from core.aggregators.implementations import FeedContentAggregator
from core.models import Feed

FEED_DATA = {"entries": [{"title": "a", "link": "https://golem.de/a"}], "feed": {}, "version": "rss20"}


@pytest.fixture
def homepage_feed(user):
    return Feed.objects.create(
        name="Golem", aggregator="feed_content", identifier="https://golem.de/", user=user
    )


@pytest.mark.django_db
def test_fetch_source_data_follows_discovery_when_identifier_is_a_page(homepage_feed):
    aggregator = FeedContentAggregator(homepage_feed)

    with (
        patch(
            "core.aggregators.rss.parse_rss_feed",
            side_effect=[ValueError("No entries found in feed"), FEED_DATA],
        ) as parse,
        patch(
            "core.aggregators.rss.discover_feed_url", return_value="https://golem.de/rss.php"
        ),
    ):
        assert aggregator.fetch_source_data() == FEED_DATA

    assert parse.call_args_list[-1].args[0] == "https://golem.de/rss.php"


@pytest.mark.django_db
def test_fetch_source_data_reraises_when_nothing_is_discoverable(homepage_feed):
    aggregator = FeedContentAggregator(homepage_feed)

    with (
        patch(
            "core.aggregators.rss.parse_rss_feed",
            side_effect=ValueError("No entries found in feed"),
        ),
        patch("core.aggregators.rss.discover_feed_url", return_value=None),
        pytest.raises(ValueError, match="No entries found in feed"),
    ):
        aggregator.fetch_source_data()


@pytest.mark.django_db
def test_fetch_source_data_skips_discovery_for_a_non_url_identifier(user):
    feed = Feed.objects.create(
        name="Broken", aggregator="feed_content", identifier="not a url", user=user
    )
    aggregator = FeedContentAggregator(feed)

    with (
        patch("core.aggregators.rss.parse_rss_feed", side_effect=ValueError("Invalid feed URL")),
        patch("core.aggregators.rss.discover_feed_url") as discover,
        pytest.raises(ValueError, match="Invalid feed URL"),
    ):
        aggregator.fetch_source_data()

    discover.assert_not_called()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest core/tests/test_feed_discovery.py -k fetch_source_data -v`
Expected: FAIL — the first test errors because `parse_rss_feed`'s `ValueError` propagates

- [ ] **Step 3: Write minimal implementation**

In `core/aggregators/rss.py`, add to the imports:

```python
from urllib.parse import urlparse

from .utils import discover_feed_url, parse_rss_feed
```

Replace `fetch_source_data`:

```python
    def fetch_source_data(self, limit: Optional[int] = None) -> Dict[str, Any]:
        """Fetch RSS feed data, following a homepage to its advertised feed.

        ``parse_rss_feed`` raises ``ValueError`` both when the identifier is not
        a feed and when it yields zero entries. Either way, if the identifier
        looks like a page URL, try the feed the page advertises. Best-effort: an
        identifier with no discoverable feed re-raises the original error, so the
        outcome stays the existing "no entries" one rather than a new error class.
        """
        self.logger.info(f"Fetching RSS feed: {self.identifier}")
        try:
            return parse_rss_feed(self.identifier)
        except ValueError:
            parsed = urlparse(self.identifier or "")
            if not parsed.scheme or not parsed.netloc:
                raise

            discovered = discover_feed_url(self.identifier)
            if not discovered or discovered == self.identifier:
                raise

            self.logger.info(f"Discovered feed for {self.identifier}: {discovered}")
            return parse_rss_feed(discovered)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest core/tests/test_feed_discovery.py -v`
Expected: all passed

- [ ] **Step 5: Run the aggregator suites that exercise this path**

Run: `uv run pytest core/tests -k "aggregator or podcast" -q`
Expected: 0 failures

- [ ] **Step 6: Lint, format, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
git add core/aggregators/rss.py core/tests/test_feed_discovery.py
git commit -m "feat(aggregators): Follow a homepage identifier to its feed"
```

---

## Task 5: Admin — resolve on save and a "Resolve & test" action

**Files:**
- Modify: `core/forms.py` (`FeedAdminForm`, add `clean_identifier` before `save`, line ~205)
- Modify: `core/admin.py` (`FeedAdmin.actions` list at line ~158, new action method near
  `aggregate_selected_feeds` at line ~425)
- Test: `core/tests/test_feed_admin_authoring.py`

**Interfaces:**
- Consumes: `resolve_feed_url()` and `BaseAggregator.resolves_feed_url()` (Task 3);
  `AggregatorRegistry.get(type)`; `parse_rss_feed()`.
- Produces: `FeedAdminForm.clean_identifier()`; `FeedAdmin.resolve_and_test_feeds` action
  (short description `"Resolve & test"`).

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_feed_admin_authoring.py`:

```python
"""Tests for the feed-authoring admin surfaces: resolve, test, logo, suggest."""

from unittest.mock import patch

import pytest

from core.admin import FeedAdmin
from core.forms import FeedAdminForm
from core.models import Feed


def _form_data(**overrides):
    data = {
        "name": "Golem",
        "aggregator": "full_website",
        "identifier": "golem.de",
        "daily_limit": 20,
        "options": "{}",
    }
    data.update(overrides)
    return data


@pytest.mark.django_db
def test_clean_identifier_resolves_for_a_url_aggregator():
    with patch(
        "core.forms.resolve_feed_url", return_value="https://golem.de/rss.php"
    ) as resolve:
        form = FeedAdminForm(data=_form_data())
        assert form.is_valid(), form.errors
        assert form.cleaned_data["identifier"] == "https://golem.de/rss.php"
    resolve.assert_called_once_with("golem.de")


@pytest.mark.django_db
def test_clean_identifier_leaves_a_subreddit_alone():
    with patch("core.forms.resolve_feed_url") as resolve:
        form = FeedAdminForm(data=_form_data(aggregator="reddit", identifier="swift"))
        form.is_valid()
        assert form.cleaned_data["identifier"] == "swift"
    resolve.assert_not_called()


@pytest.mark.django_db
def test_clean_identifier_leaves_a_managed_scraper_alone():
    with patch("core.forms.resolve_feed_url") as resolve:
        form = FeedAdminForm(
            data=_form_data(aggregator="heise", identifier="https://www.heise.de/rss/heise.rdf")
        )
        form.is_valid()
        assert form.cleaned_data["identifier"] == "https://www.heise.de/rss/heise.rdf"
    resolve.assert_not_called()


@pytest.mark.django_db
def test_clean_identifier_survives_a_blank_identifier():
    with patch("core.forms.resolve_feed_url") as resolve:
        form = FeedAdminForm(data=_form_data(identifier=""))
        form.is_valid()
        assert form.cleaned_data["identifier"] == ""
    resolve.assert_not_called()


@pytest.mark.django_db
def test_resolve_and_test_action_reports_entry_count_without_saving(rf, user):
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="golem.de", user=user
    )
    admin_instance = FeedAdmin(Feed, None)
    request = rf.post("/admin/core/feed/")
    request.user = user
    messages = []

    with (
        patch("core.admin.resolve_feed_url", return_value="https://golem.de/rss.php"),
        patch(
            "core.admin.parse_rss_feed",
            return_value={"entries": [{"title": "a"}, {"title": "b"}], "feed": {}, "version": "rss20"},
        ),
        patch.object(FeedAdmin, "message_user", lambda self, req, msg, *a, **kw: messages.append(msg)),
    ):
        admin_instance.resolve_and_test_feeds(request, Feed.objects.filter(pk=feed.pk))

    feed.refresh_from_db()
    assert feed.identifier == "golem.de"
    assert any("2" in message and "https://golem.de/rss.php" in message for message in messages)


@pytest.mark.django_db
def test_resolve_and_test_action_reports_a_failure(rf, user):
    feed = Feed.objects.create(
        name="Dead", aggregator="full_website", identifier="dead.example", user=user
    )
    admin_instance = FeedAdmin(Feed, None)
    request = rf.post("/admin/core/feed/")
    request.user = user
    messages = []

    with (
        patch("core.admin.resolve_feed_url", return_value="https://dead.example"),
        patch("core.admin.parse_rss_feed", side_effect=ValueError("No entries found in feed")),
        patch.object(FeedAdmin, "message_user", lambda self, req, msg, *a, **kw: messages.append(msg)),
    ):
        admin_instance.resolve_and_test_feeds(request, Feed.objects.filter(pk=feed.pk))

    assert any("No entries" in message for message in messages)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest core/tests/test_feed_admin_authoring.py -v`
Expected: FAIL — `ImportError: cannot import name 'resolve_feed_url'` from `core.forms`

- [ ] **Step 3: Write minimal implementation**

In `core/forms.py`, add the import at the top:

```python
from .aggregators.registry import AggregatorRegistry
from .aggregators.utils import resolve_feed_url
```

Add to `FeedAdminForm`, directly above `save()`:

```python
    def clean_identifier(self):
        """Normalize and resolve the identifier for free-form URL aggregators.

        A user pasting ``golem.de`` gets ``https://golem.de/rss.php`` stored.
        ``resolve_feed_url`` never raises, so a dead or unreachable site still
        saves -- with the normalized input.
        """
        identifier = self.cleaned_data.get("identifier", "")
        if not identifier:
            return identifier

        aggregator_type = self.cleaned_data.get("aggregator") or self.instance.aggregator
        try:
            agg_class = AggregatorRegistry.get(aggregator_type)
        except Exception:
            return identifier

        if not agg_class.resolves_feed_url():
            return identifier

        return resolve_feed_url(identifier)
```

`aggregator` is declared before `identifier` in `Meta.fields`, so it is already in `cleaned_data`
by the time this runs.

In `core/admin.py`, add the imports:

```python
from .aggregators.utils import parse_rss_feed, resolve_feed_url
```

Add `"resolve_and_test_feeds"` as the first entry of `FeedAdmin.actions`, and add the method next
to `aggregate_selected_feeds`:

```python
    @admin.action(description="Resolve & test")
    def resolve_and_test_feeds(self, request, queryset):
        """Resolve each identifier and report how many entries it yields.

        Reports only -- nothing is saved, so this is safe to run on a feed you
        are still configuring.
        """
        for feed in queryset:
            try:
                agg_class = AggregatorRegistry.get(feed.aggregator)
            except Exception:
                self.message_user(
                    request, f"{feed.name}: unknown aggregator '{feed.aggregator}'", messages.ERROR
                )
                continue

            resolved = (
                resolve_feed_url(feed.identifier)
                if agg_class.resolves_feed_url()
                else feed.identifier
            )

            try:
                data = parse_rss_feed(resolved)
            except Exception as exc:
                self.message_user(request, f"{feed.name}: {resolved} failed -- {exc}", messages.ERROR)
                continue

            entries = len(data.get("entries", []))
            self.message_user(
                request,
                f"{feed.name}: {resolved} yields {entries} entries",
                messages.SUCCESS if entries else messages.WARNING,
            )
```

`messages` is already imported at the top of `core/admin.py`. `AggregatorRegistry` is not — existing
methods import it locally; do the same inside this action (`from .aggregators.registry import
AggregatorRegistry`).

**Import placement matters for the tests.** `resolve_feed_url` and `parse_rss_feed` must be imported
at **module level** in both `core/forms.py` and `core/admin.py`, because the tests patch
`core.forms.resolve_feed_url` / `core.admin.parse_rss_feed`. A function-local import would make those
patch targets nonexistent. Neither module is imported by `core/aggregators/**`, so there is no
import cycle. If a module-level import does blow up at app load, keep the local import and change the
patch targets in the test to the defining module (`core.aggregators.utils.feed_url_resolver.…`)
instead — do not leave a half-patched test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest core/tests/test_feed_admin_authoring.py -v`
Expected: 6 passed

- [ ] **Step 5: Run the form and admin suites**

Run: `uv run pytest core/tests/test_forms.py core/tests/test_feed_save_as_new.py -q`
Expected: 0 failures

- [ ] **Step 6: Lint, format, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
git add core/forms.py core/admin.py core/tests/test_feed_admin_authoring.py
git commit -m "feat(admin): Resolve feed identifiers on save and add Resolve & test"
```

---

## Task 6: Favicon resolution

**Files:**
- Create: `core/aggregators/utils/favicon.py`
- Modify: `core/aggregators/utils/__init__.py`
- Test: `core/tests/test_favicon.py`

**Interfaces:**
- Consumes: `fetch_html()`, `get_attr_list` / `get_attr_str`.
- Produces: `best_icon_url(html: str, base_url: str) -> str | None` and
  `resolve_site_icon(site_url: str) -> str | None`. Task 9 calls `resolve_site_icon`.

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_favicon.py`:

```python
"""Tests for site favicon selection."""

from unittest.mock import patch

import requests

from core.aggregators.utils.favicon import best_icon_url, resolve_site_icon


def _page(*links: str) -> str:
    return f"<html><head>{''.join(links)}</head></html>"


def test_apple_touch_icon_beats_a_larger_plain_icon():
    html = _page(
        '<link rel="icon" sizes="512x512" href="/big.png">',
        '<link rel="apple-touch-icon" sizes="180x180" href="/apple.png">',
    )
    assert best_icon_url(html, "https://heise.de/") == "https://heise.de/apple.png"


def test_largest_sizes_wins_among_plain_icons():
    html = _page(
        '<link rel="icon" sizes="32x32" href="/small.png">',
        '<link rel="icon" sizes="192x192" href="/large.png">',
    )
    assert best_icon_url(html, "https://heise.de/") == "https://heise.de/large.png"


def test_shortcut_icon_rel_is_accepted():
    html = _page('<link rel="shortcut icon" href="/favicon.png">')
    assert best_icon_url(html, "https://heise.de/") == "https://heise.de/favicon.png"


def test_malformed_sizes_does_not_crash_selection():
    html = _page(
        '<link rel="icon" sizes="any" href="/vector.svg">',
        '<link rel="icon" sizes="48x48" href="/raster.png">',
    )
    assert best_icon_url(html, "https://heise.de/") == "https://heise.de/raster.png"


def test_icon_without_sizes_is_still_a_candidate():
    html = _page('<link rel="icon" href="/plain.png">')
    assert best_icon_url(html, "https://heise.de/") == "https://heise.de/plain.png"


def test_empty_href_is_skipped():
    html = _page('<link rel="icon" href="  ">', '<link rel="icon" href="/real.png">')
    assert best_icon_url(html, "https://heise.de/") == "https://heise.de/real.png"


def test_no_icon_links_returns_none():
    assert best_icon_url(_page('<link rel="stylesheet" href="/a.css">'), "https://heise.de/") is None


def test_resolve_site_icon_uses_the_declared_icon():
    html = _page('<link rel="icon" href="/favicon.png">')
    with patch("core.aggregators.utils.favicon.fetch_html", return_value=html):
        assert resolve_site_icon("https://heise.de/") == "https://heise.de/favicon.png"


def test_resolve_site_icon_falls_back_to_favicon_ico():
    with patch("core.aggregators.utils.favicon.fetch_html", return_value=_page()):
        assert resolve_site_icon("https://heise.de/news") == "https://heise.de/favicon.ico"


def test_resolve_site_icon_falls_back_when_the_fetch_fails():
    with patch(
        "core.aggregators.utils.favicon.fetch_html", side_effect=requests.RequestException("boom")
    ):
        assert resolve_site_icon("https://heise.de/") == "https://heise.de/favicon.ico"


def test_resolve_site_icon_returns_none_for_an_unparseable_url():
    with patch("core.aggregators.utils.favicon.fetch_html", side_effect=requests.RequestException()):
        assert resolve_site_icon("not a url") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest core/tests/test_favicon.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'core.aggregators.utils.favicon'`

- [ ] **Step 3: Write minimal implementation**

Create `core/aggregators/utils/favicon.py`:

```python
"""Site favicon resolution.

Mirrors the iOS client's ``FaviconResolver``. Only ever contacts the site's own
domain -- a third-party favicon service would leak every subscribed URL.
"""

import logging
import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from .bs4_utils import get_attr_list, get_attr_str
from .html_fetcher import fetch_html

logger = logging.getLogger(__name__)

SIZES_PATTERN = re.compile(r"(\d+)\s*[xX]\s*(\d+)")


def _sizes_area(sizes: str) -> int:
    """Largest declared area in a ``sizes`` attribute; 0 when undeclared or malformed."""
    best = 0
    for width, height in SIZES_PATTERN.findall(sizes or ""):
        best = max(best, int(width) * int(height))
    return best


def best_icon_url(html: str, base_url: str) -> str | None:
    """Best icon advertised by ``html``, resolved absolute. Pure -- no network.

    ``apple-touch-icon`` wins outright (first one encountered); otherwise the
    plain icon with the largest declared ``sizes`` area, earliest winning ties.
    """
    soup = BeautifulSoup(html or "", "html.parser")
    best_href: str | None = None
    best_area = -1

    for link in soup.find_all("link"):
        rels = [rel.lower() for rel in get_attr_list(link, "rel")]
        if not rels:
            continue

        href = get_attr_str(link, "href").strip()
        if not href:
            continue

        if any("apple-touch-icon" in rel for rel in rels):
            return urljoin(base_url, href)

        if "icon" not in rels:
            continue

        area = _sizes_area(get_attr_str(link, "sizes"))
        if area > best_area:
            best_area = area
            best_href = href

    return urljoin(base_url, best_href) if best_href else None


def resolve_site_icon(site_url: str) -> str | None:
    """Icon URL for ``site_url``, falling back to ``/favicon.ico`` on the same origin.

    The fallback URL is not verified: the caller downloads it anyway and treats a
    failed download as "no logo", so probing it first would only cost a request.
    """
    try:
        html = fetch_html(site_url)
    except Exception as exc:
        logger.debug(f"Could not fetch {site_url} for its icon: {exc}")
        html = ""

    if html:
        declared = best_icon_url(html, site_url)
        if declared:
            return declared

    parsed = urlparse(site_url)
    if not parsed.scheme or not parsed.netloc:
        return None

    return f"{parsed.scheme}://{parsed.netloc}/favicon.ico"
```

Export both from `core/aggregators/utils/__init__.py` (import + `__all__` entries), matching the
existing alphabetical-ish grouping.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest core/tests/test_favicon.py -v`
Expected: 11 passed

- [ ] **Step 5: Lint, format, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
git add core/aggregators/utils/favicon.py core/aggregators/utils/__init__.py core/tests/test_favicon.py
git commit -m "feat(aggregators): Resolve a site's best favicon"
```

---

## Task 7: White-background removal

**Files:**
- Create: `core/aggregators/utils/logo_background.py`
- Modify: `core/aggregators/utils/__init__.py`
- Test: `core/tests/test_logo_background.py`

**Interfaces:**
- Consumes: Pillow (`from PIL import Image`).
- Produces: `remove_white_background(data: bytes) -> bytes | None` — PNG bytes with the
  border-connected white cleared, or `None` when the image is not white-backed (callers then keep
  the original bytes). Task 10 calls it.

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_logo_background.py`:

```python
"""Tests for logo white-background removal."""

import io

from PIL import Image

from core.aggregators.utils.logo_background import remove_white_background


def _png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _white_backed_logo() -> Image.Image:
    """A dark ring on white, with a white hole enclosed by the ring."""
    image = Image.new("RGB", (40, 40), (255, 255, 255))
    for x in range(10, 30):
        for y in range(10, 30):
            image.putpixel((x, y), (20, 20, 20))
    for x in range(18, 22):
        for y in range(18, 22):
            image.putpixel((x, y), (255, 255, 255))
    return image


def _load(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data)).convert("RGBA")


def test_white_border_becomes_transparent():
    result = remove_white_background(_png_bytes(_white_backed_logo()))

    assert result is not None
    assert _load(result).getpixel((0, 0))[3] == 0


def test_enclosed_white_is_preserved():
    result = remove_white_background(_png_bytes(_white_backed_logo()))

    assert result is not None
    image = _load(result)
    assert image.getpixel((20, 20))[3] == 255
    assert image.getpixel((20, 20))[:3] == (255, 255, 255)


def test_subject_pixels_are_untouched():
    result = remove_white_background(_png_bytes(_white_backed_logo()))

    assert result is not None
    assert _load(result).getpixel((12, 12)) == (20, 20, 20, 255)


def test_busy_border_returns_none():
    image = Image.new("RGB", (40, 40), (30, 90, 160))
    assert remove_white_background(_png_bytes(image)) is None


def test_mostly_white_border_still_counts_as_white_backed():
    image = _white_backed_logo()
    for x in range(0, 4):
        image.putpixel((x, 0), (10, 10, 10))
    assert remove_white_background(_png_bytes(image)) is not None


def test_one_by_one_image_returns_none():
    image = Image.new("RGB", (1, 1), (255, 255, 255))
    assert remove_white_background(_png_bytes(image)) is None


def test_undecodable_bytes_return_none():
    assert remove_white_background(b"not an image") is None


def test_empty_bytes_return_none():
    assert remove_white_background(b"") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest core/tests/test_logo_background.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'core.aggregators.utils.logo_background'`

- [ ] **Step 3: Write minimal implementation**

Create `core/aggregators/utils/logo_background.py`:

```python
"""Remove a logo's white background.

Ports the iOS client's ``LogoBackgroundRemover`` from CoreGraphics to Pillow.
The thresholds are deliberately identical to the client's so the two agree on
which logos get a transparent background while both implementations coexist.
"""

import io
import logging
from collections import deque
from collections.abc import Iterator
from typing import Any

from PIL import Image

logger = logging.getLogger(__name__)

# iOS: whiteThreshold = 240, borderWhiteFraction = 0.85. Keep in sync.
WHITE_THRESHOLD = 240
BORDER_WHITE_FRACTION = 0.85


def _is_white(pixel: tuple[int, ...]) -> bool:
    return all(channel >= WHITE_THRESHOLD for channel in pixel[:3])


def _border_coords(width: int, height: int) -> Iterator[tuple[int, int]]:
    for x in range(width):
        yield x, 0
        yield x, height - 1
    for y in range(1, height - 1):
        yield 0, y
        yield width - 1, y


def remove_white_background(data: bytes) -> bytes | None:
    """PNG bytes with border-connected white cleared, or ``None``.

    ``None`` means "not white-backed" (or undecodable) and tells the caller to
    keep the original bytes untouched. White *enclosed* by the subject -- the
    lettering inside a dark circle -- survives, because the fill only reaches
    white connected to the border.
    """
    try:
        with Image.open(io.BytesIO(data)) as opened:
            image = opened.convert("RGBA")
    except Exception as exc:
        logger.debug(f"Could not decode image for background removal: {exc}")
        return None

    width, height = image.size
    if width < 2 or height < 2:
        return None

    pixels: Any = image.load()
    border = list(_border_coords(width, height))
    white_border = [(x, y) for x, y in border if _is_white(pixels[x, y])]
    if len(white_border) / len(border) < BORDER_WHITE_FRACTION:
        return None

    queue = deque(white_border)
    seen = set(white_border)
    while queue:
        x, y = queue.popleft()
        red, green, blue, _ = pixels[x, y]
        pixels[x, y] = (red, green, blue, 0)

        for next_x, next_y in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if not (0 <= next_x < width and 0 <= next_y < height):
                continue
            if (next_x, next_y) in seen or not _is_white(pixels[next_x, next_y]):
                continue
            seen.add((next_x, next_y))
            queue.append((next_x, next_y))

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()
```

Export `remove_white_background` from `core/aggregators/utils/__init__.py`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest core/tests/test_logo_background.py -v`
Expected: 8 passed

- [ ] **Step 5: Lint, format, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
git add core/aggregators/utils/logo_background.py core/aggregators/utils/__init__.py \
  core/tests/test_logo_background.py
git commit -m "feat(aggregators): Clear white logo backgrounds with a border flood fill"
```

---

## Task 8: `Feed.logo` storage fields

**Files:**
- Modify: `core/models.py` (`Feed`, after `options` at line ~89)
- Create: `core/migrations/0030_feed_logo.py` (generated)
- Test: `core/tests/test_feed_logo.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `Feed.logo` (`ImageField`, `upload_to="feed_logos/"`, nullable) and
  `Feed.logo_source_url` (`TextField`, blank, default `""`). Tasks 9 and 10 write both.

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_feed_logo.py`:

```python
"""Tests for per-feed logo resolution and storage."""

import pytest

from core.models import Feed


@pytest.mark.django_db
def test_feed_starts_without_a_logo(user):
    feed = Feed.objects.create(
        name="Heise", aggregator="heise", identifier="https://www.heise.de/rss/heise.rdf", user=user
    )

    assert not feed.logo
    assert feed.logo_source_url == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest core/tests/test_feed_logo.py -v`
Expected: FAIL — `AttributeError: 'Feed' object has no attribute 'logo'`

- [ ] **Step 3: Write minimal implementation**

In `core/models.py`, add to `Feed` after `options`:

```python
    logo = models.ImageField(
        upload_to="feed_logos/",
        blank=True,
        null=True,
        help_text="Resolved feed logo. Refresh via the admin action.",
    )
    logo_source_url = models.TextField(
        blank=True,
        default="",
        help_text="URL the logo was resolved from, kept for re-resolution.",
    )
```

Generate the migration:

```bash
uv run python manage.py makemigrations core --name feed_logo
```

Expected: `core/migrations/0030_feed_logo.py` adding both fields. Open it and confirm it contains
only these two `AddField` operations — if it picked up anything else, the tree was dirty.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest core/tests/test_feed_logo.py core/tests/test_models.py -v`
Expected: all passed

- [ ] **Step 5: Lint, format, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
git add core/models.py core/migrations/0030_feed_logo.py core/tests/test_feed_logo.py
git commit -m "feat(models): Add a per-feed logo and its source URL"
```

---

## Task 9: Logo priority resolution

**Files:**
- Create: `core/aggregators/feed_logo.py`
- Modify: `core/aggregators/base.py` (`brand_site_url`, `logo_image_url()`)
- Modify: `core/aggregators/heise/aggregator.py`, `merkur/aggregator.py`,
  `tagesschau/aggregator.py`, `explosm/aggregator.py`, `dark_legacy/aggregator.py`,
  `caschys_blog/aggregator.py`, `mactechnews/aggregator.py`, `oglaf/aggregator.py`,
  `mein_mmo/aggregator.py` (one `brand_site_url` line each)
- Modify: `core/aggregators/reddit/aggregator.py`, `core/aggregators/youtube/aggregator.py`
  (`logo_image_url()`)
- Test: `core/tests/test_feed_logo.py`

**Interfaces:**
- Consumes: `resolve_site_icon()` (Task 6); `get_aggregator(feed)` from `core.aggregators`;
  `fetch_subreddit_info(subreddit, user_id) -> dict` from `core.aggregators.reddit.urls` (returns
  `{"iconUrl": ...}`); `YouTubeClient.fetch_channels_data([channel_id]) -> list[dict]` whose items
  carry `channel_icon_url`.
- Produces: `resolve_feed_logo_url(feed) -> str | None`;
  `BaseAggregator.brand_site_url: str | None = None`;
  `BaseAggregator.logo_image_url(self) -> str | None` returning `None` by default. Task 10 calls
  `resolve_feed_logo_url`.

- [ ] **Step 1: Write the failing test**

Append to `core/tests/test_feed_logo.py`:

```python
from unittest.mock import patch

from core.aggregators.feed_logo import resolve_feed_logo_url
from core.aggregators.registry import AggregatorRegistry

BRAND_SITES = {
    "heise": "https://www.heise.de/",
    "merkur": "https://www.merkur.de/",
    "tagesschau": "https://www.tagesschau.de/",
    "explosm": "https://explosm.net/",
    "dark_legacy": "https://darklegacycomics.com/",
    "caschys_blog": "https://stadt-bremerhaven.de/",
    "mactechnews": "https://www.mactechnews.de/",
    "oglaf": "https://www.oglaf.com/",
    "mein_mmo": "https://mein-mmo.de/",
}


@pytest.mark.parametrize(("aggregator_type", "brand_site"), sorted(BRAND_SITES.items()))
def test_brand_site_urls_match_the_client(aggregator_type, brand_site):
    assert AggregatorRegistry.get(aggregator_type).brand_site_url == brand_site


@pytest.mark.parametrize("aggregator_type", ["full_website", "feed_content", "podcast", "reddit", "youtube"])
def test_aggregators_without_a_fixed_brand_have_no_brand_site(aggregator_type):
    assert AggregatorRegistry.get(aggregator_type).brand_site_url is None


@pytest.mark.django_db
def test_api_image_wins_over_brand_favicon(user_with_settings):
    feed = Feed.objects.create(
        name="Swift", aggregator="reddit", identifier="swift", user=user_with_settings
    )

    with (
        patch(
            "core.aggregators.reddit.aggregator.fetch_subreddit_info",
            return_value={"iconUrl": "https://styles.redditmedia.com/swift.png"},
        ),
        patch("core.aggregators.feed_logo.resolve_site_icon") as resolve_icon,
    ):
        assert resolve_feed_logo_url(feed) == "https://styles.redditmedia.com/swift.png"
    resolve_icon.assert_not_called()


@pytest.mark.django_db
def test_brand_favicon_wins_over_identifier_favicon(user):
    feed = Feed.objects.create(
        name="Heise", aggregator="heise", identifier="https://www.heise.de/rss/heise.rdf", user=user
    )

    with patch(
        "core.aggregators.feed_logo.resolve_site_icon", return_value="https://www.heise.de/favicon.ico"
    ) as resolve_icon:
        assert resolve_feed_logo_url(feed) == "https://www.heise.de/favicon.ico"
    resolve_icon.assert_called_once_with("https://www.heise.de/")


@pytest.mark.django_db
def test_url_feed_without_a_brand_uses_the_identifier_origin(user):
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )

    with patch(
        "core.aggregators.feed_logo.resolve_site_icon", return_value="https://golem.de/favicon.ico"
    ) as resolve_icon:
        assert resolve_feed_logo_url(feed) == "https://golem.de/favicon.ico"
    resolve_icon.assert_called_once_with("https://golem.de/")


@pytest.mark.django_db
def test_unparseable_identifier_resolves_to_none(user):
    feed = Feed.objects.create(
        name="Broken", aggregator="full_website", identifier="not a url", user=user
    )

    with patch("core.aggregators.feed_logo.resolve_site_icon") as resolve_icon:
        assert resolve_feed_logo_url(feed) is None
    resolve_icon.assert_not_called()


@pytest.mark.django_db
def test_api_image_failure_falls_through_to_the_identifier_origin(user_with_settings):
    feed = Feed.objects.create(
        name="Swift", aggregator="reddit", identifier="swift", user=user_with_settings
    )

    with (
        patch(
            "core.aggregators.reddit.aggregator.fetch_subreddit_info",
            side_effect=ValueError("rate limited"),
        ),
        patch("core.aggregators.feed_logo.resolve_site_icon") as resolve_icon,
    ):
        assert resolve_feed_logo_url(feed) is None
    resolve_icon.assert_not_called()
```

The last case documents the intended behaviour: a subreddit identifier has no origin to fall back
to, so a failed API lookup means no logo rather than a bogus `https://swift/favicon.ico`.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest core/tests/test_feed_logo.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'core.aggregators.feed_logo'`

- [ ] **Step 3: Write minimal implementation**

In `core/aggregators/base.py`, add to `BaseAggregator` next to `resolves_feed_url()`:

```python
    # Fixed-brand scrapers point at their own site so the logo comes from the
    # brand's favicon rather than whichever feed URL the identifier happens to
    # be. None for free-form URL types (the identifier's origin is used) and for
    # reddit/youtube (their API provides an image).
    # Spec 2 adds the_verge -> https://www.theverge.com/ and
    # ars_technica -> https://arstechnica.com/ when those aggregators land.
    brand_site_url: Optional[str] = None

    def logo_image_url(self) -> Optional[str]:
        """API-provided logo image URL, when the source has one.

        Overridden by aggregators whose API exposes an avatar or icon (Reddit
        subreddit icon, YouTube channel avatar). Returning None means "fall
        through to the favicon tiers".
        """
        return None
```

Add one line to each fixed-brand scraper class body (values exactly as in the test's
`BRAND_SITES`), e.g. in `HeiseAggregator` next to `HEISE_URL`:

```python
    brand_site_url = "https://www.heise.de/"
```

In `core/aggregators/reddit/aggregator.py`, add to `RedditAggregator`:

```python
    def logo_image_url(self) -> Optional[str]:
        """Subreddit icon from the Reddit API."""
        user_id = getattr(getattr(self.feed, "user", None), "id", None)
        if not user_id or not self.identifier:
            return None
        info = fetch_subreddit_info(self.identifier, user_id)
        return info.get("iconUrl")
```

`fetch_subreddit_info` is already imported there (line ~32).

In `core/aggregators/youtube/aggregator.py`, add to `YouTubeAggregator`:

```python
    def logo_image_url(self) -> Optional[str]:
        """Channel avatar from the YouTube Data API."""
        channel_id = self.identifier
        if not channel_id:
            return None
        client = self._get_client()
        channels = client.fetch_channels_data([channel_id])
        return channels[0].get("channel_icon_url") if channels else None
```

`_get_client()` already exists on `YouTubeAggregator` (line ~141); it raises when YouTube is not
enabled or has no API key, which `resolve_feed_logo_url` catches and treats as "no API image".

Create `core/aggregators/feed_logo.py`:

```python
"""Per-feed logo resolution.

Mirrors the iOS client's ``FeedLogoResolver``: an API-provided image first, then
the brand site's favicon for fixed-brand scrapers, then the identifier's own
origin. Every tier is best-effort -- a failure means "no logo", never an error
raised into feed saving.
"""

import logging
from urllib.parse import urlparse

from .utils.favicon import resolve_site_icon

logger = logging.getLogger(__name__)


def _identifier_origin(identifier: str) -> str | None:
    """``scheme://host/`` for a URL identifier, or ``None`` for anything else."""
    parsed = urlparse(identifier or "")
    if not parsed.scheme or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}/"


def resolve_feed_logo_url(feed) -> str | None:
    """Best logo URL for ``feed``, or ``None`` when no tier yields one."""
    from . import get_aggregator

    try:
        aggregator = get_aggregator(feed)
    except Exception as exc:
        logger.debug(f"No aggregator for feed {feed.pk}: {exc}")
        return None

    try:
        api_image = aggregator.logo_image_url()
    except Exception as exc:
        logger.debug(f"API logo lookup failed for feed {feed.pk}: {exc}")
        api_image = None

    if api_image:
        return api_image

    brand_site = type(aggregator).brand_site_url
    if brand_site:
        return resolve_site_icon(brand_site)

    origin = _identifier_origin(feed.identifier)
    if not origin:
        return None

    return resolve_site_icon(origin)
```

Check how `core/aggregators/__init__.py` exposes `get_aggregator` and import it the way the rest of
the package does (`core/forms.py` uses `from .aggregators import get_aggregator`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest core/tests/test_feed_logo.py -v`
Expected: all passed

- [ ] **Step 5: Run the aggregator suites (every class gained an attribute)**

Run: `uv run pytest core/tests -k "aggregator" -q`
Expected: 0 failures

- [ ] **Step 6: Lint, format, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
git add core/aggregators/ core/tests/test_feed_logo.py
git commit -m "feat(aggregators): Resolve feed logos by API, brand site, then identifier"
```

---

## Task 10: Store the logo on save and add a refresh action

**Files:**
- Modify: `core/aggregators/utils/html_fetcher.py` (add `fetch_bytes`)
- Modify: `core/aggregators/feed_logo.py` (add `store_feed_logo`)
- Modify: `core/aggregators/utils/__init__.py`
- Modify: `core/forms.py` (`FeedAdminForm.save`)
- Modify: `core/admin.py` (`refresh_feed_logos` action)
- Test: `core/tests/test_feed_logo.py`, `core/tests/test_feed_admin_authoring.py`

**Interfaces:**
- Consumes: `resolve_feed_logo_url()` (Task 9), `remove_white_background()` (Task 7),
  `Feed.logo` / `Feed.logo_source_url` (Task 8).
- Produces: `fetch_bytes(url: str, timeout: int = 30) -> bytes`;
  `store_feed_logo(feed) -> bool` (True when a logo was stored); `FeedAdmin.refresh_feed_logos`.

- [ ] **Step 1: Write the failing test**

Append to `core/tests/test_feed_logo.py`:

```python
import io

from PIL import Image

from core.aggregators.feed_logo import store_feed_logo


def _white_backed_png() -> bytes:
    image = Image.new("RGB", (16, 16), (255, 255, 255))
    for x in range(4, 12):
        for y in range(4, 12):
            image.putpixel((x, y), (10, 10, 10))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.mark.django_db
def test_store_feed_logo_downloads_and_records_the_source(user):
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )
    png = _white_backed_png()

    with (
        patch(
            "core.aggregators.feed_logo.resolve_feed_logo_url",
            return_value="https://golem.de/favicon.png",
        ),
        patch("core.aggregators.feed_logo.fetch_bytes", return_value=png) as fetch,
    ):
        assert store_feed_logo(feed) is True

    fetch.assert_called_once_with("https://golem.de/favicon.png")
    feed.refresh_from_db()
    assert feed.logo
    assert feed.logo_source_url == "https://golem.de/favicon.png"
    feed.logo.delete(save=False)


@pytest.mark.django_db
def test_store_feed_logo_strips_a_white_background(user):
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )

    with (
        patch(
            "core.aggregators.feed_logo.resolve_feed_logo_url",
            return_value="https://golem.de/favicon.png",
        ),
        patch("core.aggregators.feed_logo.fetch_bytes", return_value=_white_backed_png()),
    ):
        store_feed_logo(feed)

    feed.refresh_from_db()
    with feed.logo.open("rb") as stored:
        image = Image.open(io.BytesIO(stored.read())).convert("RGBA")
    assert image.getpixel((0, 0))[3] == 0
    feed.logo.delete(save=False)


@pytest.mark.django_db
def test_store_feed_logo_keeps_the_feed_saveable_when_the_download_fails(user):
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )

    with (
        patch(
            "core.aggregators.feed_logo.resolve_feed_logo_url",
            return_value="https://golem.de/favicon.png",
        ),
        patch("core.aggregators.feed_logo.fetch_bytes", side_effect=OSError("dead")),
    ):
        assert store_feed_logo(feed) is False

    feed.refresh_from_db()
    assert not feed.logo


@pytest.mark.django_db
def test_store_feed_logo_is_a_noop_when_nothing_resolves(user):
    feed = Feed.objects.create(
        name="Broken", aggregator="full_website", identifier="not a url", user=user
    )

    with patch("core.aggregators.feed_logo.resolve_feed_logo_url", return_value=None):
        assert store_feed_logo(feed) is False

    assert not feed.logo
```

Append to `core/tests/test_feed_admin_authoring.py`:

```python
@pytest.mark.django_db
def test_form_save_resolves_the_logo_when_the_identifier_changed():
    with (
        patch("core.forms.resolve_feed_url", return_value="https://golem.de/rss.php"),
        patch("core.forms.store_feed_logo", return_value=True) as store,
    ):
        form = FeedAdminForm(data=_form_data())
        assert form.is_valid(), form.errors
        feed = form.save()

    store.assert_called_once_with(feed)


@pytest.mark.django_db
def test_form_save_survives_a_logo_failure(user):
    with (
        patch("core.forms.resolve_feed_url", return_value="https://golem.de/rss.php"),
        patch("core.forms.store_feed_logo", side_effect=OSError("dead")),
    ):
        form = FeedAdminForm(data=_form_data())
        assert form.is_valid(), form.errors
        feed = form.save()

    assert feed.pk is not None


@pytest.mark.django_db
def test_refresh_logo_action_reports_per_feed(rf, user):
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )
    admin_instance = FeedAdmin(Feed, None)
    request = rf.post("/admin/core/feed/")
    request.user = user
    messages = []

    with (
        patch("core.admin.store_feed_logo", return_value=True),
        patch.object(FeedAdmin, "message_user", lambda self, req, msg, *a, **kw: messages.append(msg)),
    ):
        admin_instance.refresh_feed_logos(request, Feed.objects.filter(pk=feed.pk))

    assert any("Golem" in message for message in messages)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest core/tests/test_feed_logo.py core/tests/test_feed_admin_authoring.py -v`
Expected: FAIL — `ImportError: cannot import name 'store_feed_logo'`

- [ ] **Step 3: Write minimal implementation**

Add to `core/aggregators/utils/html_fetcher.py`, reusing the module's `USER_AGENT`:

```python
def fetch_bytes(url: str, timeout: int = 30) -> bytes:
    """Fetch raw bytes from ``url`` (images, icons).

    Raises:
        requests.RequestException: If the request fails.
    """
    response = requests.get(
        url, headers={"User-Agent": USER_AGENT}, timeout=timeout, allow_redirects=True
    )
    response.raise_for_status()
    return response.content
```

Export it from `core/aggregators/utils/__init__.py`.

Add to `core/aggregators/feed_logo.py`:

```python
import os

from django.core.files.base import ContentFile

from .utils.html_fetcher import fetch_bytes
from .utils.logo_background import remove_white_background


def _logo_filename(feed, source_url: str, is_png: bool) -> str:
    if is_png:
        return f"feed-{feed.pk}.png"
    extension = os.path.splitext(urlparse(source_url).path)[1].lower()
    if extension not in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"):
        extension = ".png"
    return f"feed-{feed.pk}{extension}"


def store_feed_logo(feed) -> bool:
    """Resolve, download, and store ``feed.logo``. Returns True when one was stored.

    Never raises: a dead favicon URL must not prevent saving a feed. Failures are
    logged and leave ``logo`` as it was.
    """
    try:
        source_url = resolve_feed_logo_url(feed)
    except Exception as exc:
        logger.warning(f"Logo resolution failed for feed {feed.pk}: {exc}")
        return False

    if not source_url:
        logger.debug(f"No logo resolved for feed {feed.pk}")
        return False

    try:
        data = fetch_bytes(source_url)
    except Exception as exc:
        logger.warning(f"Logo download failed for feed {feed.pk} ({source_url}): {exc}")
        return False

    stripped = remove_white_background(data)
    payload = stripped or data

    try:
        feed.logo.save(
            _logo_filename(feed, source_url, is_png=stripped is not None),
            ContentFile(payload),
            save=False,
        )
        feed.logo_source_url = source_url
        feed.save(update_fields=["logo", "logo_source_url", "updated_at"])
    except Exception as exc:
        logger.warning(f"Storing the logo failed for feed {feed.pk}: {exc}")
        return False

    return True
```

In `core/forms.py`, import `store_feed_logo` and call it at the end of
`FeedAdminForm.save()`, replacing the current `return instance`:

```python
        if commit:
            instance.save()
            self.save_m2m()
            self._refresh_logo_if_needed(instance)

        return instance

    def _refresh_logo_if_needed(self, instance) -> None:
        """Resolve the logo when the identifier or aggregator changed, or none is set.

        Best-effort: a failure here must never surface as a save error.
        """
        needs_logo = (
            "identifier" in self.changed_data or "aggregator" in self.changed_data or not instance.logo
        )
        if not needs_logo:
            return

        try:
            store_feed_logo(instance)
        except Exception:
            logger.exception(f"Logo resolution failed for feed {instance.pk}")
```

Add `import logging` and `logger = logging.getLogger(__name__)` at the top of `core/forms.py` if
they are not already there.

In `core/admin.py`, import `store_feed_logo`, add `"refresh_feed_logos"` to `FeedAdmin.actions`,
and add:

```python
    @admin.action(description="Refresh feed logo")
    def refresh_feed_logos(self, request, queryset):
        """Re-resolve and re-download the logo for the selected feeds."""
        for feed in queryset:
            try:
                stored = store_feed_logo(feed)
            except Exception as exc:
                self.message_user(request, f"{feed.name}: logo failed -- {exc}", messages.ERROR)
                continue

            if stored:
                self.message_user(
                    request, f"{feed.name}: logo from {feed.logo_source_url}", messages.SUCCESS
                )
            else:
                self.message_user(request, f"{feed.name}: no logo resolved", messages.WARNING)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest core/tests/test_feed_logo.py core/tests/test_feed_admin_authoring.py -v`
Expected: all passed

- [ ] **Step 5: Confirm no test wrote into the real media root**

Run: `git status --short media 2>/dev/null; ls media/feed_logos 2>/dev/null`
Expected: no tracked changes. The tests delete what they store; if stray files appear, add a
`settings.MEDIA_ROOT` override via `tmp_path` in the test instead of leaving them behind.

- [ ] **Step 6: Lint, format, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
git add core/aggregators/ core/forms.py core/admin.py core/tests/test_feed_logo.py \
  core/tests/test_feed_admin_authoring.py
git commit -m "feat(aggregators): Download and store resolved feed logos"
```

---

## Task 11: AI selector suggestion service

**Files:**
- Create: `core/services/selector_suggester.py`
- Test: `core/tests/test_selector_suggester.py`

**Interfaces:**
- Consumes: `AIClient(user_settings).generate_response(prompt, json_mode=True, json_schema=...)
  -> str | None` (returns `None` on any provider failure); `fetch_html()`; `parse_rss_feed()`;
  `UserSettings.active_ai_provider`; the `content_selectors` / `ignore_selectors` keys in
  `Feed.options` (Spec 1).
- Produces:
  - `SelectorSuggestionError(Exception)`
  - `has_ai_provider(user) -> bool`
  - `html_digest_for_selectors(html: str, max_chars: int = 40000) -> str`
  - `suggest_selectors(feed, kind: Literal["content", "ignore"]) -> list[str]` (raises
    `SelectorSuggestionError`)
  - `apply_suggested_selectors(feed, kind) -> tuple[list[str], list[str]]` returning
    `(previous, new)` after writing `Feed.options` — Task 12 calls this and `has_ai_provider`.

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_selector_suggester.py`:

```python
"""Tests for AI selector suggestion."""

import json
from unittest.mock import MagicMock, patch

import pytest

from core.models import Article, Feed, UserSettings
from core.services.selector_suggester import (
    SelectorSuggestionError,
    apply_suggested_selectors,
    has_ai_provider,
    html_digest_for_selectors,
    suggest_selectors,
)

PAGE = """
<html><head><title>t</title><style>.a{color:red}</style></head>
<body><nav>menu</nav><article class="article-body"><p>Long prose here.</p></article>
<script>var x = 1;</script></body></html>
"""


@pytest.fixture
def ai_feed(user):
    UserSettings.objects.create(user=user, active_ai_provider="openai", openai_enabled=True)
    feed = Feed.objects.create(
        name="Golem",
        aggregator="full_website",
        identifier="https://golem.de/rss.php",
        user=user,
        options={"content_selectors": ["article"], "ignore_selectors": [".ad"]},
    )
    Article.objects.create(
        name="A", identifier="https://golem.de/a", raw_content="", content="", feed=feed
    )
    return feed


def _ai_response(*selectors: str) -> str:
    return json.dumps({"selectors": list(selectors)})


def test_digest_drops_scripts_and_styles_but_keeps_structure():
    digest = html_digest_for_selectors(PAGE)

    assert "var x = 1" not in digest
    assert "color:red" not in digest
    assert 'class="article-body"' in digest


def test_digest_truncates_long_text_nodes():
    html = "<article><p>" + ("word " * 200) + "</p></article>"
    digest = html_digest_for_selectors(html)

    assert "<article>" in digest
    assert len(digest) < len(html)


def test_digest_respects_the_character_cap():
    html = "<div>" + "<p class='x'>text</p>" * 5000 + "</div>"
    assert len(html_digest_for_selectors(html, max_chars=500)) <= 500


@pytest.mark.django_db
def test_valid_json_is_decoded(ai_feed):
    client = MagicMock()
    client.generate_response.return_value = _ai_response("div.article-body", "figure")

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
    ):
        assert suggest_selectors(ai_feed, "content") == ["div.article-body", "figure"]


@pytest.mark.django_db
def test_current_entries_are_offered_as_candidates(ai_feed):
    client = MagicMock()
    client.generate_response.return_value = _ai_response("article")

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
    ):
        suggest_selectors(ai_feed, "ignore")

    prompt = client.generate_response.call_args.args[0]
    assert ".ad" in prompt


@pytest.mark.django_db
def test_malformed_json_raises(ai_feed):
    client = MagicMock()
    client.generate_response.return_value = "sorry, no JSON here"

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
        pytest.raises(SelectorSuggestionError),
    ):
        suggest_selectors(ai_feed, "content")


@pytest.mark.django_db
def test_empty_selector_list_raises(ai_feed):
    client = MagicMock()
    client.generate_response.return_value = _ai_response()

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
        pytest.raises(SelectorSuggestionError),
    ):
        suggest_selectors(ai_feed, "content")


@pytest.mark.django_db
def test_provider_failure_raises(ai_feed):
    client = MagicMock()
    client.generate_response.return_value = None

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
        pytest.raises(SelectorSuggestionError),
    ):
        suggest_selectors(ai_feed, "content")


@pytest.mark.django_db
def test_unknown_kind_raises(ai_feed):
    with pytest.raises(ValueError):
        suggest_selectors(ai_feed, "nonsense")


@pytest.mark.django_db
def test_apply_overwrites_only_the_requested_list(ai_feed):
    client = MagicMock()
    client.generate_response.return_value = _ai_response("aside", ".newsletter")

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
    ):
        previous, new = apply_suggested_selectors(ai_feed, "ignore")

    ai_feed.refresh_from_db()
    assert previous == [".ad"]
    assert new == ["aside", ".newsletter"]
    assert ai_feed.options["ignore_selectors"] == ["aside", ".newsletter"]
    assert ai_feed.options["content_selectors"] == ["article"]


@pytest.mark.django_db
def test_apply_leaves_options_untouched_on_failure(ai_feed):
    client = MagicMock()
    client.generate_response.return_value = "not json"

    with (
        patch("core.services.selector_suggester.AIClient", return_value=client),
        patch("core.services.selector_suggester.fetch_html", return_value=PAGE),
        pytest.raises(SelectorSuggestionError),
    ):
        apply_suggested_selectors(ai_feed, "content")

    ai_feed.refresh_from_db()
    assert ai_feed.options["content_selectors"] == ["article"]


@pytest.mark.django_db
def test_has_ai_provider_reflects_settings(ai_feed, user):
    assert has_ai_provider(user) is True

    settings_row = UserSettings.objects.get(user=user)
    settings_row.active_ai_provider = ""
    settings_row.save()
    assert has_ai_provider(user) is False


@pytest.mark.django_db
def test_has_ai_provider_is_false_without_settings(user):
    assert has_ai_provider(user) is False


@pytest.mark.django_db
def test_missing_page_url_raises(user):
    UserSettings.objects.create(user=user, active_ai_provider="openai", openai_enabled=True)
    feed = Feed.objects.create(
        name="Empty", aggregator="full_website", identifier="not a url", user=user
    )

    with (
        patch("core.services.selector_suggester.AIClient"),
        patch(
            "core.services.selector_suggester.parse_rss_feed",
            side_effect=ValueError("Invalid feed URL"),
        ),
        pytest.raises(SelectorSuggestionError),
    ):
        suggest_selectors(feed, "content")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest core/tests/test_selector_suggester.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'core.services.selector_suggester'`

- [ ] **Step 3: Write minimal implementation**

Create `core/services/selector_suggester.py`:

```python
"""AI-assisted CSS selector suggestion for a feed.

Mirrors the iOS client's ``SelectorSuggester``: fetch one article page, show the
model a size-capped digest of its markup plus the list currently configured, and
take back a replacement for exactly one of ``content_selectors`` /
``ignore_selectors``.

The digest keeps markup rather than plain text -- a selector cannot be named from
prose -- but applies the same "strip chrome, cap length" idea: script/style/
noscript/svg and comments go, every text node is truncated, and the whole thing
is capped.
"""

import json
import logging
import re
from typing import Any, Literal

from bs4 import BeautifulSoup, Comment

from core.ai_client import AIClient
from core.aggregators.utils import fetch_html, parse_rss_feed
from core.models import UserSettings

logger = logging.getLogger(__name__)

SelectorKind = Literal["content", "ignore"]

OPTION_KEYS: dict[str, str] = {
    "content": "content_selectors",
    "ignore": "ignore_selectors",
}

KIND_INSTRUCTIONS: dict[str, str] = {
    "content": (
        "Return CSS selectors that match the container(s) holding the main article body. "
        "Prefer one stable selector; add more only when the body is genuinely split across "
        "containers."
    ),
    "ignore": (
        "Return CSS selectors for noise that should be stripped from the article body: ads, "
        "share bars, newsletter boxes, related-article teasers, comment sections, cookie banners."
    ),
}

CHROME_TAGS = ("script", "style", "noscript", "svg", "template")
MAX_TEXT_NODE_CHARS = 80
MAX_DIGEST_CHARS = 40000

JSON_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {"selectors": {"type": "ARRAY", "items": {"type": "STRING"}}},
    "required": ["selectors"],
}


class SelectorSuggestionError(Exception):
    """A suggestion could not be produced. The existing list must stay untouched."""


def has_ai_provider(user: Any) -> bool:
    """Whether ``user`` has an AI provider configured."""
    if user is None:
        return False
    try:
        settings_row = UserSettings.objects.get(user=user)
    except UserSettings.DoesNotExist:
        return False
    return bool(settings_row.active_ai_provider)


def html_digest_for_selectors(html: str, max_chars: int = MAX_DIGEST_CHARS) -> str:
    """Structure-preserving, size-capped digest of ``html`` for prompting."""
    soup = BeautifulSoup(html or "", "html.parser")

    for tag in soup(list(CHROME_TAGS)):
        tag.decompose()

    for comment in soup.find_all(string=lambda text: isinstance(text, Comment)):
        comment.extract()

    for text_node in soup.find_all(string=True):
        collapsed = re.sub(r"\s+", " ", str(text_node)).strip()
        if len(collapsed) > MAX_TEXT_NODE_CHARS:
            collapsed = collapsed[:MAX_TEXT_NODE_CHARS] + "…"
        text_node.replace_with(collapsed)

    return str(soup)[:max_chars]


def _page_url(feed: Any) -> str:
    """URL of an article page to learn selectors from."""
    article = feed.articles.order_by("-created_at").first()
    if article and article.identifier:
        return str(article.identifier)

    try:
        data = parse_rss_feed(feed.identifier)
    except Exception as exc:
        raise SelectorSuggestionError(f"No article page to inspect: {exc}") from exc

    for entry in data.get("entries", []):
        link = entry.get("link")
        if link:
            return str(link)

    raise SelectorSuggestionError("No article page to inspect: the feed has no entries")


def _current_selectors(feed: Any, kind: SelectorKind) -> list[str]:
    options = feed.options or {}
    value = options.get(OPTION_KEYS[kind]) or []
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value]
    return [part.strip() for part in str(value).split(",") if part.strip()]


def _decode_selectors(raw: str) -> list[str]:
    """Decode ``{"selectors": [...]}``, tolerating a fenced or wrapped response."""
    candidates = [raw]
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if fenced:
        candidates.append(fenced.group(1))
    start, end = raw.find("{"), raw.rfind("}")
    if start != -1 and end > start:
        candidates.append(raw[start : end + 1])

    for candidate in candidates:
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        selectors = payload.get("selectors") if isinstance(payload, dict) else None
        if isinstance(selectors, list):
            return [str(item).strip() for item in selectors if str(item).strip()]

    raise SelectorSuggestionError("The AI response was not decodable JSON")


def suggest_selectors(feed: Any, kind: SelectorKind) -> list[str]:
    """Suggest the ``kind`` selector list for ``feed``.

    Raises:
        ValueError: If ``kind`` is not "content" or "ignore".
        SelectorSuggestionError: On any fetch, provider, or decode failure. The
            caller must leave the existing list untouched.
    """
    if kind not in OPTION_KEYS:
        raise ValueError(f"Unknown selector kind: {kind}")

    try:
        settings_row = UserSettings.objects.get(user=feed.user)
    except UserSettings.DoesNotExist as exc:
        raise SelectorSuggestionError("No AI provider is configured") from exc

    if not settings_row.active_ai_provider:
        raise SelectorSuggestionError("No AI provider is configured")

    url = _page_url(feed)
    try:
        html = fetch_html(url)
    except Exception as exc:
        raise SelectorSuggestionError(f"Could not fetch {url}: {exc}") from exc

    current = _current_selectors(feed, kind)
    prompt = "\n".join(
        [
            "You suggest CSS selectors for a web scraper. Answer with JSON only: "
            '{"selectors": ["...", "..."]}. No prose, no markdown fences.',
            KIND_INSTRUCTIONS[kind],
            "These selectors are currently configured. Keep the ones still appropriate for "
            f"this page and drop the stale ones: {json.dumps(current)}",
            f"Page URL: {url}",
            "Page markup (truncated):",
            html_digest_for_selectors(html),
        ]
    )

    response = AIClient(settings_row).generate_response(
        prompt, json_mode=True, json_schema=JSON_SCHEMA
    )
    if not response:
        raise SelectorSuggestionError("The AI provider returned no response")

    selectors = _decode_selectors(response)
    if not selectors:
        raise SelectorSuggestionError("The AI provider suggested no selectors")

    return selectors


def apply_suggested_selectors(feed: Any, kind: SelectorKind) -> tuple[list[str], list[str]]:
    """Write a suggestion into ``feed.options``, overwriting only that list.

    Returns:
        ``(previous, new)`` selector lists.

    Raises:
        SelectorSuggestionError: On failure -- ``feed.options`` is left untouched.
    """
    previous = _current_selectors(feed, kind)
    new = suggest_selectors(feed, kind)

    options = dict(feed.options or {})
    options[OPTION_KEYS[kind]] = new
    feed.options = options
    feed.save(update_fields=["options", "updated_at"])

    logger.info(f"Feed {feed.pk}: {OPTION_KEYS[kind]} {previous} -> {new}")
    return previous, new
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest core/tests/test_selector_suggester.py -v`
Expected: all passed

- [ ] **Step 5: Lint, format, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
git add core/services/selector_suggester.py core/tests/test_selector_suggester.py
git commit -m "feat(services): Suggest feed selectors with the configured AI provider"
```

---

## Task 12: Suggest actions in admin, hidden without a provider

**Files:**
- Modify: `core/admin.py` (`FeedAdmin.actions`, two new actions, `get_actions`)
- Test: `core/tests/test_feed_admin_authoring.py`

**Interfaces:**
- Consumes: `apply_suggested_selectors()`, `has_ai_provider()`, `SelectorSuggestionError`
  (Task 11).
- Produces: `FeedAdmin.suggest_content_selectors`, `FeedAdmin.suggest_ignore_selectors`,
  `FeedAdmin.get_actions()` gating.

- [ ] **Step 1: Write the failing test**

Append to `core/tests/test_feed_admin_authoring.py`:

```python
from core.models import UserSettings
from core.services.selector_suggester import SelectorSuggestionError

SUGGEST_ACTIONS = ("suggest_content_selectors", "suggest_ignore_selectors")


@pytest.mark.django_db
def test_suggest_actions_are_hidden_without_an_ai_provider(rf, user):
    admin_instance = FeedAdmin(Feed, None)
    request = rf.get("/admin/core/feed/")
    request.user = user

    actions = admin_instance.get_actions(request)

    assert all(name not in actions for name in SUGGEST_ACTIONS)


@pytest.mark.django_db
def test_suggest_actions_are_available_with_an_ai_provider(rf, user):
    UserSettings.objects.create(user=user, active_ai_provider="openai", openai_enabled=True)
    admin_instance = FeedAdmin(Feed, None)
    request = rf.get("/admin/core/feed/")
    request.user = user

    actions = admin_instance.get_actions(request)

    assert all(name in actions for name in SUGGEST_ACTIONS)


@pytest.mark.django_db
def test_suggest_ignore_action_reports_the_change(rf, user):
    feed = Feed.objects.create(
        name="Golem", aggregator="full_website", identifier="https://golem.de/rss.php", user=user
    )
    admin_instance = FeedAdmin(Feed, None)
    request = rf.post("/admin/core/feed/")
    request.user = user
    messages = []

    with (
        patch(
            "core.admin.apply_suggested_selectors", return_value=([".ad"], ["aside"])
        ) as apply_suggestion,
        patch.object(FeedAdmin, "message_user", lambda self, req, msg, *a, **kw: messages.append(msg)),
    ):
        admin_instance.suggest_ignore_selectors(request, Feed.objects.filter(pk=feed.pk))

    assert apply_suggestion.call_args.args[1] == "ignore"
    assert any("aside" in message for message in messages)


@pytest.mark.django_db
def test_suggest_action_reports_a_failure_without_touching_options(rf, user):
    feed = Feed.objects.create(
        name="Golem",
        aggregator="full_website",
        identifier="https://golem.de/rss.php",
        user=user,
        options={"content_selectors": ["article"]},
    )
    admin_instance = FeedAdmin(Feed, None)
    request = rf.post("/admin/core/feed/")
    request.user = user
    messages = []

    with (
        patch(
            "core.admin.apply_suggested_selectors",
            side_effect=SelectorSuggestionError("provider down"),
        ),
        patch.object(FeedAdmin, "message_user", lambda self, req, msg, *a, **kw: messages.append(msg)),
    ):
        admin_instance.suggest_content_selectors(request, Feed.objects.filter(pk=feed.pk))

    feed.refresh_from_db()
    assert feed.options["content_selectors"] == ["article"]
    assert any("provider down" in message for message in messages)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest core/tests/test_feed_admin_authoring.py -k suggest -v`
Expected: FAIL — `AttributeError: 'FeedAdmin' object has no attribute 'suggest_ignore_selectors'`

- [ ] **Step 3: Write minimal implementation**

In `core/admin.py`, import:

```python
from .services.selector_suggester import (
    SelectorSuggestionError,
    apply_suggested_selectors,
    has_ai_provider,
)
```

Add both names to `FeedAdmin.actions`, then add:

```python
    SUGGEST_ACTIONS = ("suggest_content_selectors", "suggest_ignore_selectors")

    def get_actions(self, request):
        """Hide the AI suggest actions entirely when no provider is configured.

        Hidden rather than disabled, matching the iOS client.
        """
        actions = super().get_actions(request)
        if not has_ai_provider(getattr(request, "user", None)):
            for name in self.SUGGEST_ACTIONS:
                actions.pop(name, None)
        return actions

    def _suggest_selectors(self, request, queryset, kind):
        for feed in queryset:
            try:
                previous, new = apply_suggested_selectors(feed, kind)
            except SelectorSuggestionError as exc:
                self.message_user(request, f"{feed.name}: {exc}", messages.ERROR)
                continue

            self.message_user(
                request, f"{feed.name}: {kind} selectors {previous} -> {new}", messages.SUCCESS
            )

    @admin.action(description="Suggest content selectors")
    def suggest_content_selectors(self, request, queryset):
        """Ask the configured AI provider for content selectors."""
        self._suggest_selectors(request, queryset, "content")

    @admin.action(description="Suggest ignore selectors")
    def suggest_ignore_selectors(self, request, queryset):
        """Ask the configured AI provider for ignore selectors."""
        self._suggest_selectors(request, queryset, "ignore")
```

If `FeedAdmin` already overrides `get_actions`, extend that override instead of adding a second one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest core/tests/test_feed_admin_authoring.py -v`
Expected: all passed

- [ ] **Step 5: Lint, format, commit**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
git add core/admin.py core/tests/test_feed_admin_authoring.py
git commit -m "feat(admin): Add AI selector suggestion actions, hidden without a provider"
```

---

## Task 13: Docs and end-to-end verification

**Files:**
- Modify: `CLAUDE.md` (project structure entries for the new modules; Key Models row for `Feed`)
- Modify: `core/aggregators/README.md` (feed authoring section: discovery, resolution, logos)
- Modify: `README.md` (user-facing note on pasting a homepage URL and on feed logos)
- Test: whole suite

- [ ] **Step 1: Document the new modules**

In `CLAUDE.md`, add to the `core/aggregators/utils/` tree block:

```
│       │   ├── feed_discovery.py     # <link rel=alternate> feed discovery
│       │   ├── feed_url_resolver.py  # normalize + resolve pasted URLs
│       │   ├── favicon.py            # site icon selection
│       │   └── logo_background.py    # white-background removal (Pillow)
```

Add `feed_logo.py` under `core/aggregators/` and `selector_suggester.py` under `core/services/` in
the same tree. In the **Key Models** table, extend the `Feed` row's fields with
`logo, logo_source_url`.

- [ ] **Step 2: Document the behaviour**

In `core/aggregators/README.md`, add a "Feed authoring" section covering:
- pasting `golem.de` resolves to the advertised feed on save, and which aggregators do that
  (`resolves_feed_url()` — free-form URL types only);
- the RSS pipeline's discovery fallback, and that discovery is not cached;
- the three logo tiers (`logo_image_url()` → `brand_site_url` favicon → identifier origin) and that
  only the site's own domain is ever contacted;
- the two admin suggest actions and that they are hidden without an AI provider.

In `README.md`, add short user-facing notes: a homepage URL is enough when adding a feed, feeds get
a logo automatically, and the **Resolve & test** / **Refresh feed logo** admin actions exist.

- [ ] **Step 3: Full verification**

```bash
uv run ruff check . --fix && uv run ruff format . && uv run mypy . && uv run pytest
```

Expected: 0 lint errors, 0 mypy errors, all tests pass (434 baseline + roughly 80 new).

- [ ] **Step 4: Confirm no migration drift**

Run: `uv run python manage.py makemigrations --check --dry-run`
Expected: "No changes detected"

- [ ] **Step 5: Manual admin verification (needs network; do not automate)**

Report each result in the task summary:
1. Create a `full_website` feed with identifier `golem.de`, save, confirm the stored identifier
   became an absolute feed URL.
2. Run **Resolve & test** on it; confirm a plausible entry count.
3. Confirm `logo` populated, and that a Heise feed picked up the Heise favicon rather than a
   feed-URL favicon.
4. With an AI provider configured, run **Suggest ignore selectors**; confirm
   `options["ignore_selectors"]` changed and `content_selectors` did not.
5. With no AI provider configured, confirm both suggest actions are absent from the action list.

If the environment has no network or no AI credentials, say so explicitly instead of reporting
these as passed.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md core/aggregators/README.md
git commit -m "docs(aggregators): Document feed discovery, resolution, and logos"
```

---

## Spec coverage map

| Spec section | Task |
|---|---|
| 1. Feed discovery — `feed_url_in_html`, `discover_feed_url`, RSS preference, relative hrefs, empty href | 2 |
| 1. Wiring into the RSS entry fetch, no caching | 4 |
| 2. URL normalization — `normalize` | 1 |
| 2. `resolve_feed_url`, never raises | 3 |
| 2. Which aggregators resolve (`resolves_feed_url`) | 3 |
| 2. Admin integration — resolve on save, "Resolve & test" | 5 |
| 3a. Favicon resolution, apple-touch-icon priority, `/favicon.ico`, own domain only | 6 |
| 3b. White-background removal, 240 / 0.85, flood fill, `None` when not white-backed | 7 |
| 3c. Priority resolution — `logo_image_url`, `brand_site_url` table, identifier origin | 9 |
| 3d. Storage — `logo`, `logo_source_url`, resolve on change, refresh action | 8, 10 |
| 4. AI selector suggestion — digest, one kind, candidates, overwrite one list | 11 |
| 4. Admin integration — two actions, hidden without a provider | 12 |
| Error handling — degrade everywhere | 2, 3, 6, 7, 9, 10, 11 |
| Testing — every listed case | 1–12 |
| Verification via admin | 13 |
