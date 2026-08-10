# Feeds OPML Import/Export — Design

**Date:** 2026-08-10
**Status:** Approved (pending spec review)

## Overview

Add OPML import and export to the `/feeds` list, so a user can back up their feed
subscriptions or move them between Yana instances (or in from/out to another feed
reader). Per-user, following the existing ownership model (`feeds.userId`) —
there is no cross-user or admin-wide import/export.

There is prior art for the file format from a sibling project: the Yana iOS app
shipped an OPML import/export feature (see `Yana/Services/OPMLCodec.swift` on a
branch not ancestral to this repo's history — retrievable via
`git show 01df9a34:docs/superpowers/specs/2026-06-16-search-opml-notifications-design.md`).
This design reuses that file format, extended with three attributes for
columns the iOS schema doesn't have (`updateIntervalMinutes`, `concurrency`,
`maxArticleAgeDays`). No other code or UI is shared — the iOS design is
SwiftUI/SwiftData; this is Next.js server actions and a route handler.

## Format

Standard OPML 2.0. One `<outline>` per feed under `<body>`, with a `yana:`
extension namespace declared on `<opml>`. The namespace is a `urn:` value, not
an `http(s)://` URL — a namespace URI is just a unique identifier per the XML
spec and is never dereferenced, so a `urn:` avoids implying a fetchable page we
don't actually host (unlike, say, RSS's `content:` namespace, which happens to
resolve to real documentation but doesn't need to):

```xml
<opml version="2.0" xmlns:yana="urn:yana:opml">
  <body>
    <outline text="Heise" title="Heise" type="rss"
             xmlUrl="https://www.heise.de/rss/heise-atom.xml"
             yana:aggregatorType="full_website"
             yana:enabled="true"
             yana:dailyLimit="20"
             yana:updateIntervalMinutes="30"
             yana:concurrency="4"
             yana:maxArticleAgeDays="30"
             yana:tags="Tech,News"
             yana:options="<base64 JSON of the aggregator's options object>" />
  </body>
</opml>
```

- `text`/`title` = `feeds.name`; `xmlUrl` = `feeds.identifier`; `type="rss"`
  always, regardless of aggregator (kept for interoperability with generic
  OPML readers, which understand `type="rss"` and nothing else here).
- `yana:tags` is a comma-separated list of tag **names**, not ids — ids are not
  portable across instances/users.
- `yana:options` is present only when the aggregator has non-empty options.
- Unknown `yana:*` attributes are ignored by other OPML readers, so a file
  exported from Yana stays valid, useful OPML for any other feed reader — only
  a Yana-to-Yana round trip recovers full fidelity (scheduling, options, tags,
  enabled state).
- Importing a **foreign** OPML file (no `yana:aggregatorType`, e.g. exported
  from another feed reader) falls back to `aggregator: "full_website"` with
  `identifier = xmlUrl` and every other field at the schema default.

Parsing reuses `cheerio` in `xmlMode` (already a dependency, already used for
RSS/Atom parsing in `src/lib/aggregators/rss-parser.ts`) — no new package.
Encoding is manual string templating with XML-escaping — the format is simple
enough that a templating helper is not worth a dependency.

## Architecture

### `src/lib/feeds/opml.ts` (new)

Pure codec, no database or auth:

- `encodeOpml(feeds: OpmlExportFeed[]): string`
- `decodeOpml(xml: string): OpmlEntry[]` — throws on unparseable XML (no
  `<opml>`/`<body>` structure at all); a structurally valid OPML file with
  outlines cheerio can't make sense of simply omits those outlines rather than
  throwing, so one bad `<outline>` in an otherwise-good file doesn't sink the
  whole import.

```ts
type OpmlExportFeed = {
  name: string;
  aggregator: string;
  identifier: string;
  enabled: boolean;
  dailyLimit: number;
  updateIntervalMinutes: number;
  concurrency: number;
  maxArticleAgeDays: number;
  options: Record<string, unknown>;
  tags: string[]; // names
};

type OpmlEntry = {
  name: string;
  identifier: string; // xmlUrl; "" if absent
  aggregatorType?: string; // yana:aggregatorType, if present
  enabled?: boolean;
  dailyLimit?: number;
  updateIntervalMinutes?: number;
  concurrency?: number;
  maxArticleAgeDays?: number;
  options?: Record<string, unknown>; // decoded from base64 JSON, if present and valid JSON
  tags: string[]; // names, "" filtered out
};
```

### `src/lib/feeds/actions.ts` (two new server actions)

**`previewOpmlImport(content: string)`**

1. `decodeOpml(content)`. A throw here → `{ ok: false, errorKey: "invalidOpmlFile" }`.
2. For each `OpmlEntry`, resolve the effective aggregator: `AGGREGATOR_SPECS[entry.aggregatorType]`
   if that key exists, else the `full_website` spec (the foreign-OPML fallback).
3. Classify:
   - **`invalid`** — no usable identifier (`entry.identifier` empty and the
     resolved spec requires one), **or** `entry.options` is present but fails
     `schemaFor(spec.key).safeParse(...)`. Both carry a `reason` for display.
     (Only `options` — declared and wrong — is treated as invalid; an absent
     or unrecognized `aggregatorType` is the expected, handled foreign-OPML
     case above, not an error.)
   - **`duplicate`** — a feed with the same `(aggregator, identifier)` already
     exists for the caller (`currentUserId()`).
   - **`new`** — everything else.
4. Returns `{ ok: true, entries: PreviewEntry[] }` where `PreviewEntry` adds
   `{ status, reason? }` to the resolved fields (name, aggregator label, tags,
   identifier) the dialog needs to render.

**`importOpmlFeeds(content: string)`**

Re-runs steps 1–3 above from scratch (never trusts a stale preview — the list
may have changed between preview and confirm) and, inside one
`writeTransaction`:

- For each `new` entry: resolve/create tags by name (case-insensitive match
  against the caller's existing tags, matching `createFeed`'s tag-resolution
  behavior), insert the `feeds` row with validated/defaulted fields, insert
  `feedTags` rows, and enqueue a `feed.logo` job — the same shape `createFeed`
  already does per feed, just looped.
- `invalid` and `duplicate` entries are skipped, already counted.
- One `revalidatePath("/feeds")` after the loop.

Returns `{ ok: true, imported: number, skipped: number }` or
`{ ok: false, errorKey: "invalidOpmlFile" }`.

This is deliberately **not** a background job/run (`enqueueRun`/`waitForRun`):
feed creation is fast (no network calls, unlike aggregation), so a synchronous
request/response is enough and avoids a spinner for what's typically a
sub-second operation even for a few hundred feeds.

### `src/app/api/feeds/export/route.ts` (new)

A GET route handler, not a server action — server actions here only return
JSON, and a file download needs a real HTTP response with
`Content-Disposition`. Follows the `src/app/media/avatars/[userId]/route.ts`
precedent: the route authenticates itself with `requireUser()` (nothing above
a route handler does).

- Optional `?ids=1,2,3` query param. Present → export just those feeds (still
  filtered to `eq(feeds.userId, caller)`, so an id belonging to another user is
  silently excluded rather than leaking their feed — same "compare, don't
  trust the URL" rule the avatar route follows). Absent → export every feed
  the caller owns.
- Loads each feed's tags the same way `getFeed`/`listFeeds` already do, maps to
  `OpmlExportFeed`, calls `encodeOpml`.
- Response headers: `Content-Type: text/x-opml+xml; charset=utf-8`,
  `Content-Disposition: attachment; filename="yana-feeds.opml"`.

Not under `/api/v1` — that prefix is the Bearer-token native-client API
(`requireApiUser()`); this is a cookie-session, browser-only feature, so it
sits beside `/media` instead. `src/proxy.ts`'s `PUBLIC_PREFIXES` does not need
a new entry: `/api/feeds` isn't public, so the proxy's cookie-presence check
already covers it before `requireUser()` runs its own real check.

## UI/UX

**Export**

- Page header (`src/app/(app)/feeds/page.tsx`, next to the existing "New feed"
  link): a plain `<a href="/api/feeds/export">` styled with `buttonVariants()`.
  No JS needed — the browser's normal handling of an `attachment` response
  downloads the file without navigating away.
- Bulk action bar (`src/components/feeds/feeds-table.tsx`): a new
  non-destructive `"Export OPML"` `BulkAction`. Its `run()` builds
  `/api/feeds/export?ids=<selected ids>` and navigates to it (same
  no-navigation-away download behavior), then clears the selection — matching
  the existing "Update logo"/"Run aggregation" actions' behavior.

**Import** (`src/components/feeds/import-opml-button.tsx`, new, next to "New
feed")

1. A button opens a hidden `<input type="file" accept=".opml,.xml">`.
2. On file pick: read as text client-side (`FileReader`/`file.text()`), call
   `previewOpmlImport(content)` through `attempt()` (`@/lib/feeds/result`).
3. `errorKey` (unparseable file) → error toast, stop. No dialog opens.
4. Otherwise open a `Dialog` (`@/components/ui/dialog`) listing every entry —
   name, resolved aggregator label, tags, and a status badge (New / Duplicate
   / Invalid, with the `reason` shown for Invalid). Footer: Cancel, and
   "Import N feeds" (N = count of `new` entries; disabled when N is 0).
5. Confirm calls `importOpmlFeeds(content)` through `attempt()`, toasts
   `"Imported N feeds, skipped M"`, calls `router.refresh()`, closes the
   dialog.

No per-entry checkboxes in the preview — it's a review-and-confirm step, not a
selective-import UI (YAGNI unless a real need for partial import shows up).

## Catalog keys (new, under the `feeds` namespace in both `en.json`/`de.json`)

`exportOpml` (page-level link label), `bulkExportOpml`, `importOpml` (button
label), `invalidOpmlFile` (errorKey), `importPreviewTitle`,
`importStatusNew`/`importStatusDuplicate`/`importStatusInvalid`,
`importConfirm` (`{count}`), `importResult` (`{imported}`, `{skipped}`).

## Error handling

- Malformed/non-OPML file → `invalidOpmlFile` errorKey, surfaced before any
  dialog opens.
- Every entry gets a definite classification; nothing is silently dropped
  without appearing in the preview list.
- `importOpmlFeeds` re-validates from the raw content rather than trusting the
  client-held preview result, so a concurrent change (e.g. the same feed
  imported in another tab) is still caught.
- Both actions go through `attempt()` on the client, so a dropped
  connection/session-ended case behaves like every other feeds action
  (`src/lib/feeds/result.ts`).

## Testing

- `src/lib/feeds/opml.test.ts` (real functions, no I/O): encode→decode round
  trip preserves name/identifier/aggregator/options/tags/scheduling fields;
  decoding foreign OPML (no `yana:` attributes) yields entries with
  `aggregatorType` undefined; malformed XML throws; an `<outline>` cheerio
  can't parse is skipped rather than sinking the whole file.
- `src/lib/feeds/actions.test.ts` (existing file, real SQLite): `previewOpmlImport`
  classifies new/duplicate/invalid correctly, including the "declared but
  invalid `yana:options`" case; `importOpmlFeeds` creates feeds + tags,
  resolves existing tags by name, dedupes against existing feeds, enqueues a
  `feed.logo` job per created feed, and reports accurate imported/skipped
  counts.
- `src/app/api/feeds/export/route.test.ts` (new, real SQLite): exporting all
  feeds vs. a filtered `?ids=` list; a foreign user's id in `?ids=` is
  excluded; response headers (`Content-Type`, `Content-Disposition`).
- `src/components/feeds/import-opml-button.test.tsx` (jsdom): file picked →
  preview dialog renders entries with correct status badges; confirm calls
  `importOpmlFeeds` and shows the result toast; an unparseable file shows an
  error toast with no dialog.

## Out of scope

- Selective/partial import (checkboxes per entry in the preview).
- Import via URL (only local file upload).
- Any cross-user or admin-wide export.
- OPML `<outline>` nesting for tags/categories — tags are flattened to a
  `yana:tags` attribute per outline rather than nested folders, matching the
  iOS design's choice (a feed can have multiple tags, which doesn't map
  cleanly onto OPML's single-parent outline nesting).
