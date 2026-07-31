# Spec 2: Aggregator Parity — Scraper Fixes & New Types

> **Superseded by the Next.js migration (2026-07-30).** The Django implementation
> described here now lives in `old/`, read-only — paths like `core/…` are `old/core/…`
> today. This document is kept as a record of decisions that were correct when made,
> and its behavior descriptions remain the reference for porting them to TypeScript.
> See [the Next.js direction record](2026-07-30-nextjs-migration-direction.md).

**Date:** 2026-07-29
**Status:** Approved design, pending spec review
**Depends on:** Spec 1 (extraction core — supplies `uses_first_content_match`,
`extract_main_content_if_present`, `generic_content_if_present`)
**Direction:** `2026-07-29-client-server-remigration-direction.md`

## Goal

Port the six scraper fixes iOS made that never reached the server, add the two aggregator types that
exist only on iOS, and close the one per-feed option gap. After this spec the server's 16 aggregator
types match iOS's, and each produces the same article body.

Every item below was **verified absent** from the server by grep before being listed.

## Part A — Scraper fixes

### A1. Merkur: strip follow-us buttons

**iOS commit** `3b2c973`. **Server file** `core/aggregators/merkur/aggregator.py`.

Merkur embeds "Uns auf Google/YouTube folgen" buttons as standalone `InteractionBar` anchors
(e.g. `.id-Story-googleFollowButton`) inside the story flow, so they leak into the body as stray
links. iOS added one selector to `selectorsToRemove`:

```
[class*=FollowButton]
```

Add the same entry to Merkur's `selectors_to_remove`. Attribute-substring form is deliberate — the
class names vary per network (Google, YouTube), so matching the shared suffix covers all of them
without enumerating each.

### A2. Heise: article body, not site navigation

**iOS commit** `9a87cca`. **Server file** `core/aggregators/heise/aggregator.py`.

Heise pages carry many sibling `<article>` teaser cards and a page-chrome `.article-content`
container. Spec 1's OR-union would pull related-story teasers and navigation into the body.

Two changes, both using Spec 1's hooks:

1. `uses_first_content_match = True` on the Heise aggregator. The dedicated container is
   `#meldung` (an `<article id="meldung">`), with the older `.StoryContent` as an alternate.
2. Use `extract_main_content_if_present`, and on `None` fall back to the **RSS summary**, not
   `<body>`. Heise magazine/paywall gate pages have a different DOM; dumping `<body>` for those
   surfaced the whole site chrome as the article.

Note this fix is *only correct* alongside Spec 1's escape hatches. Applying the union to Heise
without `uses_first_content_match` would regress it.

### A3. Tagesschau: empty articles from external ARD broadcasters

**iOS commit** `84ef715`. **Server files** `core/aggregators/tagesschau/aggregator.py`,
`content_extraction.py`.

Tagesschau's regional feeds syndicate items that link straight to an external ARD broadcaster page
(mdr.de, ndr.de, …). Those templates carry none of tagesschau.de's own `textabsatz` / MediaPlayer
markup, so site-specific extraction finds nothing and the article lands empty.

Wire in Spec 1's `generic_content_if_present` as the middle tier:

```
tagesschau-specific extraction → generic <article>/main extraction (≥80 chars) → RSS summary
```

The 80-character floor matters: a broadcaster page whose only matched container is a byline or
breadcrumb must lose to the RSS fallback. Keep the threshold identical to iOS's so the two agree
while both exist. Widget-style pages (the DWD weather pages) have no container at all and correctly
land on RSS.

### A4. MacTechNews: skip TechTicker roundups

**iOS commit** `1584d8c`. **Server file** `core/aggregators/mactechnews/aggregator.py`.

Recurring "TechTicker:" link-roundup posts are noise. iOS overrides its include predicate:

```swift
override func shouldInclude(_ article: AggregatedArticle) -> Bool {
    !article.title.hasPrefix("TechTicker:")
}
```

Server equivalent: filter titles with the `TechTicker:` prefix during `filter_articles` (or the
server's nearest include hook). **Prefix match, case-sensitive**, mirroring iOS — these are
generated titles with a consistent form, and a looser `contains` would drop legitimate articles
that merely mention the word.

Relevant precedent: Heise's own title skip-list was made **case-insensitive** on the server
(commit `338e62a`) because its terms appear mid-title with varying case. TechTicker is the opposite
case. Don't unify them.

### A5. Reddit: keep a direct-image/GIF post's image

**iOS commit** `f90b232`. **Server files** `core/aggregators/reddit/aggregator.py`,
`core/aggregators/reddit/images.py`.

The bug: for a direct-image or GIF link post the image exists **only in the body** (added by the
link-media step). The old logic stripped the body's copy whenever a header URL merely *existed* —
even when `include_header_image` was off, or when the header image download failed. That removed the
sole image with nothing replacing it, so the GIF vanished entirely.

The fix inverts the order: only strip the body's duplicate **after a header was actually rendered**.

```
if include_header_image
   and (header_url := header_image_url(post, fallback=outer))
   and (header := make_header_html(header_url, title)):
       header_html = header
       body = strip_image(body, url=header_url)      # only now
```

This requires the header-building helper to return `None` rather than `""` when it can't produce
markup — an unreachable or oversized image, or a tweet whose embed fetch fails. `""` and "no header"
must be distinguishable; conflating them is what caused the bug.

### A6. Recover consent-gated (Embed Privacy) YouTube embeds

**iOS commit** `abbca85`. **Server files** `core/aggregators/utils/youtube.py`, and the shared
embed-rewriting path used by `caschys_blog` and others.

WordPress's "Embed Privacy" plugin — widespread on German sites, notably Caschy's Blog — replaces a
video `<iframe>` with a `.embed-privacy-container` consent gate. The real player exists only as a
string inside a `<script>` template, which sanitization strips. What survives is the visible consent
boilerplate ("Hier klicken, um den Inhalt von YouTube anzuzeigen…"), leaking into the article as
stray paragraphs.

Recovery, run **before** the normal embed-rewrite pass so recovered iframes get rewritten like any
other embed:

1. For each `.embed-privacy-container`, read the "open directly" footer link
   `.embed-privacy-url a[href]` — a real anchor that survives sanitization.
2. Extract a YouTube ID from it. On success, replace the whole container with
   `<iframe src="https://www.youtube.com/embed/<id>"></iframe>`.
3. On failure, **remove the container** so its consent text doesn't survive either.

Dropping the gate on failure is the important half: leaving it produces the stray-paragraph bug this
fixes.

## Part B — New aggregator types

Both are full-article scrapers: fetch the site's RSS feed for the list, scrape each article page for
the body. Both are **AI-options-only** — no extra per-feed toggles. Reference design:
`../yana-ios/docs/superpowers/specs/2026-07-07-verge-ars-aggregators-design.md`.

Registration for each follows the standard three steps: add to `AGGREGATOR_CHOICES`
(`core/choices.py`), register in `core/aggregators/registry.py`, implement under
`core/aggregators/<name>/`.

### B1. The Verge (`the_verge`)

`core/aggregators/the_verge/aggregator.py`, modeled on `MerkurAggregator`.

- Default feed: `https://www.theverge.com/rss/index.xml` — the only feed The Verge exposes; section
  feeds under `/<cat>/rss/index.xml` return 404 (verified in the iOS design).
- `identifier_choices`: one entry, `("https://www.theverge.com/rss/index.xml", "Main Feed")`.
- `content_selector`: `.duet--article--article-body-component`. The Verge is WordPress-backed with
  Vox's "Duet" design system; the prose lives in `.duet--article--dangerously-set-cms-markup` blocks
  inside this container.
- **`uses_first_content_match = True`.** This is essential: the page embeds ~22 sibling
  `article-body-component` divs — the main article **plus related/"stream" article bodies**. Spec 1's
  union would splice unrelated articles into the body.
- `selectors_to_remove`: ad slots, newsletter/recirculation cards, `aside`, plus candidates
  `[class*='duet--recirculation']`, `[class*='duet--ad']`, `[class*='newsletter']`. Refine against a
  captured fixture during TDD.

### B2. Ars Technica (`ars_technica`)

`core/aggregators/ars_technica/aggregator.py`, Merkur-shaped but with an in-page multi-block merge.

- Default feed: `https://arstechnica.com/feed/`.
- `identifier_choices` (all verified 200 in the iOS design): Main Feed, Gadgets
  (`/gadgets/feed/`), Science (`/science/feed/`), Gaming (`/gaming/feed/`).
- `content_selector`: `.post-content`.
- **Merges all in-page `.post-content` blocks.** Ars renders every "page" of an article in the single
  fetched HTML as sibling `div.post-content.post-content-double` blocks separated by
  `<a data-page="N">` trackers. Even a single-page news article splits into 2 genuine blocks. First-
  match would **truncate** the article.
  - So Ars wants Spec 1's default union behavior (`uses_first_content_match = False`) — it is the
    one scraper for which unioning is exactly right.
  - **Do not de-duplicate** the blocks; they are distinct article segments, not repeats.
  - No extra HTTP fetches. Appending `/N/` to an Ars URL redirects to a `#page-N` anchor on the same
    URL, so pagination handling is unnecessary — this is simpler than the MacTechNews multi-fetch
    pattern.
- `selectors_to_remove`: `.ad`, `[class*='ad-wrapper']`, `.ad--mid-content`, `.ad--rail`, `aside`,
  `.social-share`. Refine against a fixture.

The Verge and Ars are instructive as a pair: they need **opposite** settings of
`uses_first_content_match`, which is why Spec 1 makes it a per-aggregator flag rather than a global
policy.

## Part C — Option gap

**mein_mmo comment options.** iOS's `MeinMmoOptions` carries `combinePages`, `includeComments`,
`maxComments`; the server exposes only `combine_pages`
([mein_mmo/aggregator.py:82](../../../core/aggregators/mein_mmo/aggregator.py:82)).

Add `include_comments` (default `True`) and `max_comments` (default `5`) to mein_mmo's
`get_configuration_fields()` and wire them into comment extraction, matching the shape MacTechNews
and Heise already use on the server.

Note there is **no** exposure gap for reddit's `min_age_hours` or oglaf's `convert_to_base64` — both
are already in their `get_configuration_fields()`. (`convert_to_base64` is removed entirely in
Spec 4.)

## Data flow

Unchanged. Each fix is a selector list, an include predicate, or a fallback branch inside the
existing `fetch → parse → filter → enrich → finalize` template. The two new aggregators are ordinary
`FullWebsiteAggregator` subclasses.

## Error handling

- **A2 / A3 fallbacks**: a missing container returns `None` and the caller degrades to the next tier.
  Never raise — a DOM change on one site must not fail the run.
- **A6 recovery**: an unparseable consent gate is removed, not left in place. Malformed HTML inside
  the gate is caught per container so one bad embed doesn't abort the article.
- **A5**: a failed header image download returns `None`, the body keeps its image. The failure mode
  is now "no header, image intact" instead of "no header, no image".
- **B1 / B2**: inherited `FullWebsiteAggregator` behavior — page fetch or parse failure falls back to
  the RSS summary; `ArticleSkipError` on 4xx skips the article.

## Testing

Per-aggregator tests under `core/tests/`, using inline HTML fixtures in the existing style:

**A1 Merkur** — a `.id-Story-googleFollowButton` anchor is stripped; ordinary story links survive.
**A2 Heise** — a page with `#meldung` plus 3 sibling teaser `<article>` cards yields only the
story body; a page **without** `#meldung` falls back to RSS content and contains no `<nav>` text.
**A3 Tagesschau** — an external-broadcaster page with a generic `<article>` of ≥80 chars extracts via
the generic tier; the same page with a 20-char byline-only container falls back to RSS; a
container-less widget page falls back to RSS.
**A4 MacTechNews** — "TechTicker: Foo" excluded, "Foo TechTicker Bar" **included** (guards against
substring matching).
**A5 Reddit** — a direct-image post with `include_header_image=False` keeps its body image; with it
`True` and a successful header, the body copy is stripped; with it `True` and a **failing** header
download, the body image survives.
**A6 Embed Privacy** — a `.embed-privacy-container` with a recoverable YouTube URL becomes an embed;
one with an unrecognizable URL is removed and its consent text is absent from output.
**B1 The Verge** — extracts the body from `.duet--article--article-body-component`; a fixture with 3
sibling body components yields **only the first** (guards against splicing related articles); strips
a noise selector; `identifier_choices` has 1 entry.
**B2 Ars Technica** — a fixture with 2 sibling `.post-content` blocks yields **both merged** (guards
against truncation); strips an `.ad*` selector; `identifier_choices` has 4 entries with the expected
values.
**C mein_mmo** — comments extracted when enabled, capped at `max_comments`, absent when disabled.

**Registry/choices** — both new types resolve via `AggregatorRegistry.get()`; `AGGREGATOR_CHOICES`
length goes 14 → 16.

## Verification via admin

1. `python3 manage.py migrate` (new choices need no schema change, but run it).
2. Create a The Verge feed and an Ars Technica feed in admin; confirm both appear in the aggregator
   dropdown with correct display names and that the identifier picker offers the expected feeds.
3. `python3 manage.py test_aggregator the_verge --dry-run --verbose` and the same for
   `ars_technica` — confirm bodies are complete (Ars: multiple segments present; Verge: no unrelated
   article text).
4. `python3 manage.py test_aggregator <heise id> --first 1 --verbose` — no navigation text in the body.
5. `python3 manage.py test_aggregator <caschys id> --first 1 --verbose` — no "Hier klicken, um den
   Inhalt von YouTube anzuzeigen" boilerplate.
6. Open a few resulting articles in admin and read the content field.
7. `ruff check core/ --fix && ruff format core/ && mypy core/ && pytest`.

## Out of scope

- Feed discovery, URL resolution, logos, AI selector suggestion (Spec 3).
- base64 removal and image hosting (Spec 4).
- Block conversion (Spec 5).
- MKBHD or any YouTube-sourced managed feed — dropped in the iOS design and not revisited.
- Per-feed toggles for the new types beyond the shared AI block.
