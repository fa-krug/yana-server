# Per-Feed Update Interval and Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each feed's aggregation interval and enrichment concurrency independently configurable, with per-aggregator recommended starting values, replacing today's single global interval setting and single hard-coded concurrency constant.

**Architecture:** Two new `NOT NULL` integer columns on `feeds` (`updateIntervalMinutes`, `concurrency`), following the exact pattern the existing `dailyLimit` column already uses. `AggregatorSpec` gains two plain recommendation fields the feed form reads to pre-fill new feeds. `userSettings.updateIntervalMinutes` and its Settings UI are removed.

**Tech Stack:** Next.js 16, Drizzle ORM (SQLite via better-sqlite3), Zod, Vitest.

## Global Constraints

- Line length 100, double quotes, semicolons, trailing commas (Prettier).
- Every write goes through `writeTransaction()` — never a bare `db.update()`/`db.insert()` outside one.
- Every user-facing string comes from `messages/en.json` **and** `messages/de.json`, with identical key sets in both.
- No CHECK constraint on the two new columns: they have no Django ancestor (same reasoning `schema/auth.ts` already documents for why it carries none).
- `undefined` on a `FeedInput` field means "not submitted, leave stored value alone" — never collapse it to a default before the `.set()` call (see the `identifier`/`options` comments already in `updateFeed`).
- Run `npm run lint && npm run format:check && npm run typecheck && npm test` before considering any task done.

---

### Task 1: Schema — add `feeds` columns, drop `userSettings` column, generate migration

**Files:**
- Modify: `src/lib/db/schema/feeds.ts:43-97` (the `feeds` table definition)
- Modify: `src/lib/db/schema/users.ts:72-87` (the `userSettings` table definition)
- Create: `drizzle/00NN_<generated>.sql` and its `drizzle/meta/` entries (via `drizzle-kit generate`, not by hand)

**Interfaces:**
- Produces: `feeds.updateIntervalMinutes: number` (NOT NULL, default 30), `feeds.concurrency: number` (NOT NULL, default 4) — both on `Feed`/`NewFeed` (`typeof feeds.$inferSelect` / `$inferInsert`), consumed by Tasks 3, 4, 5, 6.
- Produces: `userSettings` no longer has `updateIntervalMinutes` — consumed (as a removal) by Task 7.

- [ ] **Step 1: Add the two columns to `feeds`**

In `src/lib/db/schema/feeds.ts`, add the two columns right after `dailyLimit`:

```ts
    dailyLimit: integer("daily_limit").notNull().default(20),
    /**
     * Minutes between automatic aggregation runs for this feed. `0` disables
     * automatic updates entirely (see `src/lib/jobs/scheduler.ts`'s `tick()`).
     * Pre-filled from the aggregator's `recommendedIntervalMinutes` when a
     * feed is created (`src/lib/aggregators/specs.ts`), freely editable
     * afterward -- a recommendation, not an enforced limit.
     */
    updateIntervalMinutes: integer("update_interval_minutes").notNull().default(30),
    /**
     * Max in-flight per-article enrichment calls (header image extraction,
     * full-page fetch, comment fetches) during one aggregation run. Was the
     * hard-coded `ARTICLE_ENRICHMENT_CONCURRENCY` constant; now per-feed, with
     * the same pre-fill-from-recommendation behavior as `updateIntervalMinutes`.
     */
    concurrency: integer("concurrency").notNull().default(4),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
```

- [ ] **Step 2: Drop `updateIntervalMinutes` from `userSettings`**

In `src/lib/db/schema/users.ts`, remove this line (and only this line) from the `userSettings` table:

```ts
    articleRetentionDays: integer("article_retention_days").notNull().default(60),
    updateIntervalMinutes: integer("update_interval_minutes").notNull().default(30),
```

becomes:

```ts
    articleRetentionDays: integer("article_retention_days").notNull().default(60),
```

Also update the table's doc comment two lines above, which currently reads:

```ts
/**
 * Per-user credentials and preferences.
 *
 * Grows four columns beyond the Django model, for phase 3's settings tab:
 * theme, language, articleRetentionDays and updateIntervalMinutes. Retention is
 * currently a job kwarg rather than a setting; this promotes it.
 */
```

to:

```ts
/**
 * Per-user credentials and preferences.
 *
 * Grows three columns beyond the Django model, for phase 3's settings tab:
 * theme, language and articleRetentionDays. Retention is currently a job
 * kwarg rather than a setting; this promotes it. `updateIntervalMinutes` was
 * a fourth (phase 3) but moved to a per-feed column on `feeds` -- see
 * docs/superpowers/specs/2026-08-06-per-feed-interval-and-concurrency-design.md.
 */
```

- [ ] **Step 3: Generate the migration**

Run:

```bash
npx drizzle-kit generate
```

`feeds` only gains columns and `userSettings` only loses one -- different tables, so this does not hit the "gains and loses columns in the same table" interactive-prompt case documented in CLAUDE.md, and should generate non-interactively into a new `drizzle/00NN_<name>.sql` plus updated `drizzle/meta/_journal.json` and `drizzle/meta/00NN_snapshot.json`.

Expected: command exits 0, a new numbered `.sql` file appears under `drizzle/`, and it contains both an `ALTER TABLE feeds ADD COLUMN` pair and a table-rebuild (or `ALTER TABLE ... DROP COLUMN`) for `user_settings`'s dropped column. Read the generated SQL file to confirm both changes are present before moving on.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: FAIL — every place that reads/writes `userSettings.updateIntervalMinutes` (scheduler.ts, settings/actions.ts, library-section.tsx, settings/page.tsx, scheduler.test.ts) is now a type error. This is expected; those are fixed in Tasks 4 and 7. Confirm the errors are all in those files and nowhere else.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema/feeds.ts src/lib/db/schema/users.ts drizzle/
git commit -m "feat(db): add per-feed update interval and concurrency columns"
```

---

### Task 2: Aggregator recommendations — `AggregatorSpec.recommendedIntervalMinutes` / `recommendedConcurrency`

**Files:**
- Modify: `src/lib/aggregators/specs.ts`
- Test: `src/lib/aggregators/registry.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `AggregatorSpec.recommendedIntervalMinutes: number`, `AggregatorSpec.recommendedConcurrency: number` on every entry in `AGGREGATOR_SPECS` — consumed by Task 6 (feed form pre-fill).

- [ ] **Step 1: Write the failing test**

Add to `src/lib/aggregators/registry.test.ts` (alongside the other `AGGREGATOR_SPECS`-shape assertions already there):

```ts
import { AGGREGATOR_SPECS } from "./specs";

it("gives every aggregator a recommended interval and concurrency", () => {
  for (const spec of Object.values(AGGREGATOR_SPECS)) {
    expect(spec.recommendedIntervalMinutes).toBeGreaterThan(0);
    expect(spec.recommendedConcurrency).toBeGreaterThanOrEqual(1);
  }
});

it("recommends a gentler interval and lower concurrency for rate-sensitive sources", () => {
  for (const key of ["caschys_blog", "youtube", "reddit"] as const) {
    expect(AGGREGATOR_SPECS[key].recommendedIntervalMinutes).toBe(60);
    expect(AGGREGATOR_SPECS[key].recommendedConcurrency).toBe(2);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/aggregators/registry.test.ts -t "recommended"`
Expected: FAIL — `recommendedIntervalMinutes`/`recommendedConcurrency` are `undefined` on every spec.

- [ ] **Step 3: Add the two fields to the `AggregatorSpec` type**

In `src/lib/aggregators/specs.ts`, extend the type (around line 26):

```ts
export type AggregatorSpec = {
  key: AggregatorKey;
  label: string;
  /**
   * Starting point for a new feed's `updateIntervalMinutes`/`concurrency`
   * columns (`src/lib/db/schema/feeds.ts`) -- pre-filled by the feed form on
   * create and on aggregator switch, freely editable afterward. Three tiers:
   * 30 min / concurrency 4 for frequently-updated article sources, 1440 min
   * (daily) / concurrency 4 for infrequent comics/podcasts, and 60 min /
   * concurrency 2 for sources known to be rate- or quota-sensitive --
   * `caschys_blog` earned its tier the hard way: its host started refusing
   * connections from this server's IP after repeated automated polling (see
   * docs/superpowers/specs/2026-08-06-per-feed-interval-and-concurrency-design.md).
   */
  recommendedIntervalMinutes: number;
  recommendedConcurrency: number;
  identifierRequired: boolean;
  identifierLabel: string;
  identifierHelp: string;
```

- [ ] **Step 4: Add the two fields to all 16 entries in `AGGREGATOR_SPECS`**

For each entry, insert `recommendedIntervalMinutes` and `recommendedConcurrency` right after `label`. Apply exactly these 16 edits in `src/lib/aggregators/specs.ts`:

```ts
  full_website: {
    key: "full_website",
    label: "Full Website",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
```

```ts
  feed_content: {
    key: "feed_content",
    label: "Feed Content",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
```

```ts
  heise: {
    key: "heise",
    label: "Heise",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
```

```ts
  merkur: {
    key: "merkur",
    label: "Merkur",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
```

```ts
  tagesschau: {
    key: "tagesschau",
    label: "Tagesschau",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
```

```ts
  explosm: {
    key: "explosm",
    label: "Explosm",
    recommendedIntervalMinutes: 1440,
    recommendedConcurrency: 4,
    identifierRequired: false,
```

```ts
  dark_legacy: {
    key: "dark_legacy",
    label: "Dark Legacy Comics",
    recommendedIntervalMinutes: 1440,
    recommendedConcurrency: 4,
    identifierRequired: false,
```

```ts
  caschys_blog: {
    key: "caschys_blog",
    label: "Caschys Blog",
    recommendedIntervalMinutes: 60,
    recommendedConcurrency: 2,
    identifierRequired: false,
```

```ts
  mactechnews: {
    key: "mactechnews",
    label: "MacTechNews",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
```

```ts
  oglaf: {
    key: "oglaf",
    label: "Oglaf",
    recommendedIntervalMinutes: 1440,
    recommendedConcurrency: 4,
    identifierRequired: false,
```

```ts
  mein_mmo: {
    key: "mein_mmo",
    label: "Mein MMO",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
```

```ts
  the_verge: {
    key: "the_verge",
    label: "The Verge",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
```

```ts
  ars_technica: {
    key: "ars_technica",
    label: "Ars Technica",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
```

```ts
  youtube: {
    key: "youtube",
    label: "YouTube",
    recommendedIntervalMinutes: 60,
    recommendedConcurrency: 2,
    identifierRequired: true,
```

```ts
  reddit: {
    key: "reddit",
    label: "Reddit",
    recommendedIntervalMinutes: 60,
    recommendedConcurrency: 2,
    identifierRequired: true,
```

```ts
  podcast: {
    key: "podcast",
    label: "Podcast",
    recommendedIntervalMinutes: 1440,
    recommendedConcurrency: 4,
    identifierRequired: false,
```

- [ ] **Step 5: Run typecheck and the test**

Run: `npm run typecheck && npx vitest run src/lib/aggregators/registry.test.ts`
Expected: both PASS. If typecheck still fails on `specs.ts` itself, an entry is missing one of the two fields — every entry in `AGGREGATOR_SPECS` must satisfy `Record<AggregatorKey, AggregatorSpec>`, so a missing field is a compile error naming the aggregator key.

- [ ] **Step 6: Commit**

```bash
git add src/lib/aggregators/specs.ts src/lib/aggregators/registry.test.ts
git commit -m "feat(aggregators): add recommended interval/concurrency per aggregator"
```

---

### Task 3: Wire per-feed concurrency into `BaseAggregator` and its three consumers

**Files:**
- Modify: `src/lib/aggregators/base.ts`
- Modify: `src/lib/aggregators/concurrency.ts`
- Modify: `src/lib/aggregators/website.ts:4,148-151`
- Modify: `src/lib/aggregators/sites/youtube/aggregator.ts:10,247`
- Modify: `src/lib/aggregators/sites/reddit/aggregator.ts:9,348-350,398-400`
- Test: `src/lib/aggregators/base.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1/2 directly (this task only touches runtime code; `feed.concurrency` will exist on real rows once Task 1's migration runs, but `FeedLike` is a structural interface so this task's own test fixtures supply it directly).
- Produces: `BaseAggregator.concurrency: number` (defaults to `4` when a `FeedLike` omits it) — nothing later depends on this beyond the feed actually reading its stored column at runtime, already covered by Task 1's schema.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/aggregators/base.test.ts`, next to the existing `dailyLimit` tests:

```ts
it("defaults concurrency to 4 when the feed omits it", () => {
  const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
  const agg = new TestAggregator(feed);
  expect(agg.concurrency).toBe(4);
});

it("uses the feed's own concurrency when set", () => {
  const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20, concurrency: 2 };
  const agg = new TestAggregator(feed);
  expect(agg.concurrency).toBe(2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/aggregators/base.test.ts -t "concurrency"`
Expected: FAIL — `agg.concurrency` is `undefined` (property doesn't exist yet).

- [ ] **Step 3: Add `concurrency` to `FeedLike` and `BaseAggregator`**

In `src/lib/aggregators/base.ts`:

```ts
export interface FeedLike {
  identifier: string;
  dailyLimit: number;
  concurrency?: number;
  aggregator?: string;
```

```ts
  public identifier: string;
  public dailyLimit: number;
  public concurrency: number;
  public usesFirstContentMatch = false;

  constructor(public feed: FeedLike) {
    this.identifier = feed.identifier || "";
    this.dailyLimit = feed.dailyLimit ?? 20;
    this.concurrency = feed.concurrency ?? 4;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/aggregators/base.test.ts -t "concurrency"`
Expected: PASS

- [ ] **Step 5: Remove the global constant and switch its five call sites to `this.concurrency`**

In `src/lib/aggregators/concurrency.ts`, delete the constant and its doc comment (keep `mapWithConcurrency` itself):

```ts
/** Per-feed cap on in-flight per-article enrichment calls (header image
 * extraction, full-page fetch, comment fetches). Chosen to overlap I/O
 * substantially while staying polite to source sites -- see the aggregation
 * performance investigation this constant came out of. */
export const ARTICLE_ENRICHMENT_CONCURRENCY = 4;
```

is deleted entirely (no replacement -- `BaseAggregator.concurrency`, defaulting to `4`, is the one place that constant now lives).

In `src/lib/aggregators/website.ts`, change:

```ts
import { ARTICLE_ENRICHMENT_CONCURRENCY, mapWithConcurrency } from "./concurrency";
```

to:

```ts
import { mapWithConcurrency } from "./concurrency";
```

and change:

```ts
    const results = await mapWithConcurrency(
      articles,
      ARTICLE_ENRICHMENT_CONCURRENCY,
      async (article): Promise<RawArticle | null> => {
```

to:

```ts
    const results = await mapWithConcurrency(
      articles,
      this.concurrency,
      async (article): Promise<RawArticle | null> => {
```

In `src/lib/aggregators/sites/youtube/aggregator.ts`, change:

```ts
import { ARTICLE_ENRICHMENT_CONCURRENCY, mapWithConcurrency } from "../../concurrency";
```

to:

```ts
import { mapWithConcurrency } from "../../concurrency";
```

and change:

```ts
    await mapWithConcurrency(articles, ARTICLE_ENRICHMENT_CONCURRENCY, async (article) => {
```

to:

```ts
    await mapWithConcurrency(articles, this.concurrency, async (article) => {
```

In `src/lib/aggregators/sites/reddit/aggregator.ts`, change:

```ts
import { ARTICLE_ENRICHMENT_CONCURRENCY, mapWithConcurrency } from "../../concurrency";
```

to:

```ts
import { mapWithConcurrency } from "../../concurrency";
```

and change the first call site:

```ts
    const results = await mapWithConcurrency(
      articles,
      ARTICLE_ENRICHMENT_CONCURRENCY,
      async (article): Promise<RawArticle | null> => {
```

to:

```ts
    const results = await mapWithConcurrency(
      articles,
      this.concurrency,
      async (article): Promise<RawArticle | null> => {
```

and the second call site:

```ts
    return mapWithConcurrency(
      processedArticles,
      ARTICLE_ENRICHMENT_CONCURRENCY,
      async (article): Promise<RawArticle> => {
```

to:

```ts
    return mapWithConcurrency(
      processedArticles,
      this.concurrency,
      async (article): Promise<RawArticle> => {
```

- [ ] **Step 6: Run the full aggregator test suite and typecheck**

Run: `npm run typecheck && npx vitest run src/lib/aggregators/`
Expected: PASS. If `ARTICLE_ENRICHMENT_CONCURRENCY` is still imported anywhere, typecheck will name the file.

- [ ] **Step 7: Commit**

```bash
git add src/lib/aggregators/base.ts src/lib/aggregators/base.test.ts src/lib/aggregators/concurrency.ts src/lib/aggregators/website.ts src/lib/aggregators/sites/youtube/aggregator.ts src/lib/aggregators/sites/reddit/aggregator.ts
git commit -m "feat(aggregators): read enrichment concurrency from the feed, not a global constant"
```

---

### Task 4: Scheduler reads `feeds.updateIntervalMinutes` directly

**Files:**
- Modify: `src/lib/jobs/scheduler.ts:1-135`
- Test: `src/lib/jobs/scheduler.test.ts`

**Interfaces:**
- Consumes: `feeds.updateIntervalMinutes` (Task 1).
- Produces: nothing later depends on.

- [ ] **Step 1: Update the existing "never enqueues when interval is 0" test to set the feed's own column**

In `src/lib/jobs/scheduler.test.ts`, replace the `userSettings`-based test body:

```ts
  it("never enqueues an aggregate job when updateIntervalMinutes is 0", async () => {
    let feedId = 0;
    client.writeTransaction((db) => {
      let user = db.select().from(schema.users).limit(1).get();
      if (!user) {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        user = db.select().from(schema.users).limit(1).get();
      }

      db.insert(schema.userSettings)
        .values({ userId: user!.id, updateIntervalMinutes: 0 })
        .onConflictDoUpdate({
          target: schema.userSettings.userId,
          set: { updateIntervalMinutes: 0 },
        })
        .run();

      const inserted = db
        .insert(schema.feeds)
        .values({
          name: "Test Feed",
          aggregator: "full_website",
          userId: user!.id,
          enabled: true,
        })
        .returning({ id: schema.feeds.id })
        .get();
      feedId = inserted.id;

      // Long overdue by any positive interval -- still must not fire.
      const longAgoSec = Math.floor((Date.now() - 30 * 24 * 3_600_000) / 1000);
      db.run(sql`UPDATE feeds SET updated_at = ${longAgoSec} WHERE id = ${feedId}`);
    });

    await scheduler.tick();

    const { jobs: jobList } = queue.listJobs({ kind: "aggregate" });
    expect(jobList.length).toBe(0);
  });
```

with:

```ts
  it("never enqueues an aggregate job when the feed's updateIntervalMinutes is 0", async () => {
    let feedId = 0;
    client.writeTransaction((db) => {
      let user = db.select().from(schema.users).limit(1).get();
      if (!user) {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        user = db.select().from(schema.users).limit(1).get();
      }

      const inserted = db
        .insert(schema.feeds)
        .values({
          name: "Test Feed",
          aggregator: "full_website",
          userId: user!.id,
          enabled: true,
          updateIntervalMinutes: 0,
        })
        .returning({ id: schema.feeds.id })
        .get();
      feedId = inserted.id;

      // Long overdue by any positive interval -- still must not fire.
      const longAgoSec = Math.floor((Date.now() - 30 * 24 * 3_600_000) / 1000);
      db.run(sql`UPDATE feeds SET updated_at = ${longAgoSec} WHERE id = ${feedId}`);
    });

    await scheduler.tick();

    const { jobs: jobList } = queue.listJobs({ kind: "aggregate" });
    expect(jobList.length).toBe(0);
  });
```

Also add a new test proving two feeds on different intervals are treated independently:

```ts
  it("respects each feed's own interval independently", async () => {
    let dueFeedId = 0;
    let notDueFeedId = 0;
    client.writeTransaction((db) => {
      let user = db.select().from(schema.users).limit(1).get();
      if (!user) {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        user = db.select().from(schema.users).limit(1).get();
      }

      const due = db
        .insert(schema.feeds)
        .values({
          name: "Due Feed",
          aggregator: "full_website",
          userId: user!.id,
          enabled: true,
          updateIntervalMinutes: 30,
        })
        .returning({ id: schema.feeds.id })
        .get();
      dueFeedId = due.id;

      const notDue = db
        .insert(schema.feeds)
        .values({
          name: "Not Due Feed",
          aggregator: "full_website",
          userId: user!.id,
          enabled: true,
          updateIntervalMinutes: 1440,
        })
        .returning({ id: schema.feeds.id })
        .get();
      notDueFeedId = notDue.id;

      // Both updated an hour ago: overdue for the 30-minute feed, not for the
      // 1440-minute (daily) one.
      const oneHourAgoSec = Math.floor((Date.now() - 3_600_000) / 1000);
      db.run(sql`UPDATE feeds SET updated_at = ${oneHourAgoSec} WHERE id IN (${dueFeedId}, ${notDueFeedId})`);
    });

    await scheduler.tick();

    const { jobs: jobList } = queue.listJobs({ kind: "aggregate" });
    expect(jobList.map((j) => j.payload)).toEqual([{ feedId: dueFeedId }]);
    expect(jobList.some((j) => j.payload?.feedId === notDueFeedId)).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/jobs/scheduler.test.ts`
Expected: FAIL — `schema.feeds` insert rejects the unknown `updateIntervalMinutes` column (it doesn't exist as a Drizzle field yet from this file's point of view until Task 1 lands, but Task 1 already ran, so this should actually be a runtime pass/fail on `tick()`'s current userSettings-join logic, which still expects the removed column). Confirm the two new/changed tests fail for the reason described, not a syntax error.

- [ ] **Step 3: Rewrite `tick()` to read the feed's own column**

In `src/lib/jobs/scheduler.ts`, replace:

```ts
import { and, eq, gte } from "drizzle-orm";

import { writeTransaction } from "../db/client";
import { feeds, jobs, userSettings } from "../db/schema";
```

with:

```ts
import { and, eq, gte } from "drizzle-orm";

import { writeTransaction } from "../db/client";
import { feeds, jobs } from "../db/schema";
```

and replace the query and interval read inside `tick()`:

```ts
    const activeFeeds = db
      .select({
        feedId: feeds.id,
        userId: feeds.userId,
        updatedAt: feeds.updatedAt,
        updateIntervalMinutes: userSettings.updateIntervalMinutes,
      })
      .from(feeds)
      .leftJoin(userSettings, eq(feeds.userId, userSettings.userId))
      .where(eq(feeds.enabled, true))
      .all();
```

with:

```ts
    const activeFeeds = db
      .select({
        feedId: feeds.id,
        userId: feeds.userId,
        updatedAt: feeds.updatedAt,
        updateIntervalMinutes: feeds.updateIntervalMinutes,
      })
      .from(feeds)
      .where(eq(feeds.enabled, true))
      .all();
```

and replace:

```ts
      const intervalMinutes = item.updateIntervalMinutes ?? 30;
```

with:

```ts
      const intervalMinutes = item.updateIntervalMinutes;
```

(the column is `NOT NULL` with its own default now, so the `?? 30` fallback -- which existed only because the old left-join could produce a null -- is dead code once the join is gone).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/jobs/scheduler.test.ts`
Expected: PASS — all tests in the file, not just the two touched.

- [ ] **Step 5: Commit**

```bash
git add src/lib/jobs/scheduler.ts src/lib/jobs/scheduler.test.ts
git commit -m "feat(scheduler): read each feed's own update interval instead of a global setting"
```

---

### Task 5: `createFeed`/`updateFeed` accept and validate `updateIntervalMinutes`/`concurrency`

**Files:**
- Modify: `src/lib/feeds/actions.ts:158-256,258-367`
- Test: `src/lib/feeds/actions.test.ts`

**Interfaces:**
- Consumes: `feeds.updateIntervalMinutes`/`feeds.concurrency` (Task 1), `AggregatorSpec.recommendedIntervalMinutes`/`recommendedConcurrency` (Task 2, used only by the caller/UI, not by this task).
- Produces: `FeedInput.updateIntervalMinutes?: number`, `FeedInput.concurrency?: number` — consumed by Task 6 (the form submits these fields).

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/feeds/actions.test.ts` (inside the existing `describe("createFeed", ...)` block or a sibling `describe`, following the file's existing setup with `seedUser`/`requestAs`):

```ts
it("stores updateIntervalMinutes and concurrency on create", async () => {
  const userId = await seedUser({ email: "interval@example.com" });
  requestAs(await signInCookie(auth, "interval@example.com", PASSWORD));

  const result = await actions.createFeed({
    name: "Interval Feed",
    aggregator: "full_website",
    updateIntervalMinutes: 15,
    concurrency: 2,
  });
  expect(result.ok).toBe(true);

  const row = client
    .getDb()
    .select()
    .from((await import("@/lib/db/schema")).feeds)
    .where(eq((await import("@/lib/db/schema")).feeds.id, (result as { id: number }).id))
    .get();
  expect(row?.updateIntervalMinutes).toBe(15);
  expect(row?.concurrency).toBe(2);
  void userId;
});

it("rejects an update interval outside 0-1440", async () => {
  await seedUser({ email: "badinterval@example.com" });
  requestAs(await signInCookie(auth, "badinterval@example.com", PASSWORD));

  const result = await actions.createFeed({
    name: "Bad Interval Feed",
    aggregator: "full_website",
    updateIntervalMinutes: 1441,
  });
  expect(result.ok).toBe(false);
});

it("rejects concurrency outside 1-10", async () => {
  await seedUser({ email: "badconcurrency@example.com" });
  requestAs(await signInCookie(auth, "badconcurrency@example.com", PASSWORD));

  const result = await actions.createFeed({
    name: "Bad Concurrency Feed",
    aggregator: "full_website",
    concurrency: 0,
  });
  expect(result.ok).toBe(false);
});

it("leaves updateIntervalMinutes and concurrency unchanged when omitted on update", async () => {
  const userId = await seedUser({ email: "keepinterval@example.com" });
  requestAs(await signInCookie(auth, "keepinterval@example.com", PASSWORD));

  const created = await actions.createFeed({
    name: "Keep Interval Feed",
    aggregator: "full_website",
    updateIntervalMinutes: 45,
    concurrency: 3,
  });
  const feedId = (created as { id: number }).id;

  const updated = await actions.updateFeed(feedId, { name: "Renamed" });
  expect(updated.ok).toBe(true);

  const row = client
    .getDb()
    .select()
    .from((await import("@/lib/db/schema")).feeds)
    .where(eq((await import("@/lib/db/schema")).feeds.id, feedId))
    .get();
  expect(row?.updateIntervalMinutes).toBe(45);
  expect(row?.concurrency).toBe(3);
  void userId;
});
```

Add `eq` to the file's existing `import { eq } from "drizzle-orm";` if not already imported (it already is, per the file's current top-of-file imports).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/feeds/actions.test.ts -t "updateIntervalMinutes"`
Expected: FAIL — `createFeed` currently ignores both fields entirely (they're not in `FeedInput` and not written on insert), so the first test's `row?.updateIntervalMinutes` is the schema default (`30`), not `15`; the two validation tests currently succeed (`ok: true`) because nothing validates the fields yet.

- [ ] **Step 3: Extend `FeedInput` and add validation**

In `src/lib/feeds/actions.ts`, add `z` to imports:

```ts
import { and, eq, inArray, count, desc, asc, like } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
```

Add a shared schema near the top of the file, right after the `activeProvider`/`capabilitiesFor` block:

```ts
// 0 disables automatic updates for the feed (see scheduler.ts's tick());
// everything above that is a whole number of minutes. Concurrency bounds are
// a sanity range, not derived from anything -- 1 means "no overlap", 10 is
// comfortably above every aggregator's recommended value in specs.ts.
const schedulingSchema = z.object({
  updateIntervalMinutes: z.number().int().min(0).max(1440).optional(),
  concurrency: z.number().int().min(1).max(10).optional(),
});
```

Extend `FeedInput`:

```ts
type FeedInput = {
  name?: string;
  aggregator?: string;
  identifier?: string;
  options?: Record<string, unknown>;
  tagIds?: number[];
  enabled?: boolean;
  updateIntervalMinutes?: number;
  concurrency?: number;
};
```

In `createFeed`, after the existing `optionsParsed` check and before `const capabilities = await capabilitiesFor();`:

```ts
    const schedulingParsed = schedulingSchema.safeParse({
      updateIntervalMinutes: input?.updateIntervalMinutes,
      concurrency: input?.concurrency,
    });
    if (!schedulingParsed.success) {
      return { ok: false, error: "Invalid scheduling configuration" };
    }
```

and in the `.insert(feeds).values({...})` call, add the two fields (only when provided, so an omitted field falls back to the column's own default rather than to `undefined` overwriting it — Drizzle drops `undefined` keys from an insert the same way it does from an update):

```ts
      const feed = tx
        .insert(feeds)
        .values({
          name: name as string,
          aggregator: spec.key,
          identifier,
          options: cleanedOptions,
          userId,
          ...(schedulingParsed.data.updateIntervalMinutes !== undefined && {
            updateIntervalMinutes: schedulingParsed.data.updateIntervalMinutes,
          }),
          ...(schedulingParsed.data.concurrency !== undefined && {
            concurrency: schedulingParsed.data.concurrency,
          }),
        })
        .returning({ id: feeds.id })
        .get();
```

In `updateFeed`, after the existing `submittedOptions`/`capabilities` block and before the `writeTransaction` call:

```ts
  const schedulingParsed = schedulingSchema.safeParse({
    updateIntervalMinutes: input?.updateIntervalMinutes,
    concurrency: input?.concurrency,
  });
  if (!schedulingParsed.success) {
    return { ok: false, error: "Invalid scheduling configuration" };
  }
```

and in the `.update(feeds).set({...})` call, add:

```ts
    tx.update(feeds)
      .set({
        ...(name !== undefined && { name }),
        ...(aggregator !== undefined && { aggregator: spec.key }),
        ...(identifier !== undefined && { identifier }),
        ...(cleanedOptions !== undefined && { options: cleanedOptions }),
        ...(enabled !== undefined && { enabled }),
        ...(schedulingParsed.data.updateIntervalMinutes !== undefined && {
          updateIntervalMinutes: schedulingParsed.data.updateIntervalMinutes,
        }),
        ...(schedulingParsed.data.concurrency !== undefined && {
          concurrency: schedulingParsed.data.concurrency,
        }),
      })
      .where(and(eq(feeds.id, id), eq(feeds.userId, userId)))
      .run();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/feeds/actions.test.ts`
Expected: PASS — every test in the file, not just the four new ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/feeds/actions.ts src/lib/feeds/actions.test.ts
git commit -m "feat(feeds): validate and persist per-feed update interval and concurrency"
```

---

### Task 6: Feed form UI — editable interval/concurrency, pre-filled from the aggregator's recommendation

**Files:**
- Modify: `src/components/feeds/feed-form.tsx`
- Modify: `messages/en.json` (`feeds.form`)
- Modify: `messages/de.json` (`feeds.form`)
- Test: `src/components/feeds/feed-form.test.tsx`

**Interfaces:**
- Consumes: `AggregatorSpec.recommendedIntervalMinutes`/`recommendedConcurrency` (Task 2), `Feed.updateIntervalMinutes`/`concurrency` (Task 1), `createFeed`/`updateFeed` accepting the two fields (Task 5).
- Produces: nothing later depends on.

- [ ] **Step 1: Add catalog keys**

In `messages/en.json`, inside `feeds.form` (after `"options": "Options",`):

```json
      "options": "Options",
      "updateInterval": "Update interval (minutes)",
      "updateIntervalHelp": "How often this feed is checked for new articles. 0 disables automatic updates.",
      "concurrency": "Concurrency",
      "concurrencyHelp": "How many articles this feed fetches in parallel during one run.",
      "create": "Create feed",
```

In `messages/de.json`, inside `feeds.form` (after `"options": "Optionen",`):

```json
      "options": "Optionen",
      "updateInterval": "Aktualisierungsintervall (Minuten)",
      "updateIntervalHelp": "Wie oft dieser Feed auf neue Artikel geprüft wird. Mit 0 werden automatische Aktualisierungen deaktiviert.",
      "concurrency": "Parallelität",
      "concurrencyHelp": "Wie viele Artikel dieser Feed während eines Laufs parallel abruft.",
      "create": "Feed anlegen",
```

- [ ] **Step 2: Write the failing test**

Add to `src/components/feeds/feed-form.test.tsx`:

```ts
it("pre-fills the recommended interval and concurrency for the selected aggregator", () => {
  renderWithProviders(<FeedForm capabilities={ALL} allTags={[]} />);
  selectAggregator("Caschys Blog");
  expect(screen.getByLabelText("Update interval (minutes)")).toHaveValue(60);
  expect(screen.getByLabelText("Concurrency")).toHaveValue(2);

  selectAggregator("Full Website");
  expect(screen.getByLabelText("Update interval (minutes)")).toHaveValue(30);
  expect(screen.getByLabelText("Concurrency")).toHaveValue(4);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/components/feeds/feed-form.test.tsx -t "recommended interval"`
Expected: FAIL — `getByLabelText("Update interval (minutes)")` finds nothing; the field doesn't exist yet.

- [ ] **Step 4: Add the two fields to `FeedForm`**

In `src/components/feeds/feed-form.tsx`, add state initialized from the feed (when editing) or the initial aggregator's recommendation (when creating), right after the existing `options` state:

```ts
  const [options, setOptions] = useState<Record<string, unknown>>(feed?.options ?? {});
  const [updateIntervalMinutes, setUpdateIntervalMinutes] = useState(
    feed?.updateIntervalMinutes ?? AGGREGATOR_SPECS[aggregator].recommendedIntervalMinutes,
  );
  const [concurrency, setConcurrency] = useState(
    feed?.concurrency ?? AGGREGATOR_SPECS[aggregator].recommendedConcurrency,
  );
```

In `handleAggregatorChange`, reset both alongside `options` (only when creating a new feed -- editing an existing feed's aggregator should not silently overwrite scheduling values the user may have already tuned, matching how `identifier` behaves via `defaultIdentifierFor` today, which also always re-derives on switch regardless of create/edit):

```ts
  function handleAggregatorChange(newAggregator: string | null) {
    if (!newAggregator) return;
    const key = newAggregator as keyof typeof AGGREGATOR_SPECS;
    setAggregator(key);
    // Reset options to default for new aggregator
    const newSpec = AGGREGATOR_SPECS[key];
    const newOptions: Record<string, unknown> = {};
    if (newSpec) {
      for (const opt of newSpec.options) {
        newOptions[opt.key] = opt.default;
      }
      setIdentifier(defaultIdentifierFor(newSpec));
      setUpdateIntervalMinutes(newSpec.recommendedIntervalMinutes);
      setConcurrency(newSpec.recommendedConcurrency);
    }
    setOptions(newOptions);
  }
```

Add both values to the submitted payload:

```ts
      const payload = {
        name,
        aggregator,
        identifier,
        tagIds: tagIds.map(Number),
        options,
        enabled,
        updateIntervalMinutes,
        concurrency,
      };
```

Render the two inputs. Insert this block right after the `{feed && (...)}` enabled-switch block and before the `{visibleOptions.length > 0 && (...)}` options card:

```tsx
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="updateIntervalMinutes">{t("form.updateInterval")}</Label>
          <Input
            id="updateIntervalMinutes"
            type="number"
            min={0}
            max={1440}
            value={updateIntervalMinutes}
            onChange={(event) => setUpdateIntervalMinutes(Number(event.target.value))}
            disabled={pending}
          />
          <p className="text-sm text-muted-foreground">{t("form.updateIntervalHelp")}</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="concurrency">{t("form.concurrency")}</Label>
          <Input
            id="concurrency"
            type="number"
            min={1}
            max={10}
            value={concurrency}
            onChange={(event) => setConcurrency(Number(event.target.value))}
            disabled={pending}
          />
          <p className="text-sm text-muted-foreground">{t("form.concurrencyHelp")}</p>
        </div>
      </div>
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/feeds/feed-form.test.tsx`
Expected: PASS — every test in the file, not just the new one (the new fields must not break the existing identifier-mode tests, which only query by their own labels).

- [ ] **Step 6: Run the messages parity test**

Run: `npx vitest run src/i18n/messages.test.ts`
Expected: PASS — `en.json` and `de.json` gained the same four keys.

- [ ] **Step 7: Commit**

```bash
git add src/components/feeds/feed-form.tsx src/components/feeds/feed-form.test.tsx messages/en.json messages/de.json
git commit -m "feat(feeds): expose per-feed update interval and concurrency in the feed form"
```

---

### Task 7: Remove the global update-interval setting

**Files:**
- Modify: `src/lib/settings/actions.ts`
- Modify: `src/lib/settings/settings.test.ts`
- Modify: `src/components/settings/library-section.tsx`
- Modify: `src/components/settings/library-section.test.tsx`
- Modify: `src/app/(app)/settings/page.tsx`
- Modify: `messages/en.json` (`settings.library`)
- Modify: `messages/de.json` (`settings.library`)

**Interfaces:**
- Consumes: nothing (this task only deletes code).
- Produces: nothing later depends on.

- [ ] **Step 1: Confirm the remaining references are exactly these six files**

Run: `grep -rln "updateIntervalMinutes" src/ messages/`
Expected: exactly `src/lib/settings/actions.ts`, `src/lib/settings/settings.test.ts`, `src/components/settings/library-section.tsx`, `src/components/settings/library-section.test.tsx`, `src/app/(app)/settings/page.tsx`, `messages/en.json`, `messages/de.json`. Everything under `src/lib/feeds/`, `src/lib/jobs/`, `src/lib/aggregators/`, and `src/components/feeds/` must be gone already (Tasks 1-6). If anything else turns up, stop and re-check the earlier task that should have removed it before continuing.

- [ ] **Step 2: Remove it from `settings/actions.ts`**

Change:

```ts
const library = z.object({
  articleRetentionDays: z.number().int().min(1).max(3650),
  // 0 disables automatic updates for the feed entirely (see scheduler.ts's
  // tick()); everything above that is a whole number of minutes.
  updateIntervalMinutes: z.number().int().min(0).max(1440),
});
```

to:

```ts
const library = z.object({
  articleRetentionDays: z.number().int().min(1).max(3650),
});
```

Change:

```ts
const FIELD_ERROR_KEYS: Record<string, SettingsKey> = {
  articleRetentionDays: "library.retentionRange",
  updateIntervalMinutes: "library.intervalRange",
};
```

to:

```ts
const FIELD_ERROR_KEYS: Record<string, SettingsKey> = {
  articleRetentionDays: "library.retentionRange",
};
```

- [ ] **Step 3: Remove the interval control from `library-section.tsx`**

Replace the whole file's content with:

```tsx
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import { updateLibrarySettings } from "@/lib/settings/actions";
import { attempt } from "@/lib/settings/result";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LibrarySection({ articleRetentionDays }: { articleRetentionDays: number }) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const [retention, setRetention] = useState(String(articleRetentionDays));
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      // attempt(), never a bare await: a rejected action inside this transition
      // scope escalates to the (app) group's error.tsx and takes the
      // half-edited field with it, and a session that ended is otherwise
      // indistinguishable from a failed request. See @/lib/settings/result.
      const result = await attempt(() =>
        updateLibrarySettings({ articleRetentionDays: Number(retention) }),
      );
      if (result.ok) {
        toast.success(t("saved"));
      } else {
        toast.error(result.errorKey ? t(result.errorKey) : t("saveFailed"));
      }
    });
  }

  return (
    <LibrarySectionShell
      retentionControl={
        <Input
          id="retention"
          type="number"
          min={1}
          max={3650}
          value={retention}
          onChange={(event) => setRetention(event.target.value)}
          className="w-24"
        />
      }
      saveControl={
        <Button onClick={save} disabled={pending} className="w-full sm:w-auto">
          {tCommon("save")}
        </Button>
      }
    />
  );
}

/**
 * The section's chrome alone: the heading, the field's label and help text,
 * with no dependency on `articleRetentionDays` -- see the doc comment on
 * `GeneralSectionShell` in `./general-section.tsx` for why `settings/page.tsx`
 * renders this directly as its own `<Suspense>` fallback (with a skeleton bar
 * standing in for the control slot) instead of a generic skeleton block.
 */
export function LibrarySectionShell({
  retentionControl,
  saveControl,
}: {
  retentionControl: ReactNode;
  saveControl: ReactNode;
}) {
  const t = useTranslations("settings");

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">{t("library.title")}</h2>

      <div className="grid gap-2">
        <Label htmlFor="retention">{t("library.retention")}</Label>
        <div className="flex items-center gap-2">
          {retentionControl}
          <span className="text-sm text-muted-foreground">{t("library.days")}</span>
        </div>
        <p className="text-sm text-muted-foreground">{t("library.retentionHelp")}</p>
      </div>

      {saveControl}
    </section>
  );
}
```

- [ ] **Step 4: Remove the interval prop/skeleton from `settings/page.tsx`**

Change:

```tsx
      <LibrarySectionShell
        retentionControl={<Skeleton className="h-9 w-24" />}
        intervalControl={<Skeleton className="h-9 w-24" />}
        saveControl={<Skeleton className="h-9 w-24" />}
      />
```

to:

```tsx
      <LibrarySectionShell
        retentionControl={<Skeleton className="h-9 w-24" />}
        saveControl={<Skeleton className="h-9 w-24" />}
      />
```

Change:

```tsx
      <LibrarySection
        articleRetentionDays={settings.articleRetentionDays}
        updateIntervalMinutes={settings.updateIntervalMinutes}
      />
```

to:

```tsx
      <LibrarySection articleRetentionDays={settings.articleRetentionDays} />
```

- [ ] **Step 5: Remove the catalog keys**

In `messages/en.json`, inside `settings.library`, change:

```json
      "retention": "Article retention",
      "retentionHelp": "Articles older than this are removed. Starred articles are kept.",
      "interval": "Update interval",
      "intervalHelp": "How often feeds are checked for new articles. The exact time varies slightly so not every feed is polled at once. 0 disables automatic updates.",
      "days": "Days",
      "minutes": "Minutes",
      "retentionRange": "Article retention must be between 1 and 3650 days.",
      "intervalRange": "Update interval must be between 0 and 1440 minutes."
```

to:

```json
      "retention": "Article retention",
      "retentionHelp": "Articles older than this are removed. Starred articles are kept.",
      "days": "Days",
      "retentionRange": "Article retention must be between 1 and 3650 days."
```

(Read the exact current English text first with `grep -n '"interval"' messages/en.json` and `grep -n '"intervalHelp"' messages/en.json` before editing -- match whatever is actually there.)

In `messages/de.json`, inside `settings.library`, change:

```json
      "retention": "Aufbewahrung",
      "retentionHelp": "Ältere Artikel werden entfernt. Markierte Artikel bleiben erhalten.",
      "interval": "Aktualisierungsintervall",
      "intervalHelp": "Wie oft Feeds auf neue Artikel geprüft werden. Der genaue Zeitpunkt variiert leicht, damit nicht alle Feeds gleichzeitig abgefragt werden. Mit 0 werden automatische Aktualisierungen deaktiviert.",
      "days": "Tage",
      "minutes": "Minuten",
      "retentionRange": "Die Aufbewahrung muss zwischen 1 und 3650 Tagen liegen.",
      "intervalRange": "Das Aktualisierungsintervall muss zwischen 0 und 1440 Minuten liegen."
```

to:

```json
      "retention": "Aufbewahrung",
      "retentionHelp": "Ältere Artikel werden entfernt. Markierte Artikel bleiben erhalten.",
      "days": "Tage",
      "retentionRange": "Die Aufbewahrung muss zwischen 1 und 3650 Tagen liegen."
```

- [ ] **Step 6: Fix `library-section.test.tsx`**

Replace the whole file's content with:

```tsx
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { LibrarySection } from "./library-section";

const { updateLibrarySettings } = vi.hoisted(() => ({ updateLibrarySettings: vi.fn() }));
vi.mock("@/lib/settings/actions", () => ({ updateLibrarySettings }));

// The real stub module, never an inline factory: `attempt()` reaches
// `unstable_rethrow`, and a hand-written mock that forgot it kills the file.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

function render(locale: "en" | "de" = "de") {
  return renderWithProviders(<LibrarySection articleRetentionDays={30} />, { locale });
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function save(locale: "en" | "de" = "de"): void {
  fireEvent.click(screen.getByRole("button", { name: locale === "de" ? "Speichern" : "Save" }));
}

describe("<LibrarySection>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateLibrarySettings.mockResolvedValue({ ok: true });
  });

  it("submits the retention field as a number", async () => {
    render();

    fireEvent.change(field("Aufbewahrung"), { target: { value: "90" } });
    save();

    await waitFor(() =>
      expect(updateLibrarySettings).toHaveBeenCalledWith({ articleRetentionDays: 90 }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Einstellungen gespeichert");
  });

  it("shows the refusal the server named, not the generic one", async () => {
    // Only the catalog key crosses the wire; zod's English message never does.
    updateLibrarySettings.mockResolvedValue({ ok: false, errorKey: "library.retentionRange" });
    render();

    save();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Die Aufbewahrung muss zwischen 1 und 3650 Tagen liegen.",
      ),
    );
  });

  it("survives a save that rejects instead of returning", async () => {
    // The regression this file exists for. Phase 3 awaited the action bare, so a
    // rejection -- a dropped connection, the container restarting mid-request --
    // went unhandled inside the transition scope and escalated to the (app)
    // group's error.tsx: the whole page became "Something went wrong", taking
    // the half-edited field with it. `attempt()` turns it into a toast.
    updateLibrarySettings.mockRejectedValue(new Error("the container restarted"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      render("en");
      fireEvent.change(field("Article retention"), { target: { value: "15" } });
      save("en");

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "The server did not answer. Check your connection and try again.",
        ),
      );
      // Still on the page, still holding what was typed.
      expect(field("Article retention").value).toBe("15");
    } finally {
      logged.mockRestore();
    }
  });
});
```

(This drops the `updateIntervalMinutes` prop from the `render()` helper, drops it from the submitted-payload assertion, and rewrites the "survives a rejected save" test to type into the retention field instead of the now-removed interval field -- everything else in the file is unchanged.)

- [ ] **Step 7: Fix `settings.test.ts`**

In `src/lib/settings/settings.test.ts`, remove the `updateIntervalMinutes` key from every `updateLibrarySettings(...)` call, and delete the two tests that exist only to cover the interval field. Change:

```ts
  describe("updateLibrarySettings", () => {
    it("rejects a retention of zero days with a real catalog key", async () => {
      const result = await actions.updateLibrarySettings({
        articleRetentionDays: 0,
        updateIntervalMinutes: 30,
      });
      expect(result.ok).toBe(false);
      const message = settingsMessage(result.errorKey);
      expect(typeof message).toBe("string");
      expect(message).not.toBe("");
    });

    it("rejects a negative update interval with a real catalog key", async () => {
      const result = await actions.updateLibrarySettings({
        articleRetentionDays: 60,
        updateIntervalMinutes: -1,
      });
      expect(result.ok).toBe(false);
      const message = settingsMessage(result.errorKey);
      expect(typeof message).toBe("string");
      expect(message).not.toBe("");
    });

    it("accepts 0 to disable automatic updates", async () => {
      const result = await actions.updateLibrarySettings({
        articleRetentionDays: 60,
        updateIntervalMinutes: 0,
      });
      expect(result.ok).toBe(true);

      const settings = await queries.getSettings();
      expect(settings.updateIntervalMinutes).toBe(0);
    });

    it("accepts sane values and persists them", async () => {
      const result = await actions.updateLibrarySettings({
        articleRetentionDays: 90,
        updateIntervalMinutes: 15,
      });
      expect(result.ok).toBe(true);

      // A no-op write() would still return { ok: true }, so this reads the
      // row back for real rather than trusting the flag alone.
      const settings = await queries.getSettings();
      expect(settings.articleRetentionDays).toBe(90);
      expect(settings.updateIntervalMinutes).toBe(15);
    });
  });
```

to:

```ts
  describe("updateLibrarySettings", () => {
    it("rejects a retention of zero days with a real catalog key", async () => {
      const result = await actions.updateLibrarySettings({ articleRetentionDays: 0 });
      expect(result.ok).toBe(false);
      const message = settingsMessage(result.errorKey);
      expect(typeof message).toBe("string");
      expect(message).not.toBe("");
    });

    it("accepts sane values and persists them", async () => {
      const result = await actions.updateLibrarySettings({ articleRetentionDays: 90 });
      expect(result.ok).toBe(true);

      // A no-op write() would still return { ok: true }, so this reads the
      // row back for real rather than trusting the flag alone.
      const settings = await queries.getSettings();
      expect(settings.articleRetentionDays).toBe(90);
    });
  });
```

Change:

```ts
        const result = await actions.updateLibrarySettings({
          articleRetentionDays: 90,
          updateIntervalMinutes: 15,
        });
```

(inside `describe("write", ...)`, `"reports failure when the UPDATE matches no row"`) to:

```ts
        const result = await actions.updateLibrarySettings({ articleRetentionDays: 90 });
```

Change:

```ts
      revalidate.mockClear();
      expect(
        (
          await actions.updateLibrarySettings({
            articleRetentionDays: 10,
            updateIntervalMinutes: 10,
          })
        ).ok,
      ).toBe(true);
```

(inside `describe("updateGeneralSettings", ...)`, `"invalidates the whole layout only when the language actually changed"`) to:

```ts
      revalidate.mockClear();
      expect((await actions.updateLibrarySettings({ articleRetentionDays: 10 })).ok).toBe(true);
```

- [ ] **Step 8: Run the full suite**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: all four PASS. This is the first point at which the whole feature (all 7 tasks) is verified together.

- [ ] **Step 9: Commit**

```bash
git add src/lib/settings/actions.ts src/lib/settings/settings.test.ts src/components/settings/library-section.tsx src/components/settings/library-section.test.tsx "src/app/(app)/settings/page.tsx" messages/en.json messages/de.json
git commit -m "feat(settings): remove the global update interval, replaced by per-feed intervals"
```
