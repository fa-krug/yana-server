# Translate aggregator-added chrome to the feed owner's language

**Status:** Approved
**Date:** 2026-08-08

## Problem

Several site aggregators splice their own generated HTML ("chrome") into an
article's content, on top of whatever the source page actually said: a
"Comments" section heading, a "source" link on each pulled-in comment, an
empty-state notice, and (Reddit only) two video-link labels. All of this
chrome is a hardcoded English string, regardless of the feed owner's
language preference (`user_settings.language`) -- so a German-speaking user
reading a Reddit or YouTube article aggregated from an English source still
sees genuinely German comment bodies wrapped in English "Comments" / "source"
labels the application itself added.

## Scope

**In scope** -- the seven hardcoded strings found across five site aggregators
(a closer read of `reddit/content.ts` while writing the implementation plan
turned up `"Comments unavailable."`, the fetch-error branch, missed by the
original grep for the exact literal `"Comments"`):

| String | Where |
|---|---|
| `"Comments"` | mein_mmo, mactechnews, heise, reddit, youtube |
| `"source"` | mein_mmo, mactechnews, heise, reddit, youtube |
| `"No comments yet."` | reddit |
| `"Comments disabled."` | reddit |
| `"Comments unavailable."` | reddit (`content.ts` only -- the duplicate branch in `aggregator.ts` has no fetch call of its own, so no error path to translate) |
| `"▶ View Video on YouTube"` | reddit |
| `"▶ View Video"` | reddit |

**Out of scope:** other hardcoded strings in the same files that aren't part
of this "added chrome" (image alt text like `"Gallery image"`, `"Giphy"`,
`"Animated GIF"`) -- these describe the source's own media, not text the
aggregator itself is speaking to the reader in, and are left as-is.

## Locale source

The **feed owner's** `user_settings.language` -- the same per-user locale
already used for error-notification email digests (`renderDigest()` in
`src/lib/email/digest.ts`), not the server process's own locale and not the
`Accept-Language` header (there is no request here; aggregation runs from a
background job). Falls back to English (`FALLBACK_LOCALE`) if the user's
settings row can't be found or `userId` is unset.

## New i18n catalog namespace

`aggregatorChrome` in `messages/en.json` and `messages/de.json`:

```json
{
  "comments": "Comments",
  "source": "source",
  "noCommentsYet": "No comments yet.",
  "commentsDisabled": "Comments disabled.",
  "commentsUnavailable": "Comments unavailable.",
  "viewVideoOnYoutube": "▶ View Video on YouTube",
  "viewVideo": "▶ View Video"
}
```

German:

```json
{
  "comments": "Kommentare",
  "source": "Quelle",
  "noCommentsYet": "Noch keine Kommentare.",
  "commentsDisabled": "Kommentare deaktiviert.",
  "commentsUnavailable": "Kommentare nicht verfügbar.",
  "viewVideoOnYoutube": "▶ Video auf YouTube ansehen",
  "viewVideo": "▶ Video ansehen"
}
```

Both catalogs must define the same key set (`src/i18n/messages.test.ts`
already enforces this for every namespace).

## New helper: `src/lib/aggregators/chrome-labels.ts`

```ts
export interface ChromeLabels {
  comments: string;
  source: string;
  noCommentsYet: string;
  commentsDisabled: string;
  commentsUnavailable: string;
  viewVideoOnYoutube: string;
  viewVideo: string;
}

export async function resolveChromeLabels(
  userId: string | number | null | undefined,
): Promise<ChromeLabels>
```

Implementation mirrors `renderDigest()` exactly: look up
`userSettings.language` by `userId` (default `FALLBACK_LOCALE` if no row or
no `userId`), dynamically `import()` that locale's `messages/*.json`, and
render the six keys through `createTranslator` (`use-intl/core`) with
namespace `"aggregatorChrome"`. This is a DB read plus a JSON import, so it
lives in `src/lib/aggregators/` (already a server-only zone) rather than
being importable from a client component.

## `BaseAggregator.chromeLabels()`

A new protected method on `BaseAggregator` (`src/lib/aggregators/base.ts`):

```ts
protected chromeLabels(): Promise<ChromeLabels> {
  if (!this._chromeLabelsPromise) {
    this._chromeLabelsPromise = resolveChromeLabels(this.feed.userId);
  }
  return this._chromeLabelsPromise;
}
```

Memoized per aggregator instance: a feed with many articles reuses one DB
read for the whole run, matching how `createAggregator(feed)` is called once
per aggregate/reload job.

## Threading the labels through

Every function that currently hardcodes one of the six strings gains a
required `labels: ChromeLabels` parameter -- no default value, so a call site
that forgets to pass it is a compile error, not silently-shipped English.
Each aggregator resolves `await this.chromeLabels()` once at its own call
site and threads the result down.

Touched files:

- **`src/lib/aggregators/sites/mein_mmo/comments.ts`** -- `commentLink()`'s
  `"source"` call site and `extractComments()`'s `"Comments"` header both take
  `labels`; `extractComments()` gains a `labels` parameter, threaded from
  **`sites/mein_mmo/aggregator.ts`**'s call site.
- **`src/lib/aggregators/sites/mactechnews/comments.ts`** -- identical shape
  to mein_mmo's, threaded from **`sites/mactechnews/aggregator.ts`**.
- **`src/lib/aggregators/sites/heise.ts`** -- `commentSourceLink()` and the
  `"Comments"` header inline in `extractComments()` (already an instance
  method with `this`) both take `labels`, resolved once at the top of
  `extractComments()`.
- **`src/lib/aggregators/sites/reddit/comments.ts`** -- `formatCommentHtml()`
  gains a `labels` parameter for its `"source"` link.
- **`src/lib/aggregators/sites/reddit/content.ts`** -- `buildPostContent()`
  gains a `labels` parameter, threaded into `addLinkMedia()`'s
  `"▶ View Video on YouTube"` label and `addCommentsSection()`'s `"Comments"`
  header, `"No comments yet."`, `"Comments unavailable."`,
  `"Comments disabled."`, and its `formatCommentHtml()` calls.
- **`src/lib/aggregators/sites/reddit/aggregator.ts`** -- three independent
  spots, none of which call into `content.ts` (each reimplements its own
  version of the same content-building inline):
  - `fetchArticleContent()` (the real refetch path, also what `reload.ts` now
    calls) resolves `labels` and passes them into its `buildPostContent()`
    call.
  - A header-caption builder around line 440 uses `"▶ View Video"` (note:
    singular, no "on YouTube" -- a distinct label from the other two
    view-video strings) and needs `labels` threaded to its call site.
  - The legacy JSON-shaped `extractContent()` override reimplements its own
    version of `buildPostContent()`'s content-building inline (including
    `"▶ View Video on YouTube"`, `"No comments yet."`, and
    `"Comments disabled."` -- it has no fetch call of its own, so no
    `"Comments unavailable."` branch) -- it becomes `async` (the base class
    already types this as `string | Promise<string>`, and both call sites
    already `await` it) so it can resolve `await this.chromeLabels()` too.
- **`src/lib/aggregators/sites/youtube/aggregator.ts`** -- `buildContentHtml()`
  gains a `labels` parameter for its `"Comments"` heading and per-comment
  `"source"` link. `enrichArticles()` (already async) resolves labels before
  calling it. `extractContent()` becomes `async` for the same reason as
  Reddit's, resolving labels before its two `buildContentHtml()`-calling
  branches.

## Testing

- New `src/lib/aggregators/chrome-labels.test.ts`: resolves the right locale
  from a real `user_settings` row (matching this repo's real-database testing
  convention for `src/lib/**`), and falls back to English for a missing row /
  `null` userId.
- Every existing test in the five touched aggregators' test files that
  asserts literal `"Comments"` / `"source"` / etc. text is updated to pass
  explicit labels (English, to keep most tests unchanged in intent).
- At least one test per touched aggregator proves German labels actually
  reach the rendered HTML end-to-end (a German `user_settings.language` row
  produces `"Kommentare"` / `"Quelle"` in the output), not just that the
  parameter is accepted.

## Non-goals

- No UI changes -- this is entirely inside the aggregation/reload pipeline.
- No change to how `article.reload`'s error-notice text (added in the
  previous change) is localized -- that's user-facing product text with a
  different owner question (is it the reader's language or the feed owner's?)
  and is deliberately left for a separate decision.
