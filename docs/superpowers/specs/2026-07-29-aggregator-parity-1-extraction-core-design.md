# Spec 1: Aggregator Parity — Extraction Core & Semantics

> **Superseded by the Next.js migration (2026-07-30).** The Django implementation
> described here now lives in `old/`, read-only — paths like `core/…` are `old/core/…`
> today. This document is kept as a record of decisions that were correct when made,
> and its behavior descriptions remain the reference for porting them to TypeScript.
> See [the Next.js direction record](2026-07-30-nextjs-migration-direction.md).

**Date:** 2026-07-29
**Status:** Approved design, pending spec review
**Depends on:** Spec 0 (GReader removal)
**Direction:** `2026-07-29-client-server-remigration-direction.md`

## Goal

Bring the server's shared extraction code up to what iOS ships. Everything here lives in base
classes and shared utilities that all 14 aggregators inherit, so it lands **before** the
per-scraper fixes in Spec 2 — otherwise those fixes get written twice, against old extraction and
then against new.

Four changes:

1. Content/ignore selectors become **lists**, unioned rather than first-match-only.
2. `use_full_content` is removed, and feeds using it are converted to the right aggregator type.
3. `<template>` elements are stripped before extraction.
4. Article publish dates stop being overwritten.

## 1. Selector lists

### Current behavior

`extract_main_content(html, selector, remove_selectors)`
([content_extractor.py:8](../../../core/aggregators/utils/content_extractor.py:8)) calls
`soup.select_one(selector)` — a single element. `selector` is a CSS comma-group string, so
soupsieve returns the **first** match in document order across the whole group. Options carry
`custom_content_selector` (one string) and `custom_selectors_to_remove` (a comma-joined string,
split in [website.py:123](../../../core/aggregators/website.py:123)).

That truncates any article whose body is split across sibling containers.

### Target behavior

```python
def extract_main_content(
    html: str,
    content_selectors: list[str],
    remove_selectors: list[str] | None = None,
) -> str:
```

- Collect `soup.select(sel)` for every entry in `content_selectors`, in **document order**.
- **Drop any match contained within another match** — outermost wins. Without this, a page where
  both `main` and `main > article` match would duplicate the body.
- Deduplicate identical elements matched by more than one selector.
- Concatenate the surviving elements into one container.
- Apply every `remove_selectors` entry to that container (OR — remove all matches of all).
- Fall back to `<body>` when nothing matches, unchanged from today.

Ordering note: matches are emitted in document order, not selector order. A selector list is a set
of *places to look*, not a layout instruction.

### Two escape hatches the union needs

The OR-union is right for generic pages and **wrong** for scrapers with a dedicated article
container. iOS discovered both cases in production; the server needs the same two hooks, and they
belong here rather than in Spec 2 because they are shared contracts that Spec 2's fixes consume.

**(a) First-match opt-out.** Heise pages carry many sibling `<article>` teaser cards plus a
page-chrome `.article-content`. A union of the default selectors pulls related-story teasers and
site navigation into the body (iOS commit `9a87cca`, "Heise reader showing site navigation instead
of article body"). Scrapers whose content lives in one known container opt out:

```python
class BaseAggregator:
    uses_first_content_match = False   # subclasses with a dedicated container set True
```

When `True`, extraction keeps only the first match in document order — today's behavior.

**(b) No-match must be distinguishable from empty.** Falling back to `<body>` when the dedicated
container is missing is actively harmful: a paywall or gate page whose DOM differs would surface the
whole site navigation *as the article*. Add a variant that reports the miss instead:

```python
def extract_main_content_if_present(
    html: str,
    content_selectors: list[str],
    remove_selectors: list[str] | None = None,
    first_match_only: bool = False,
) -> str | None:      # None when nothing matched — no <body> fallback
```

`extract_main_content` keeps its `<body>` fallback for generic use; scrapers with a dedicated
container call the `_if_present` variant and fall back to **RSS summary content** on `None`.

**(c) Generic fallback with a text-length floor.** Tagesschau's regional feeds syndicate items
linking to external ARD broadcaster pages (mdr.de, ndr.de) whose templates carry none of
tagesschau.de's markup, producing empty articles (iOS commit `84ef715`). Rather than degrade those
to an RSS teaser, a scraper can fall back to *generic* extraction:

```python
def generic_content_if_present(self, raw_html: str, article: dict) -> str | None:
```

It runs the default content selectors over the already-fetched HTML and **requires ≥ 80 characters
of real text**, so a container holding only a byline or breadcrumb doesn't beat the RSS fallback.
Returns `None` otherwise. The 80-char floor is iOS's shipped value; keep it identical so both
implementations agree while they coexist.

Resolution order for a scraper with a dedicated container becomes:

```
dedicated container → generic extraction (≥80 chars) → RSS summary
```

### Options schema

| Old key | New key | Type change |
|---|---|---|
| `custom_content_selector` | `content_selectors` | `str` → `list[str]` |
| `custom_selectors_to_remove` | `ignore_selectors` | comma-joined `str` → `list[str]` |

Defaults are taken from iOS's **shipped code**, not its design doc — the doc lists 3 ignore
entries, the implementation has 8
(`../yana-ios/Yana/Models/AggregatorOptions.swift`):

```python
DEFAULT_CONTENT_SELECTORS = ["article", ".article-content", ".entry-content", "main"]
DEFAULT_IGNORE_SELECTORS = [
    ".advertisement", ".ad", ".ads", "[class*='advert']", "[class*='sponsor']",
    ".social-share", ".newsletter", ".related-articles",
]
```

The mandatory sanitization removals (`script`, `style`, `noscript`, non-YouTube `iframe`, and
`template` — see §3) stay hardcoded in the aggregator and always apply, regardless of
`ignore_selectors`. A user emptying the ignore list must not be able to disable sanitization.

### Data migration

A Django data migration over every `Feed` whose `options` contains either legacy key:

- `custom_content_selector`: non-empty → `content_selectors = [<comma-split, stripped, non-empty>]`.
  Absent or empty → `content_selectors` omitted so the code default applies.
- `custom_selectors_to_remove`: comma-split the same way into `ignore_selectors`.
- Remove both legacy keys after conversion.

Distinguish three cases explicitly, matching iOS's decode logic: **key present** → use it, even if
it converts to `[]` (the user deliberately cleared it); **key absent but legacy set** → seed from
legacy; **neither** → apply defaults. Writing `[]` and "use defaults" must not be conflated.

The migration needs a reverse operation (`ignore_selectors` → comma-joined string) so the migration
is reversible; it is lossy only in that list order is preserved but the distinction between an
explicitly-empty list and an absent key collapses on the way back.

## 2. Remove `use_full_content`

iOS deleted this toggle ([commit `87e5d99`](https://github.com/fa-krug/yana)) for a good reason:
`full_website` with `use_full_content: false` fetches no article pages and renders feed summaries —
which is exactly what the `feed_content` aggregator is for. Two ways to express one behavior, one of
them badly named.

The server currently checks it in
[website.py:68](../../../core/aggregators/website.py:68) and returns RSS articles unenriched.

**Change:** delete the option and the branch. `FullWebsiteAggregator` always fetches full content.

**Migration consequence — this is the part that must not be missed.** Feeds carrying
`use_full_content: false` are relying on summary-only behavior. Silently deleting the flag would
start scraping every article for them, changing what they see. The migration must instead
**convert those feeds to `aggregator="feed_content"`**, which preserves their actual behavior, then
drop the key.

Feeds with `use_full_content: true` or the key absent keep `aggregator="full_website"` and just lose
the key.

The reverse migration restores `use_full_content: false` on feeds it converted. It cannot know which
pre-existing `feed_content` feeds were originally `full_website`, so the migration should record the
converted feed IDs in its forward pass — or accept that reversal is approximate. Given this is a
one-way product decision, **approximate reversal is acceptable**; note it in the migration docstring
rather than building a tracking table.

## 3. Strip `<template>` elements

iOS strips inert `<template>` content before extraction (commit `366a80e`). The server does not —
verified absent from both `html_cleaner.py` and `content_extractor.py`.

`<template>` content is inert in a browser but is real DOM to BeautifulSoup, so its contents leak
into extracted article bodies as phantom text. Add `template` to the mandatory removal set
alongside `script` / `style` / `noscript`, applied before content selection so templates nested
inside a content container are gone before the container is captured.

## 4. Stop overwriting article dates

### Current behavior

[base.py `filter_articles`](../../../core/aggregators/base.py:220) filters articles older than
60 days, then **overwrites `article["date"]` with `timezone.now()` plus a random ±30s offset** for
every article it keeps. The comment says the jitter is to "avoid exact same timestamp for sorting".

The effect is that no article in the database has its real publish time. `Article.date` is import
time. Sort order is import order.

I believe this existed to make GReader's stream ordering monotonic: `stream_format.py` fed
`article.date` into `published`, `crawlTimeMsec`, **and** `timestampUsec` simultaneously, and
`stream_service.py` ordered by `-date` with an offset-based continuation token. Fabricated
import-time dates made that ordering stable. Spec 0 deletes all of it, so the constraint is gone.

### Target behavior

Keep the 60-day intake filter. **Do not touch the date.** This matches iOS's
`AggregationLogic.isWithinIntakeWindow`, which documents the divergence explicitly: *"Unlike the
server, the date is NOT rewritten — this only filters."*

### Ordering needs a monotonic key

Real publish dates are not monotonic with respect to import: a feed can publish an article dated
last Tuesday, and it arrives today. Anything that needs a stable, append-only ordering must use
`Article.created_at` (`auto_now_add`, [models.py:141](../../../core/models.py:141)) instead.

This matters beyond today: the new API's incremental-sync cursor needs exactly such a key. Getting
`created_at` indexed now is the groundwork for it.

| Purpose | Field |
|---|---|
| Display / user-facing article date | `date` — the real publish time |
| Stable ordering, sync cursor | `created_at`, tie-broken by `id` |
| Daily quota accounting | `created_at` — already the case, unaffected |

Add indexes:

```python
models.Index(fields=["-created_at", "-id"]),
models.Index(fields=["feed", "-created_at"]),
```

Keep every existing `date` index — `date` is still filtered and sorted on for display.

`Meta.ordering` stays `["-date"]`: the default ordering is a display concern, and admin is the only
consumer in this phase. Sync-cursor queries will order by `created_at` explicitly.

### Consequences to accept

- **Existing rows keep fabricated dates.** Their real publish times were never stored and cannot be
  recovered. Articles imported before this change keep import-time dates; those after get real ones.
- **The admin article list reorders once** after deploy, as real dates interleave with the old
  fabricated ones. Expected, not a regression.
- **Ties are now possible.** The ±30s jitter existed to prevent identical timestamps. Two articles
  genuinely published in the same second will now tie on `date`; the `-created_at, -id` index gives
  deterministic resolution wherever order matters.

## Data flow

Unchanged in shape — only the extraction step and the date step differ:

```
fetch_source_data → parse_to_raw_articles → filter_articles → enrich_articles → finalize_articles
                                            ↑                  ↑
                                    no longer rewrites   extract_main_content now
                                    article["date"]      unions a selector list
```

## Error handling

- **Invalid CSS selector** in a user-supplied list: soupsieve raises on `select()`. Catch per
  selector, log a warning naming the offending selector, and continue with the rest. One bad entry
  must not abort extraction — the feed editor is free-text and a typo is expected.
- **All content selectors miss**: fall back to `<body>`, as today.
- **Migration on malformed options**: a `Feed.options` value that is not a dict, or whose legacy key
  is not a string, is skipped with a logged warning rather than raising. A single bad row must not
  block the migration.

## Testing

New and updated tests under `core/tests/`:

**`extract_main_content` (unit)**
- Two sibling containers both matching → both present in output (the truncation this fixes).
- Nested `main` + `main > article` both matching → outermost only, body not duplicated.
- One element matched by two selectors → appears once.
- Output preserves document order, not selector order.
- Ignore selectors remove matches from all captured containers.
- No content selector matches → falls back to `<body>`.
- Invalid selector among valid ones → warns, others still applied.
- `first_match_only=True` with two sibling matches → only the first is kept.
- `extract_main_content_if_present` returns `None` on no match — explicitly **not** `<body>`.
- `generic_content_if_present` returns `None` when the matched container holds < 80 chars of text,
  and the extracted string when it holds ≥ 80.

**Options migration**
- Legacy `custom_content_selector: "article, .body"` → `content_selectors: ["article", ".body"]`.
- Legacy comma string with stray whitespace and empty segments → cleaned list.
- Explicit `content_selectors: []` preserved as empty, **not** replaced by defaults.
- Neither key present → defaults apply at read time.
- `use_full_content: false` → feed becomes `aggregator="feed_content"`.
- `use_full_content: true` → stays `full_website`, key dropped.
- Non-dict `options` → skipped without raising.

**`<template>` stripping**
- Body containing `<template><p>ghost</p></template>` → "ghost" absent from output.
- Template nested inside the content container → also stripped.

**Date semantics**
- Article dated 3 days ago survives `filter_articles` **with its date unchanged**.
- Article dated 90 days ago is filtered out.
- Two articles with the same publish second both persist and order deterministically.
- Regression guard: assert `filter_articles` does not mutate `article["date"]` — this is the
  behavior most likely to be silently reintroduced.

**Existing suites** — `tests_base_filtering.py` and the per-aggregator tests need updating for the
new `extract_main_content` signature and the removed `use_full_content`.

## Verification via admin

1. `python3 manage.py migrate`, then check a `full_website` feed in admin: options show
   `content_selectors` / `ignore_selectors` as lists, no legacy keys.
2. Any feed that had `use_full_content: false` now shows aggregator "Feed Content (RSS/Atom)".
3. `python3 manage.py test_aggregator <full_website id> --first 1 --verbose` — confirm the extracted
   body includes content from sibling containers that were previously truncated.
4. In the Articles list, newly imported articles show **plausible real publish dates** spread over
   time, not a cluster at import time.
5. `ruff check core/ --fix && ruff format core/ && mypy core/ && pytest`.

## Out of scope

- Per-scraper selector fixes (Spec 2).
- Feed URL discovery and logo resolution (Spec 3).
- Removing base64 image conversion (Spec 4).
- Block conversion (Spec 5).
- HTTP response size caps, retention cleanup, flat run limit — deferred, see the direction doc.
