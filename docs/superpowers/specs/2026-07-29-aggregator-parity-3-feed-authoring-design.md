# Spec 3: Aggregator Parity — Feed Authoring

**Date:** 2026-07-29
**Status:** Approved design, pending spec review
**Depends on:** Spec 0 (GReader removal) for ordering hygiene only — nothing here touches GReader
code. Items 1–3 are independent of Specs 1, 2, 4, 5 and **can run in parallel**; item 4 alone needs
Spec 1's selector-list options.
**Direction:** `2026-07-29-client-server-remigration-direction.md`

## Goal

Port the feed-setup capabilities iOS grew that the server lacks entirely. These concern getting a
feed *configured correctly* rather than what an article body looks like, which is why this spec
doesn't touch the article pipeline and can proceed alongside the extraction work.

Four pieces:

1. **Feed discovery** — accept a homepage URL and find its feed.
2. **URL normalization** — fill in missing schemes, handle `feed://`.
3. **Logo resolution** — a per-feed logo image, from favicons or brand sites.
4. **AI selector suggestion** — generate content/ignore selector lists from a live page.

Item 4 depends on Spec 1's selector-list options existing. If Spec 3 runs ahead of Spec 1, build
items 1–3 first and hold 4 until Spec 1 lands.

## 1. Feed discovery

Today the `identifier` for a URL-based feed must be the feed URL itself. Users have to hunt it down.

New helper, `core/aggregators/utils/feed_discovery.py`, mirroring iOS's `FeedDiscovery`:

```python
def feed_url_in_html(html: str, base_url: str | None) -> str | None:
    """First alternate RSS/Atom feed href in `html`, resolved absolute. Pure — no network."""

def discover_feed_url(page_url: str) -> str | None:
    """Fetch `page_url` and return its advertised feed URL, or None."""
```

- Parse `link[rel=alternate][type]`, matching `application/rss+xml` then `application/atom+xml`.
  **RSS is preferred over Atom** when both are advertised, matching iOS.
- Resolve relative hrefs against the page URL.
- Skip entries with an empty or whitespace-only `href`.
- Split pure parsing from fetching so the parse half is unit-testable without network, and so
  callers already holding page HTML can reuse it.

**Wiring:** in the RSS pipeline's entry fetch, if `identifier` fails to parse as a feed *or* yields
zero entries, and it looks like an HTML page, run discovery and parse the discovered feed. Keep it
best-effort — a page with no discoverable feed surfaces the existing "no entries" outcome rather
than a new error class.

Discovery is **not cached** in this version; it re-runs per fetch. Caching it on the `Feed` row is a
reasonable follow-up but adds an invalidation question (what if the site moves its feed?) that isn't
worth answering yet.

## 2. URL normalization

`core/aggregators/utils/feed_url_resolver.py`, mirroring iOS's `FeedURLResolver`:

```python
def normalize(raw: str) -> str:
    """Trim; prepend https:// when no scheme; rewrite feed:// → https://. Empty passes through."""

def resolve_feed_url(raw: str) -> str:
    """normalize(), then resolve a homepage to its advertised feed. Never raises."""
```

`resolve_feed_url` returns the normalized input unchanged when the input already parses as a feed,
when discovery finds nothing, or on **any** network or parse failure. It must never raise: a resolve
failure must not block saving a feed. This is the property that makes it safe to call from a form's
`clean()`.

**Which aggregators resolve.** iOS gates this on `resolvesFeedURL` — true only for free-form URL
types (`full_website`, `feed_content`, `podcast`), false for managed feeds with fixed
`identifier_choices` and for the non-URL identifier kinds (subreddits, YouTube channels). Mirror
that: add a class attribute on `BaseAggregator`, defaulting to
`identifier_field == "identifier"` and no `identifier_choices`, overridable per aggregator.
Normalizing a subreddit name into `https://swift` would be a real bug.

**Admin integration.** Resolve on save in `FeedAdminForm.clean_identifier()`, so a user pasting
`golem.de` gets `https://golem.de/rss.php` stored. Given this phase verifies through admin, also add
a **"Resolve & test"** admin action (iOS has the equivalent button, commit `76f1548`) that resolves
the identifier and reports how many entries the feed yields, without saving. That is the fastest way
to confirm a feed is configured right.

## 3. Logo resolution

The server has no per-feed logo concept. `Article.icon` exists but is per-article and only YouTube
populates it.

Three collaborating pieces, mirroring iOS:

### 3a. Favicon resolution

`core/aggregators/utils/favicon.py`:

```python
def best_icon_url(html: str, base_url: str) -> str | None:   # pure
def resolve_site_icon(site_url: str) -> str | None:          # fetches, falls back to /favicon.ico
```

Selection rules, matching iOS's `FaviconResolver`:
- Consider `link[rel]` entries whose rel contains `apple-touch-icon`, or whose rel tokens include
  `icon`.
- **`apple-touch-icon` wins outright**; otherwise the largest declared `sizes` area.
- Resolve hrefs absolute against the base URL.
- No declared icon → try `/favicon.ico` on the same origin.
- **Only ever contact the site's own domain.** No third-party favicon services — that would leak
  every subscribed URL to a third party.

### 3b. White-background removal

`core/aggregators/utils/logo_background.py`, porting iOS's `LogoBackgroundRemover` from CoreGraphics
to Pillow:

- Sample the border; treat the image as white-backed when ≥ **85%** of border pixels have all
  channels ≥ **240**.
- Flood-fill from the edges, clearing only white **connected to the border** — so white enclosed by
  the subject (lettering inside a dark circle) is preserved.
- Return `None` when no white background is detected, so callers keep the original bytes untouched.

Keep both thresholds identical to iOS's (`whiteThreshold = 240`, `borderWhiteFraction = 0.85`) so the
two implementations agree while they coexist.

### 3c. Priority resolution

`core/aggregators/feed_logo.py`, mirroring iOS's `FeedLogoResolver` — three tiers:

1. An API-provided image, where the aggregator has one (Reddit subreddit icon, YouTube channel
   avatar). Add an overridable `logo_image_url()` on `BaseAggregator` returning `None` by default.
2. The hardcoded **brand-site favicon**, for fixed-brand scrapers. Needs a `brand_site_url` class
   attribute per aggregator, seeded from iOS's `AggregatorType.brandSiteURL`:

   | Aggregator | Brand site |
   |---|---|
   | `heise` | `https://www.heise.de/` |
   | `merkur` | `https://www.merkur.de/` |
   | `tagesschau` | `https://www.tagesschau.de/` |
   | `explosm` | `https://explosm.net/` |
   | `dark_legacy` | `https://darklegacycomics.com/` |
   | `caschys_blog` | `https://stadt-bremerhaven.de/` |
   | `the_verge` | `https://www.theverge.com/` |
   | `ars_technica` | `https://arstechnica.com/` |
   | `mactechnews` | `https://www.mactechnews.de/` |
   | `oglaf` | `https://www.oglaf.com/` |
   | `mein_mmo` | `https://mein-mmo.de/` |

   `None` for `full_website`, `feed_content`, `podcast` (favicon comes from the identifier) and for
   `reddit` / `youtube` (logo comes from their API).
3. The **identifier's site favicon** — `scheme://host/` derived from the identifier — for URL-based
   feeds.

`the_verge` and `ars_technica` are in the table above but only exist after Spec 2. If Spec 3 lands
first, add their rows when Spec 2 does.

### 3d. Storage

Add to `Feed`:

```python
logo = models.ImageField(upload_to="feed_logos/", blank=True, null=True)
logo_source_url = models.TextField(blank=True, default="")   # what we resolved from; for re-resolution
```

Resolved on feed save when the identifier or aggregator changed, and refreshable via an admin action.
Not resolved on every aggregation run — a favicon changing is rare and not worth a request per run.

**Interaction with Spec 4.** Spec 4 introduces content-addressed `ArticleImage` hosting. Feed logos
are a natural fit for the same store, but this spec deliberately uses a plain `ImageField` to stay
independent and parallel-safe. Spec 4 may migrate logos into `ArticleImage`; that is noted there as
optional follow-up, not a dependency in either direction.

## 4. AI selector suggestion

`core/services/selector_suggester.py`, using the existing `core/ai_client.py`. Mirrors iOS's
`SelectorSuggester`.

```python
def suggest_selectors(feed: Feed, kind: Literal["content", "ignore"]) -> list[str]:
```

- Fetch the feed's first article page HTML, strip chrome and cap length before prompting (the server
  needs an equivalent of iOS's `ArticleAIText` — a plain-text extraction with a character cap).
- Prompt in JSON mode, **scoped to one kind at a time**: content → selectors for the main article
  container(s); ignore → selectors for noise to strip.
- Pass the list's current entries as *candidates to validate* — keep the ones still appropriate,
  drop the stale. This is how a user's hand-tuned selectors survive a regeneration.
- Decode `{"selectors": [...]}` and **overwrite only the requested list**.

**Admin integration:** two admin actions on `Feed` — "Suggest content selectors" and "Suggest ignore
selectors" — each writing back to `options` and reporting what changed. **Hidden entirely when no AI
provider is configured**, matching iOS (hidden, not disabled).

Depends on Spec 1's `content_selectors` / `ignore_selectors` keys.

## Error handling

Every piece here is best-effort and must degrade rather than block feed configuration:

- **Discovery / resolution**: any network, timeout, or parse failure returns the normalized input.
  Never raises to the form.
- **Favicon**: a site with no icon and no `/favicon.ico` yields `None`; the feed simply has no logo.
- **Background removal**: any decode failure returns `None` and the original bytes are stored.
- **AI suggestion**: a provider error, a timeout, or undecodable JSON surfaces as an admin message
  and leaves the existing list **untouched**. Never overwrite a working selector list with nothing.
- **Logo fetch on save**: failures are logged and leave `logo` empty. A dead favicon URL must not
  prevent saving a feed.

## Testing

**Feed discovery** — RSS link found; Atom-only found; RSS preferred when both present; relative href
resolved; no alternate link → `None`; empty href skipped.
**URL normalization** — bare domain gains `https://`; existing `http://` preserved; `feed://`
rewritten; whitespace trimmed; empty passes through; a subreddit-style identifier on a non-resolving
aggregator is left alone.
**`resolve_feed_url`** — homepage resolves to discovered feed; already-a-feed returns unchanged;
network failure returns normalized input **without raising** (assert no exception).
**Favicon** — `apple-touch-icon` beats a larger plain icon; largest `sizes` wins among plain icons;
malformed `sizes` doesn't crash selection; no icon links → `None` (then `/favicon.ico` path).
**Background removal** — a white-bordered logo becomes transparent at the edges; white *enclosed* by
dark subject matter is **preserved** (the flood-fill property); a photo with a busy border returns
`None`; a 1×1 image returns `None`.
**Logo priority** — API image wins over brand favicon; brand favicon wins over identifier favicon;
URL-based feed with no brand uses the identifier origin; unparseable identifier → `None`.
**Selector suggester** — valid JSON decodes and overwrites only the requested list; malformed JSON
leaves the list unchanged; no configured provider → action unavailable.

Mock all HTTP and AI calls; no test may touch the network.

## Verification via admin

1. Create a `full_website` feed with identifier `golem.de`. Save. Confirm the stored identifier
   became an absolute feed URL.
2. Run the **Resolve & test** action on it; confirm it reports a plausible entry count.
3. Confirm the feed's `logo` populated, and that a brand scraper (e.g. Heise) picked up the Heise
   favicon rather than a feed-URL favicon.
4. With an AI provider configured, run **Suggest ignore selectors** on that feed and confirm
   `options["ignore_selectors"]` changed and `content_selectors` did **not**.
5. With no AI provider configured, confirm both suggest actions are absent from the action list.
6. `ruff check core/ --fix && ruff format core/ && mypy core/ && pytest`.

## Out of scope

- Homepage link-scraping or an AI-proposed link selector for sites with no discoverable feed.
- Caching discovered feed URLs on the `Feed` row.
- Readability-style density scoring as an alternative to selectors.
- JSON-LD `articleBody` extraction, conditional GET.
- The extraction-preview UI iOS has — admin plus `test_aggregator` covers verification for this phase.
