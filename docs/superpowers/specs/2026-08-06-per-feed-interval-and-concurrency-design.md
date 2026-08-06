# Per-feed update interval and concurrency

## Context

Two feed-scheduling knobs are currently global, hard-coded, or both:

- **Update interval.** `userSettings.updateIntervalMinutes` (Settings →
  Library) is one value applied to every feed a user owns. `scheduler.ts`'s
  `tick()` left-joins `feeds` against `userSettings` to read it.
- **Per-run concurrency.** `ARTICLE_ENRICHMENT_CONCURRENCY` (`concurrency.ts`)
  is a single constant (`4`), used by every aggregator that overlaps
  per-article enrichment I/O (`website.ts`, `youtube/aggregator.ts`,
  `reddit/aggregator.ts`).

This surfaced as a real problem investigating a failing job for the
`caschys_blog` feed: the destination (`stadt-bremerhaven.de`) is refusing
connections from this server's IP outright (TCP RST at connect time, confirmed
independent of Node/undici), most likely a bot-abuse block triggered by
repeated automated polling. A global one-size-fits-all interval and
concurrency gives no way to poll a sensitive source more gently without also
slowing down every other feed.

## Goal

Make both knobs configurable **per feed**, with each aggregator declaring a
recommended starting point so a newly created feed isn't left to guess.

## Data model

Two new columns on `feeds`, following the exact pattern `dailyLimit` already
uses (a plain, always-present, per-feed integer column — not part of the
JSON `options` blob):

- `updateIntervalMinutes: integer, not null, default 30` — minutes between
  automatic aggregation runs. `0` disables automatic updates for that feed
  (same meaning the global setting has today, now per-feed).
- `concurrency: integer, not null, default 4` — max in-flight per-article
  enrichment calls during one aggregation run.

The defaults (`30` / `4`) match today's global values, so existing feeds keep
their current behavior after migration; they are **not** backfilled from
their aggregator's recommendation (consistent with how this repo treats other
additive-column migrations — new behavior applies going forward, not
retroactively).

`userSettings.updateIntervalMinutes` is dropped. It becomes dead the moment
every feed carries its own value.

## Aggregator recommendations

`AggregatorSpec` (`src/lib/aggregators/specs.ts`, the client-safe half of the
registry) gains two plain fields:

```ts
recommendedIntervalMinutes: number;
recommendedConcurrency: number;
```

Three tiers, applied to all 16 aggregators:

| Tier | Interval | Concurrency | Aggregators |
|---|---|---|---|
| News/articles | 30 min | 4 | `full_website`, `feed_content`, `heise`, `merkur`, `tagesschau`, `mactechnews`, `mein_mmo`, `the_verge`, `ars_technica` |
| Comics/infrequent | 1440 min (daily) | 4 | `explosm`, `dark_legacy`, `oglaf`, `podcast` |
| Sensitive/rate-limited | 60 min | 2 | `caschys_blog`, `youtube`, `reddit` |

These are starting points, not enforced limits — nothing in the schema or
validation ties a feed's actual value to its aggregator's recommendation
after creation.

## UI (`feed-form.tsx`)

Two new number inputs, "Update interval (minutes)" and "Concurrency",
rendered near the existing options card. They:

- Pre-fill from `spec.recommendedIntervalMinutes` /
  `spec.recommendedConcurrency` when creating a new feed, and are reset to the
  new aggregator's recommendation on aggregator switch — the same moment
  `handleAggregatorChange` already resets `options` today.
- Are freely editable afterward, including on the edit form, where they
  initialize from the feed's own stored values (not re-derived from the
  spec).
- Validate: interval `0`–`1440`, concurrency `1`–`10` (zod, in
  `createFeed`/`updateFeed`, same place `options` are validated today).

## Runtime wiring

- **Scheduler (`scheduler.ts`).** Drop the `userSettings` left-join entirely;
  `tick()` reads `feeds.updateIntervalMinutes` directly. No more `?? 30`
  fallback — the column is `NOT NULL` with its own default.
- **Aggregator base (`base.ts`).** `FeedLike` gains `concurrency: number`;
  `BaseAggregator`'s constructor gains `this.concurrency = feed.concurrency ??
  4`, mirroring `this.dailyLimit = feed.dailyLimit ?? 20` immediately above
  it.
- **The five `ARTICLE_ENRICHMENT_CONCURRENCY` call sites** (`website.ts:150`,
  `youtube/aggregator.ts:247`, `reddit/aggregator.ts:350` and `:400`) switch
  from the imported constant to `this.concurrency`. The constant itself is
  removed from `concurrency.ts` along with its now-unused import in those
  three files.

## Removal

Everything that exists only to serve the global setting goes with it:

- `userSettings.updateIntervalMinutes` column (migration drop).
- The interval control in `LibrarySection`/`LibrarySectionShell`
  (`src/components/settings/library-section.tsx`) and its prop.
- The `updateIntervalMinutes` field in `updateLibrarySettings`'s zod schema
  and its `errorKey` entry (`src/lib/settings/actions.ts`).
- The `settings.library.interval`, `settings.library.intervalHelp`,
  `settings.library.minutes`, and `settings.library.intervalRange` catalog
  keys in both `messages/en.json` and `messages/de.json`.
- The `updateIntervalMinutes` prop passed from `settings/page.tsx`.

`articleRetentionDays` and the rest of the Library section are untouched.

## Migration ordering

`feeds` only gains columns; `userSettings` only loses one. Different tables,
so `drizzle-kit generate` needs no interactive prompt and this is a single
migration.

## Testing

- `scheduler.test.ts`: update fixtures to set `feeds.updateIntervalMinutes`
  directly instead of going through `userSettings`; drop any case that
  exercised the join/fallback.
- `base.test.ts`: cover `this.concurrency` defaulting the same way the
  existing `dailyLimit` default is covered.
- `feeds/actions.test.ts` (or wherever `createFeed`/`updateFeed` are tested):
  cover the two new fields' validation bounds and that omitting them on
  update leaves the stored value alone (same `undefined`-means-unchanged
  convention documented for other `FeedInput` fields).
- `feed-form.test.tsx` (if one exists) or a new one: aggregator switch resets
  both fields to the new spec's recommendation.
- `messages/messages.test.ts` already enforces catalog parity — removing keys
  from both files together keeps it green.
