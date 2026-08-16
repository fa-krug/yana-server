# Performance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the seven measured sources of wasted I/O, wasted bytes and
write-lock contention found in the 2026-08-16 audit of the database layer, the
background-job pipeline and `/api/v1`.

**Architecture:** Eight independent tasks, each with its own migration (where
needed), its own tests and its own commit. No task depends on another's runtime
behaviour, so they can be reviewed and reverted individually. The one
substantial change is Task 7: the aggregation handler learns to recognise an
article whose content has not changed and skip rewriting it — detected by a
SHA-256 hash of the exact inputs that determine the stored row and the block
tree, so a genuinely-changed article (a new Reddit comment, an edited body, a
new header image) is still written in full.

**Tech Stack:** Next.js 16, TypeScript, Drizzle ORM + better-sqlite3 (SQLite),
Vitest (two projects — `.test.ts` = node/real SQLite, `.test.tsx` = jsdom),
drizzle-kit for migrations.

**Spec:** No separate design doc. This plan is the record; the findings it
implements are restated verbatim in "Background" below.

## Global Constraints

- **Every write goes through `writeTransaction()`** from `@/lib/db/client`, and
  its callback **must be synchronous**. Never call `connection.exec`/`prepare`
  outside it.
- **Library tests use a real migrated SQLite database**, never a driver mock.
  Each test points `DATABASE_PATH` at its own temp file and gets its schema from
  `applyMigrationsAt()` in `src/lib/db/test-support.ts`.
- **The file extension picks the vitest project.** Every test in this plan is
  `.test.ts` (node project). Do not create a `.test.tsx`.
- **Style:** line length 100, double quotes, semicolons, trailing commas.
  Prettier owns formatting.
- **Before every commit, all four CI checks must pass:**
  `npm run lint && npm run format:check && npm run typecheck && npm test`
  An unformatted file is a build failure, not a warning.
- **Migrations are never applied by hand.** The server applies them at startup
  via `runStartupTasks()`; tests apply them via `applyMigrationsAt()`. Generate
  them with `npx drizzle-kit generate` and commit the `.sql`, the
  `drizzle/meta/_journal.json` entry and the snapshot together.
- **A table that gains *and* loses columns in one `generate` cannot be generated
  non-interactively.** Every migration in this plan is a pure addition or an
  index change, so none of them prompts. If drizzle-kit ever opens a prompt,
  stop — the change was mis-scoped.
- **Commit message format:** `<type>(<scope>): <description>` where type is one
  of feat, fix, docs, style, refactor, test, chore.

---

## Background: the seven findings

Restated so a reader of this plan needs nothing else.

1. **Aggregation rewrites unchanged articles on every run.**
   `src/lib/jobs/handlers/aggregate.ts:104-147` compares nothing before writing.
   An existing article is `UPDATE`d on every pass and its entire block tree is
   deleted and reinserted by `writeBlocks()`. `articles.updatedAt` carries
   `$onUpdate`, so every rewritten row re-enters the `/api/v1` sync `updated`
   stream — the native client re-downloads the whole corpus on every
   aggregation cycle. → **Task 7**
2. **`syncArticles` selects every column and serializes eleven.**
   `src/lib/api/sync.ts:170` and `:197` use bare `db.select()`, pulling
   `rawContent` (a whole fetched HTML page) and `plainText` off disk for every
   row in both streams, then discarding them. → **Task 1**
3. **No index backs the `updated` sync stream.** `articles_created_id_idx`
   covers `(createdAt, id)` for the `new` stream; nothing covers
   `(updatedAt, id)`, so the `updated` query full-scans and temp-sorts on every
   sync call. → **Task 2**
4. **An idle worker takes ~2 exclusive write locks per second.** Four loops at a
   2s poll, and `claim()` (`src/lib/jobs/queue.ts:48`) wraps even the
   no-candidate case in `writeTransaction` → `BEGIN IMMEDIATE`. The four loops
   also wake together. → **Task 4** (lock) and **Task 5** (jitter)
5. **`progress()` is a write transaction per article.** `aggregate.ts:152` calls
   it once per article, but the clamped percentage only takes ~20 distinct
   values across the loop. → **Task 3**
6. **`jobs_claim_idx` cannot serve `claim()`'s ordering.** The index is
   all-ascending on `(status, priority, runAt)`; the query wants
   `priority DESC, runAt ASC`. SQLite only walks an index backwards when every
   term reverses, so this falls back to a temp sort. → **Task 6**
7. **Article search is a double full scan.** `src/lib/articles/queries.ts:58`
   does `LIKE '%term%'` over `plainText`, the largest column on the table, and
   the `count()` on line 90 runs the same scan again. → **Task 8**

---

## Task 1: Narrow the sync select to the columns the wire format uses

**Files:**
- Modify: `src/lib/api/serializers.ts:16-30`
- Modify: `src/lib/api/sync.ts:169-207`
- Test: `src/lib/api/sync.test.ts` (exists — add one case)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `ArticleSummarySource` — an exported type alias in
  `src/lib/api/serializers.ts`, equal to
  `Pick<Article, "id" | "feedId" | "name" | "identifier" | "date" | "author" | "icon" | "read" | "starred" | "createdAt" | "updatedAt">`.
  `serializeArticleSummary` accepts it. A full `Article` still satisfies it, so
  the existing caller in `src/app/api/v1/articles/[id]/route.ts:62` keeps
  working unchanged.

- [ ] **Step 1: Write the failing test**

Append inside the existing top-level `describe` in `src/lib/api/sync.test.ts`.
Follow the file's existing fixture pattern for creating a user, a feed and an
article; if it already has a helper for that, reuse it rather than duplicating.

```ts
it("does not read rawContent or plainText into the sync result", () => {
  // A bare `db.select()` would pull these two columns -- the largest on the
  // table -- off disk for every row and then discard them in the serializer.
  const page = syncArticles(userId, ZERO_CURSOR, 10);
  if ("resyncRequired" in page) throw new Error("unexpected resync");

  expect(page.new).toHaveLength(1);
  const row = page.new[0] as unknown as Record<string, unknown>;
  expect(row).not.toHaveProperty("rawContent");
  expect(row).not.toHaveProperty("plainText");
  // The wire fields are all still present.
  expect(Object.keys(row).sort()).toEqual(
    [
      "author",
      "createdAt",
      "date",
      "feedId",
      "icon",
      "id",
      "identifier",
      "name",
      "read",
      "starred",
      "updatedAt",
    ].sort(),
  );
});
```

- [ ] **Step 2: Run it to confirm it passes for the wrong reason, then make it real**

Run: `npx vitest run src/lib/api/sync.test.ts -t "does not read rawContent"`

This test passes today, because `serializeArticleSummary` already drops those
columns on the way out — it asserts the *output*, not the *read*. That is not
good enough. Replace the assertion block with one that pins the select itself,
by spying on what the database is asked for:

```ts
it("selects only the columns the wire format uses", () => {
  const db = getDb() as unknown as { $client: { prepare: (sql: string) => unknown } };
  const seen: string[] = [];
  const original = db.$client.prepare.bind(db.$client);
  db.$client.prepare = (sql: string) => {
    seen.push(sql);
    return original(sql);
  };

  try {
    syncArticles(userId, ZERO_CURSOR, 10);
  } finally {
    db.$client.prepare = original;
  }

  const articleSelects = seen.filter((sql) => /from "articles"/i.test(sql));
  expect(articleSelects.length).toBeGreaterThan(0);
  for (const sql of articleSelects) {
    expect(sql).not.toMatch(/"raw_content"/);
    expect(sql).not.toMatch(/"plain_text"/);
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/api/sync.test.ts -t "selects only the columns"`
Expected: FAIL — the emitted SQL contains `"raw_content"` and `"plain_text"`.

- [ ] **Step 4: Add the shared projection type to the serializer**

In `src/lib/api/serializers.ts`, above `serializeArticleSummary`:

```ts
/**
 * The columns `serializeArticleSummary` actually reads. Typed as a `Pick`
 * rather than the whole `Article` so `syncArticles` can hand it a narrowed
 * `.select({...})` -- the point of that narrowing being that `rawContent`
 * (a whole fetched HTML page) and `plainText` are never read off disk for
 * rows whose wire format contains neither. A full `Article` row still
 * satisfies this, so callers that already have one need no change.
 */
export type ArticleSummarySource = Pick<
  Article,
  | "id"
  | "feedId"
  | "name"
  | "identifier"
  | "date"
  | "author"
  | "icon"
  | "read"
  | "starred"
  | "createdAt"
  | "updatedAt"
>;
```

Then change the signature:

```ts
export function serializeArticleSummary(article: ArticleSummarySource): ArticleSummaryWire {
```

The body is unchanged.

- [ ] **Step 5: Narrow both selects in `syncArticles`**

In `src/lib/api/sync.ts`, add the shared column map above `syncArticles`:

```ts
/**
 * Exactly the columns `serializeArticleSummary` reads, and no more. A bare
 * `db.select()` here would additionally pull `rawContent` -- a whole fetched
 * HTML page -- and `plainText` for every row in both streams, only for the
 * serializer to discard them. `listArticles` in `@/lib/articles/queries`
 * avoids the same trap for the same reason.
 */
const SUMMARY_COLUMNS = {
  id: articles.id,
  feedId: articles.feedId,
  name: articles.name,
  identifier: articles.identifier,
  date: articles.date,
  author: articles.author,
  icon: articles.icon,
  read: articles.read,
  starred: articles.starred,
  createdAt: articles.createdAt,
  updatedAt: articles.updatedAt,
} as const;
```

Replace `.select()` with `.select(SUMMARY_COLUMNS)` in both the `newRows` query
(line ~170) and the `updatedRowsFetched` query (line ~197). Leave the
`removedRows` query alone — it reads `articleTombstones`, which has no large
columns.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/api/sync.test.ts src/lib/api/serializers.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Run the full checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/lib/api/serializers.ts src/lib/api/sync.ts src/lib/api/sync.test.ts
git commit -m "perf(api): Select only wire columns in the article sync streams"
```

---

## Task 2: Index the `updated` sync stream

**Files:**
- Modify: `src/lib/db/schema/articles.ts:63-73`
- Create: `drizzle/00NN_<generated-name>.sql` (drizzle-kit picks the name)
- Test: `src/lib/db/schema.test.ts` (exists — add one case)

**Interfaces:**
- Consumes: nothing.
- Produces: a SQLite index named `articles_updated_id_idx` on
  `articles(updated_at, id)`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/db/schema.test.ts`, following that file's existing pattern for
reading `sqlite_master` from a migrated fixture database:

```ts
it("indexes (updatedAt, id) so the sync `updated` stream needs no temp sort", () => {
  const row = getDb()
    .all<{ sql: string }>(
      sql`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'articles_updated_id_idx'`,
    )
    .at(0);

  expect(row).toBeDefined();
  expect(row!.sql).toMatch(/\(\s*`?updated_at`?\s*,\s*`?id`?\s*\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/db/schema.test.ts -t "updatedAt"`
Expected: FAIL — `row` is `undefined`; the index does not exist.

- [ ] **Step 3: Declare the index**

In `src/lib/db/schema/articles.ts`, inside the `articles` table's index array,
directly below the `articles_created_id_idx` line:

```ts
    // Sync cursor, `updated` stream: the counterpart to
    // `articles_created_id_idx`. `syncArticles` orders by
    // `updatedAt ASC, id ASC` with a LIMIT; without this the query
    // full-scans and builds a temp B-tree on every sync call.
    index("articles_updated_id_idx").on(table.updatedAt, table.id),
```

- [ ] **Step 4: Generate the migration**

```bash
npx drizzle-kit generate
```

Expected: it writes one new `drizzle/00NN_*.sql` containing a single
`CREATE INDEX \`articles_updated_id_idx\` ON \`articles\` (\`updated_at\`,\`id\`);`,
plus a `drizzle/meta/00NN_snapshot.json` and a new `drizzle/meta/_journal.json`
entry. Open the `.sql` and confirm it contains **only** that statement. If it
contains anything else, or if drizzle-kit opened an interactive prompt, stop and
report — the change was mis-scoped.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/db/schema.test.ts -t "updatedAt"`
Expected: PASS.

- [ ] **Step 6: Run the full checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/lib/db/schema/articles.ts src/lib/db/schema.test.ts drizzle/
git commit -m "perf(db): Index articles(updatedAt, id) for the sync updated stream"
```

---

## Task 3: Skip `progress()` writes that change nothing

**Files:**
- Modify: `src/lib/jobs/queue.ts:182-187`
- Test: `src/lib/jobs/queue.test.ts` (exists — add one case)

**Interfaces:**
- Consumes: nothing.
- Produces: `progress(id, percent)` keeps its exact signature
  (`(id: number, percent: number) => void`) and its clamping behaviour. Only the
  no-op case changes: it now performs no write.

- [ ] **Step 1: Write the failing test**

Add inside `src/lib/jobs/queue.test.ts`, in a `describe("progress", ...)` block
(create it if the file has none):

```ts
it("performs no write when the clamped percent already matches the stored value", () => {
  const id = queue.enqueue({ kind: "aggregate", payload: { feedId: 1 } });
  queue.progress(id, 40);

  const before = client.getDb().select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();

  // 40.9 clamps to the same 40 that is already stored. The aggregate handler
  // calls progress() once per article, and its 80 + floor(i/total*20)
  // expression only takes twenty distinct values across the whole loop -- so
  // a 200-article feed used to open 200 BEGIN IMMEDIATE transactions to write
  // twenty distinct numbers.
  queue.progress(id, 40.9);

  const after = client.getDb().select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
  expect(after!.progress).toBe(40);
  expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
});

it("still writes when the clamped percent differs from the stored value", () => {
  const id = queue.enqueue({ kind: "aggregate", payload: { feedId: 1 } });
  queue.progress(id, 40);
  queue.progress(id, 41);

  const row = client.getDb().select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
  expect(row!.progress).toBe(41);
});
```

Adjust the `enqueue` call to whatever signature the file's other tests already
use — read one before writing this.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/jobs/queue.test.ts -t "performs no write"`
Expected: FAIL — `updatedAt` advanced, because the `UPDATE` ran and
`jobs.updatedAt` carries `$onUpdate`.

If `updatedAt` happens to land in the same whole second (the column truncates to
seconds), the test would pass spuriously. If that happens, replace the timestamp
assertion with a `prepare` spy of the same shape used in Task 1 Step 2,
asserting no `update "jobs"` statement was prepared for the second call.

- [ ] **Step 3: Add the guard**

Replace the body of `progress()` in `src/lib/jobs/queue.ts`:

```ts
export function progress(id: number, percent: number): void {
  const clamped = Math.min(100, Math.max(0, Math.floor(percent)));

  // Read first, outside any write transaction: the aggregate handler calls
  // this once per article, and 80 + floor(i/total*20) only takes twenty
  // distinct values across the whole loop -- so for a 200-article feed all
  // but twenty of those calls were a BEGIN IMMEDIATE that wrote the number
  // already sitting in the column. A stale read here is harmless: the worst
  // case is one redundant write, which is exactly what happened before.
  const current = getDb().select({ progress: jobs.progress }).from(jobs).where(eq(jobs.id, id)).get();
  if (current?.progress === clamped) {
    return;
  }

  writeTransaction((db) => {
    db.update(jobs).set({ progress: clamped }).where(eq(jobs.id, id)).run();
  });
}
```

Confirm `getDb` is already imported in this module; add it to the existing
`@/lib/db/client` import if not.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/jobs/queue.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Run the full checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/lib/jobs/queue.ts src/lib/jobs/queue.test.ts
git commit -m "perf(jobs): Skip progress() writes that would change nothing"
```

---

## Task 4: Stop `claim()` taking the write lock when there is nothing to claim

**Files:**
- Modify: `src/lib/jobs/queue.ts:48-82`
- Test: `src/lib/jobs/queue.test.ts` (exists — add one case)

**Interfaces:**
- Consumes: nothing.
- Produces: `claim()` keeps its exact signature (`() => Job | null`) and all of
  its existing semantics, including the compare-and-swap that makes concurrent
  loops safe. Only the empty case changes: it now returns without opening a
  write transaction.

- [ ] **Step 1: Write the failing test**

```ts
it("opens no write transaction when there is no claimable job", () => {
  const db = client.getDb() as unknown as { $client: { prepare: (sql: string) => unknown } };
  const seen: string[] = [];
  const original = db.$client.prepare.bind(db.$client);
  db.$client.prepare = (sql: string) => {
    seen.push(sql);
    return original(sql);
  };

  try {
    // Nothing enqueued: this is the state four idle worker loops sit in
    // permanently, polling every two seconds.
    expect(queue.claim()).toBeNull();
  } finally {
    db.$client.prepare = original;
  }

  expect(seen.some((sql) => /BEGIN IMMEDIATE/i.test(sql))).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/jobs/queue.test.ts -t "opens no write transaction"`
Expected: FAIL — `BEGIN IMMEDIATE` was prepared.

If better-sqlite3 issues `BEGIN IMMEDIATE` through a path `prepare` does not
see, assert on `db.$client.inTransaction` instead by wrapping
`writeTransaction` with a counting spy via `vi.spyOn(client, "writeTransaction")`
and expecting it not to have been called.

- [ ] **Step 3: Add the read-only pre-check**

In `src/lib/jobs/queue.ts`, insert at the top of `claim()`, before the existing
`return writeTransaction(...)`:

```ts
export function claim(): Job | null {
  // A read-only pre-check, deliberately outside the write transaction. Four
  // worker loops poll every two seconds, so an idle instance used to acquire
  // the exclusive write lock (BEGIN IMMEDIATE) twice a second forever, purely
  // to discover there was nothing to do -- contending with real writes for
  // nothing. This read is advisory only: the transaction below re-selects and
  // still guards its UPDATE on `status = 'pending'`, so a row that appears
  // here and is taken by another loop before we get the lock is handled
  // exactly as before (result.changes !== 1 -> null).
  const available = getDb()
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "pending"), lte(jobs.runAt, new Date())))
    .limit(1)
    .get();

  if (!available) {
    return null;
  }

  return writeTransaction((db) => {
    // ... existing body, unchanged ...
  });
}
```

Leave the existing transaction body exactly as it is — including its own
`candidate` select. Removing that would break the compare-and-swap.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/jobs/queue.test.ts src/lib/jobs/worker.test.ts`
Expected: PASS — in particular the existing "two loops claim different jobs" and
"claims a higher-priority job ahead of an older, lower-priority one" cases must
still pass, which is what proves the pre-check did not weaken the CAS.

- [ ] **Step 5: Run the full checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/lib/jobs/queue.ts src/lib/jobs/queue.test.ts
git commit -m "perf(jobs): Pre-check for a claimable job before taking the write lock"
```

---

## Task 5: Jitter the worker poll so four loops stop waking together

**Files:**
- Modify: `src/lib/jobs/worker.ts:104-120`
- Test: `src/lib/jobs/worker.test.ts` (exists — add one case)

**Interfaces:**
- Consumes: nothing.
- Produces: `runWorkerLoop(options)` keeps its exact signature. The idle sleep
  between polls becomes a uniformly random value in
  `[0.75 * pollIntervalMs, 1.25 * pollIntervalMs)` instead of exactly
  `pollIntervalMs`.

- [ ] **Step 1: Write the failing test**

```ts
it("jitters the idle poll interval so concurrent loops do not wake in lockstep", async () => {
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const spy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === "number") delays.push(ms);
      return realSetTimeout(fn, 1);
    }) as typeof globalThis.setTimeout);

  const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 100 });
  await new Promise((resolve) => realSetTimeout(resolve, 60));
  worker.stopWorker();
  await loopPromise;
  spy.mockRestore();

  const idleDelays = delays.filter((ms) => ms > 0);
  expect(idleDelays.length).toBeGreaterThan(2);
  // Every sleep sits inside the jitter band...
  for (const ms of idleDelays) {
    expect(ms).toBeGreaterThanOrEqual(75);
    expect(ms).toBeLessThan(125);
  }
  // ...and they are not all the same value, which is the whole point.
  expect(new Set(idleDelays).size).toBeGreaterThan(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/jobs/worker.test.ts -t "jitters the idle poll"`
Expected: FAIL on the last assertion — every delay is exactly `100`, so the set
has size 1.

- [ ] **Step 3: Add the jitter**

In `src/lib/jobs/worker.ts`, above `runWorkerLoop`:

```ts
/**
 * How far the idle poll delay is spread either side of `pollIntervalMs`.
 * `startWorker()` launches every loop in the same tick and they all sleep the
 * same amount, so without this the four default loops wake as a herd and
 * contend for the same write lock at the same instant, four times per poll,
 * forever. A quarter either way is enough to decorrelate them without
 * meaningfully changing how promptly a job is picked up.
 */
const POLL_JITTER = 0.25;

function jitteredDelay(pollIntervalMs: number): number {
  const spread = pollIntervalMs * POLL_JITTER;
  return pollIntervalMs - spread + Math.random() * spread * 2;
}
```

Then in the loop body, replace:

```ts
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
```

with:

```ts
      await new Promise((resolve) => setTimeout(resolve, jitteredDelay(pollInterval)));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/jobs/worker.test.ts`
Expected: PASS, all cases. The existing timing-sensitive cases use
`pollIntervalMs` of 20–50, so their jittered range is 15–62ms — well inside the
20s `testTimeout`.

- [ ] **Step 5: Run the full checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/lib/jobs/worker.ts src/lib/jobs/worker.test.ts
git commit -m "perf(jobs): Jitter the worker poll so loops stop waking in lockstep"
```

---

## Task 6: Make `jobs_claim_idx` match `claim()`'s ordering

**Files:**
- Modify: `src/lib/db/schema/jobs.ts:88-93`
- Create: `drizzle/00NN_<generated-name>.sql`
- Test: `src/lib/db/schema.test.ts` (exists — add one case)

**Interfaces:**
- Consumes: nothing.
- Produces: `jobs_claim_idx` redefined as
  `(status ASC, priority DESC, run_at ASC, id ASC)`.

Note: `claim()` orders by `desc(priority), asc(runAt), asc(id)`. SQLite can only
satisfy an `ORDER BY` from an index by walking it forwards or entirely
backwards — a mix of directions forces a temp B-tree. Declaring the index with
the same per-column directions removes that sort. `id` is appended so the index
covers the full ordering rather than three-quarters of it.

- [ ] **Step 1: Write the failing test**

```ts
it("declares jobs_claim_idx in the direction claim() orders by", () => {
  const row = getDb()
    .all<{ sql: string }>(
      sql`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'jobs_claim_idx'`,
    )
    .at(0);

  expect(row).toBeDefined();
  // priority descending, run_at and id ascending -- a mixed-direction ORDER BY
  // that the old all-ascending index could not serve without a temp sort.
  expect(row!.sql).toMatch(/`?priority`?\s+desc/i);
  expect(row!.sql).toMatch(/`?run_at`?/);
  expect(row!.sql).toMatch(/`?id`?\s*\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/db/schema.test.ts -t "jobs_claim_idx"`
Expected: FAIL — the existing index SQL has no `desc`.

- [ ] **Step 3: Redeclare the index**

In `src/lib/db/schema/jobs.ts`, replace the `jobs_claim_idx` line:

```ts
    // Column directions mirror claim()'s ORDER BY exactly
    // (`desc(priority), asc(runAt), asc(id)`). SQLite can only satisfy an
    // ORDER BY from an index by walking it forwards or entirely backwards, so
    // an all-ascending index against a mixed-direction sort falls back to a
    // temp B-tree. `id` is included so the index covers the whole ordering.
    index("jobs_claim_idx").on(table.status, table.priority.desc(), table.runAt.asc(), table.id.asc()),
```

If `.desc()` / `.asc()` are not available on the column type in the pinned
drizzle-orm version, use the `asc`/`desc` helpers imported from `drizzle-orm`
instead: `index("jobs_claim_idx").on(table.status, desc(table.priority), asc(table.runAt), asc(table.id))`.
Verify by reading the generated SQL in the next step, not by assuming.

- [ ] **Step 4: Generate the migration and read it**

```bash
npx drizzle-kit generate
```

Expected: one new `.sql` containing a `DROP INDEX \`jobs_claim_idx\`;` followed
by a `CREATE INDEX \`jobs_claim_idx\` ON \`jobs\` (\`status\`,\`priority\` desc,\`run_at\`,\`id\`);`.
Open it and confirm the `desc` is actually present. If it is not, the schema
form in Step 3 did not take effect — fix it and regenerate rather than
hand-editing the `.sql`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/db/schema.test.ts src/lib/jobs/queue.test.ts`
Expected: PASS. The queue tests are included because they assert claim ordering
behaviour, which must be unchanged.

- [ ] **Step 6: Run the full checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/lib/db/schema/jobs.ts src/lib/db/schema.test.ts drizzle/
git commit -m "perf(db): Match jobs_claim_idx directions to claim()'s ORDER BY"
```

---

## Task 7: Skip rewriting an article whose content has not changed

This is the substantial task. Read the whole task before starting.

**Files:**
- Modify: `src/lib/db/schema/articles.ts` (add `contentHash` column)
- Create: `src/lib/aggregators/content-hash.ts`
- Create: `src/lib/aggregators/content-hash.test.ts`
- Modify: `src/lib/jobs/handlers/aggregate.ts:97-159`
- Create: `drizzle/00NN_<generated-name>.sql`
- Test: `src/lib/jobs/handlers/handlers.test.ts` (exists — add cases, and
  **update two existing assertions**, see Step 9)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `articles.contentHash` — `text("content_hash")`, **nullable**. A row with
    `null` is treated as "changed", so every pre-existing row is rewritten once
    and then settles. No backfill migration is needed.
  - `articleContentHash(input: ArticleContentInput): string` — exported from
    `src/lib/aggregators/content-hash.ts`, returns a lowercase hex SHA-256.
    ```ts
    export interface ArticleContentInput {
      name: string;
      /** What the block tree is parsed from. */
      html: string;
      /** What lands in `articles.rawContent`. */
      rawContent: string;
      /** The feed's own date, or null when the feed supplied none. */
      date: Date | null;
      author: string;
      icon: string | null;
    }
    ```

### Why the hash covers what it covers

Three things make a naive hash wrong here, and all three are load-bearing:

1. **The date fallback is volatile.** `aggregate.ts:119` stores
   `raw.date || new Date()`. For any feed whose items carry no date, that stamps
   *now* on every run — a hash over the stored value would differ every time and
   never skip anything. So the hash covers `raw.date ?? null`, the feed's own
   value, and the *stored* date for a skipped article is simply left alone.
2. **Two different expressions feed two different things.** The block tree is
   parsed from `raw.content || raw.raw_content` (line 97) but the column stores
   `raw.raw_content || raw.content` (line 100). Hashing only one would let a
   change in the other slip through. The hash covers both.
3. **`plainText` is derived, not independent.** It is `plainTextOf(parseBlocks(html))`,
   a pure function of `html`. Hashing `html` covers it; hashing `plainText`
   separately would mean parsing before we know whether we need to.

**On new Reddit comments specifically:** the Reddit aggregator renders the
comment section into the article body
(`src/lib/aggregators/sites/reddit/aggregator.ts:799-803`), and
`formatCommentHtml` (`sites/reddit/comments.ts:18-27`) emits only author,
permalink and body — no score, no timestamp. So a new, edited or removed
comment, and any change to which comments make the top-N cut, all change `html`
and therefore the hash. The article is rewritten in full, exactly as today.
Nothing semantic is special-cased, and there is a test for it in Step 7.

### Write ordering

For a changed or new article, three writes happen in this order:

1. `UPDATE`/`INSERT` the article row — **without** `contentHash`.
2. `writeBlocks(articleId, blocks)`.
3. `UPDATE articles SET content_hash = <hash>`.

The hash is written last on purpose: a stored hash then means "the row *and* its
block tree are up to date for this content". A crash between steps leaves the
hash stale or null, so the next aggregation run redoes the work — self-healing,
the same principle `ensureAdminExists()` uses. Never write the hash in step 1.

- [ ] **Step 1: Write the failing test for the hash function**

Create `src/lib/aggregators/content-hash.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { articleContentHash } from "./content-hash";

const base = {
  name: "Post",
  html: "<p>body</p>",
  rawContent: "<html><p>body</p></html>",
  date: new Date("2026-01-01T00:00:00.000Z"),
  author: "ada",
  icon: null,
};

describe("articleContentHash", () => {
  it("is stable for identical input", () => {
    expect(articleContentHash(base)).toBe(articleContentHash({ ...base }));
  });

  it("changes when the block-source html changes", () => {
    // A new Reddit comment lands here: the comment section is rendered into
    // the article body, so the html differs and the article must be rewritten.
    expect(articleContentHash({ ...base, html: "<p>body</p><blockquote>new</blockquote>" })).not.toBe(
      articleContentHash(base),
    );
  });

  it("changes when the stored rawContent changes even though html did not", () => {
    // The block tree is parsed from `content || raw_content` but the column
    // stores `raw_content || content` -- two different expressions, so both
    // have to be covered.
    expect(articleContentHash({ ...base, rawContent: "<html>other</html>" })).not.toBe(
      articleContentHash(base),
    );
  });

  it.each(["name", "author"] as const)("changes when %s changes", (field) => {
    expect(articleContentHash({ ...base, [field]: "different" })).not.toBe(
      articleContentHash(base),
    );
  });

  it("changes when the icon changes, including to and from null", () => {
    const withIcon = articleContentHash({ ...base, icon: "https://example.com/a.png" });
    expect(withIcon).not.toBe(articleContentHash(base));
    expect(articleContentHash({ ...base, icon: null })).toBe(articleContentHash(base));
  });

  it("changes when the feed's own date changes", () => {
    expect(articleContentHash({ ...base, date: new Date("2026-01-02T00:00:00.000Z") })).not.toBe(
      articleContentHash(base),
    );
  });

  it("treats a missing date as a stable value, not as a fresh timestamp", () => {
    // The handler's fallback is `raw.date || new Date()`. Hashing the stored
    // value would differ on every run for any feed that supplies no dates,
    // so the hash covers the feed's own value -- null included.
    expect(articleContentHash({ ...base, date: null })).toBe(
      articleContentHash({ ...base, date: null }),
    );
    expect(articleContentHash({ ...base, date: null })).not.toBe(articleContentHash(base));
  });

  it("cannot be fooled by shifting content across field boundaries", () => {
    expect(articleContentHash({ ...base, name: "Post<p>body</p>", html: "" })).not.toBe(
      articleContentHash(base),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/aggregators/content-hash.test.ts`
Expected: FAIL — cannot resolve `./content-hash`.

- [ ] **Step 3: Write the hash function**

Create `src/lib/aggregators/content-hash.ts`:

```ts
import { createHash } from "node:crypto";

/**
 * Everything that determines what an aggregated article stores -- both the
 * `articles` row and the block tree derived from it.
 *
 * `date` is the feed's *own* value, not the value that gets stored. The
 * handler's fallback is `raw.date || new Date()`, so hashing the stored value
 * would produce a fresh hash on every run for any feed whose items carry no
 * date, and the skip would never fire.
 *
 * `html` and `rawContent` are both here because they are two different
 * expressions over the same raw article: the block tree is parsed from
 * `content || raw_content` while the column stores `raw_content || content`.
 * `plainText` deliberately is not: it is a pure function of `html`, so it is
 * already covered, and computing it would mean parsing the blocks before we
 * know whether we need them.
 */
export interface ArticleContentInput {
  name: string;
  html: string;
  rawContent: string;
  date: Date | null;
  author: string;
  icon: string | null;
}

/**
 * A content fingerprint for one aggregated article, stored in
 * `articles.contentHash`. When a later aggregation run computes the same value
 * the row and its blocks are already correct and every write is skipped --
 * which is also what keeps an unchanged article out of `/api/v1`'s sync
 * `updated` stream, since `articles.updatedAt` carries `$onUpdate`.
 *
 * The fields are joined via `JSON.stringify` over an array rather than a
 * delimiter, so no value can be shifted across a field boundary to collide
 * with a different input.
 */
export function articleContentHash(input: ArticleContentInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.name,
        input.html,
        input.rawContent,
        input.date ? input.date.toISOString() : null,
        input.author,
        input.icon,
      ]),
    )
    .digest("hex");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/aggregators/content-hash.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Add the column and generate the migration**

In `src/lib/db/schema/articles.ts`, add to the `articles` column block, directly
below `plainText`:

```ts
    /**
     * Fingerprint of the aggregator inputs that produced this row and its
     * block tree (see `articleContentHash` in
     * `@/lib/aggregators/content-hash`). The aggregate handler compares it
     * before writing: an unchanged article is skipped entirely, which avoids
     * rewriting the row, avoids deleting and reinserting the whole block
     * tree, and -- because `updatedAt` carries `$onUpdate` -- keeps the
     * article out of `/api/v1`'s sync `updated` stream.
     *
     * Nullable, and written *last* on purpose: a stored hash means "row and
     * blocks are both up to date for this content", so a crash mid-write
     * leaves it null or stale and the next run redoes the work. Every row
     * that predates this column is null, is therefore treated as changed,
     * and settles after one aggregation pass -- no backfill needed.
     */
    contentHash: text("content_hash"),
```

Then:

```bash
npx drizzle-kit generate
```

Expected: one new `.sql` containing exactly
`ALTER TABLE \`articles\` ADD \`content_hash\` text;`. This is a pure addition,
so drizzle-kit must not prompt. If it does, stop and report.

- [ ] **Step 6: Run the checks so far and commit the groundwork**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/lib/aggregators/content-hash.ts src/lib/aggregators/content-hash.test.ts \
        src/lib/db/schema/articles.ts drizzle/
git commit -m "feat(db): Add articles.contentHash and the aggregator content fingerprint"
```

- [ ] **Step 7: Write the failing handler tests**

First add this helper inside the `describe("aggregate", ...)` block — the four
tests below all need the same fixture, and the file currently repeats it inline
in every test:

```ts
function seedAggregateFeed(): number {
  let feedId = 0;
  client.writeTransaction((db) => {
    let user = db.select().from(schema.users).limit(1).get();
    if (!user) {
      db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
      user = db.select().from(schema.users).limit(1).get();
    }
    const feed = db
      .insert(schema.feeds)
      .values({ name: "Active Feed", userId: user!.id, enabled: true })
      .returning({ id: schema.feeds.id })
      .get();
    feedId = feed.id;
  });
  return feedId;
}
```

Then add the four tests:

```ts
it("does not rewrite an article whose content is unchanged", async () => {
  const feedId = seedAggregateFeed();

  const rawArticles = [
    {
      name: "Article One",
      identifier: "art-1",
      raw_content: "<p>one</p>",
      content: "<p>one</p>",
      date: new Date("2026-01-01T00:00:00.000Z"),
    },
  ];

  const factory = await import("@/lib/aggregators/factory");
  vi.mocked(factory.createAggregator).mockReturnValue({
    aggregate: async () => rawArticles,
  } as unknown as ReturnType<typeof factory.createAggregator>);

  const aggregateHandler = handlers.getHandler("aggregate");

  await aggregateHandler!(makeJob("aggregate", { feedId }));
  const first = client
    .getDb()
    .select()
    .from(schema.articles)
    .where(eq(schema.articles.feedId, feedId))
    .get();
  const firstBlocks = client
    .getDb()
    .select()
    .from(schema.articleBlocks)
    .where(eq(schema.articleBlocks.articleId, first!.id))
    .all();

  const secondJob = makeJob("aggregate", { feedId });
  await aggregateHandler!(secondJob);

  const second = client
    .getDb()
    .select()
    .from(schema.articles)
    .where(eq(schema.articles.feedId, feedId))
    .get();
  const secondBlocks = client
    .getDb()
    .select()
    .from(schema.articleBlocks)
    .where(eq(schema.articleBlocks.articleId, first!.id))
    .all();

  // The row was not touched: updatedAt did not advance, so this article does
  // not re-enter /api/v1's sync `updated` stream.
  expect(second!.updatedAt.getTime()).toBe(first!.updatedAt.getTime());
  // The block tree was not deleted and reinserted: same rows, same ids.
  expect(secondBlocks.map((b) => b.id)).toEqual(firstBlocks.map((b) => b.id));
  expect(logLines(secondJob.id)).toContain("upserted articles: 0 created, 0 updated, 1 unchanged");
});

it("rewrites an article when new comments are appended to its body", async () => {
  const feedId = seedAggregateFeed();

  const withoutComment = {
    name: "Reddit Post",
    identifier: "art-1",
    raw_content: "<p>post</p>",
    content: "<p>post</p>",
    date: new Date("2026-01-01T00:00:00.000Z"),
  };
  // What the Reddit aggregator actually produces on a later run: the comment
  // section is rendered into the article body, so a new comment changes the
  // content the block tree is built from.
  const withComment = {
    ...withoutComment,
    raw_content: "<p>post</p><blockquote><p><strong>ada</strong></p><div>nice</div></blockquote>",
    content: "<p>post</p><blockquote><p><strong>ada</strong></p><div>nice</div></blockquote>",
  };

  const factory = await import("@/lib/aggregators/factory");
  const aggregateHandler = handlers.getHandler("aggregate");

  vi.mocked(factory.createAggregator).mockReturnValue({
    aggregate: async () => [withoutComment],
  } as unknown as ReturnType<typeof factory.createAggregator>);
  await aggregateHandler!(makeJob("aggregate", { feedId }));

  vi.mocked(factory.createAggregator).mockReturnValue({
    aggregate: async () => [withComment],
  } as unknown as ReturnType<typeof factory.createAggregator>);
  const secondJob = makeJob("aggregate", { feedId });
  await aggregateHandler!(secondJob);

  const row = client
    .getDb()
    .select()
    .from(schema.articles)
    .where(eq(schema.articles.feedId, feedId))
    .get();
  expect(row!.plainText).toContain("nice");
  expect(logLines(secondJob.id)).toContain("upserted articles: 0 created, 1 updated, 0 unchanged");
});

it("still skips on a later run for a feed whose articles carry no date", async () => {
  const feedId = seedAggregateFeed();

  // No `date` field at all: the handler falls back to `new Date()`. Hashing
  // the stored value would differ on every run and the skip would never fire.
  const rawArticles = [
    { name: "Undated", identifier: "art-1", raw_content: "<p>x</p>", content: "<p>x</p>" },
  ];

  const factory = await import("@/lib/aggregators/factory");
  vi.mocked(factory.createAggregator).mockReturnValue({
    aggregate: async () => rawArticles,
  } as unknown as ReturnType<typeof factory.createAggregator>);

  const aggregateHandler = handlers.getHandler("aggregate");
  await aggregateHandler!(makeJob("aggregate", { feedId }));
  const secondJob = makeJob("aggregate", { feedId });
  await aggregateHandler!(secondJob);

  expect(logLines(secondJob.id)).toContain("upserted articles: 0 created, 0 updated, 1 unchanged");
});

it("rewrites an article whose stored contentHash is null", async () => {
  const feedId = seedAggregateFeed();

  // Every row that predates the column is in this state. It must be treated
  // as changed exactly once, then settle.
  client.writeTransaction((db) => {
    db.insert(schema.articles)
      .values({
        name: "Legacy",
        identifier: "art-1",
        feedId,
        rawContent: "<p>x</p>",
        date: new Date("2026-01-01T00:00:00.000Z"),
        contentHash: null,
      })
      .run();
  });

  const rawArticles = [
    {
      name: "Legacy",
      identifier: "art-1",
      raw_content: "<p>x</p>",
      content: "<p>x</p>",
      date: new Date("2026-01-01T00:00:00.000Z"),
    },
  ];

  const factory = await import("@/lib/aggregators/factory");
  vi.mocked(factory.createAggregator).mockReturnValue({
    aggregate: async () => rawArticles,
  } as unknown as ReturnType<typeof factory.createAggregator>);

  const aggregateHandler = handlers.getHandler("aggregate");
  const firstJob = makeJob("aggregate", { feedId });
  await aggregateHandler!(firstJob);
  expect(logLines(firstJob.id)).toContain("upserted articles: 0 created, 1 updated, 0 unchanged");

  const secondJob = makeJob("aggregate", { feedId });
  await aggregateHandler!(secondJob);
  expect(logLines(secondJob.id)).toContain("upserted articles: 0 created, 0 updated, 1 unchanged");
});
```

- [ ] **Step 8: Run the tests to verify they fail**

Run: `npx vitest run src/lib/jobs/handlers/handlers.test.ts -t "unchanged"`
Expected: FAIL — the log line has no `unchanged` segment yet, and `updatedAt`
advanced on the second run.

- [ ] **Step 9: Update the two existing log-line assertions**

The log line gains a third segment, so two existing assertions in the same file
must change. Search for `upserted articles:` and update:

- `"upserted articles: 2 created, 0 updated"` → `"upserted articles: 2 created, 0 updated, 0 unchanged"`
- `"upserted articles: 0 created, 1 updated"` → `"upserted articles: 0 created, 1 updated, 0 unchanged"`

Read each one in context and match the real counts — do not blind-replace.

- [ ] **Step 10: Implement the skip in the handler**

In `src/lib/jobs/handlers/aggregate.ts`, add the import:

```ts
import { articleContentHash } from "@/lib/aggregators/content-hash";
```

Add `let unchanged = 0;` beside the existing `created`/`updated` counters.

Replace the body of the per-article loop, from the `const htmlContent = ...`
line through the `progress(...)` call, with:

```ts
    const htmlContent = raw.content || raw.raw_content || "";
    const rawContentToStore = raw.raw_content || raw.content || "";
    const rawDate = raw.date ?? null;

    const hash = articleContentHash({
      name: raw.name || "Untitled",
      html: htmlContent,
      rawContent: rawContentToStore,
      date: rawDate,
      author: raw.author || "",
      icon: raw.icon || null,
    });

    // Read outside the write transaction, and narrow: three small columns,
    // never `rawContent`/`plainText`. This is the whole point -- comparing
    // the large columns directly would cost the very I/O the skip saves.
    const known = db
      .select({ id: articles.id, contentHash: articles.contentHash })
      .from(articles)
      .where(and(eq(articles.feedId, feedId), eq(articles.identifier, raw.identifier)))
      .get();

    if (known && known.contentHash === hash) {
      // Nothing about this article changed since the last run. Skipping is
      // not just cheaper: `articles.updatedAt` carries `$onUpdate`, so an
      // unconditional rewrite would put every unchanged article back into
      // /api/v1's sync `updated` stream on every aggregation cycle.
      unchanged++;
      progress(job.id, 80 + Math.floor(((i + 1) / total) * 20));
      continue;
    }

    // Only now is the expensive parse worth doing.
    const blocks = parseBlocks(htmlContent, raw.identifier);
    const plainText = plainTextOf(blocks);

    let articleId = 0;

    writeTransaction((tx) => {
      // Re-read inside the transaction rather than trusting `known` above:
      // that read was outside the write lock, and two worker loops can be
      // running an aggregate job for the same feed. The select/insert pair
      // has to stay atomic, exactly as it was before.
      const existing = tx
        .select({ id: articles.id, date: articles.date })
        .from(articles)
        .where(and(eq(articles.feedId, feedId), eq(articles.identifier, raw.identifier)))
        .get();

      if (existing) {
        articleId = existing.id;
        updated++;
        tx.update(articles)
          .set({
            name: raw.name || "Untitled",
            rawContent: rawContentToStore,
            plainText,
            // Keep the stored date when the feed supplied none. Re-stamping
            // `new Date()` here would rewrite the column on every run and,
            // worse, make it disagree with the hash -- which covers the
            // feed's own value precisely so an undated feed can still settle.
            date: rawDate ?? existing.date,
            author: raw.author || "",
            icon: raw.icon || null,
          })
          .where(eq(articles.id, articleId))
          .run();
      } else {
        const inserted = tx
          .insert(articles)
          .values({
            feedId,
            name: raw.name || "Untitled",
            identifier: raw.identifier,
            rawContent: rawContentToStore,
            plainText,
            date: rawDate ?? new Date(),
            author: raw.author || "",
            icon: raw.icon || null,
          })
          .returning({ id: articles.id })
          .get();
        articleId = inserted.id;
        created++;
      }
    });

    if (articleId > 0 && blocks.length > 0) {
      await writeBlocks(articleId, blocks);
    }

    if (articleId > 0) {
      // Written last, deliberately: a stored hash means "the row *and* its
      // block tree are current for this content". A crash anywhere above
      // leaves it stale or null, so the next run redoes the work rather than
      // trusting a fingerprint for a half-written article.
      writeTransaction((tx) => {
        tx.update(articles).set({ contentHash: hash }).where(eq(articles.id, articleId)).run();
      });
    }

    progress(job.id, 80 + Math.floor(((i + 1) / total) * 20));
```

Finally, update the summary log line:

```ts
  appendLogLine(
    job.id,
    "stdout",
    `upserted articles: ${created} created, ${updated} updated, ${unchanged} unchanged`,
  );
```

Note the `date` handling in the update arm changed from `raw.date || new Date()`
to `rawDate ?? existing.date`. That is required, not incidental — see the "Why
the hash covers what it covers" section above.

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npx vitest run src/lib/jobs/handlers/handlers.test.ts`
Expected: PASS, all cases including the pre-existing ones.

- [ ] **Step 12: Run the full checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/lib/jobs/handlers/aggregate.ts src/lib/jobs/handlers/handlers.test.ts
git commit -m "perf(jobs): Skip rewriting aggregated articles whose content is unchanged"
```

---

## Task 8: Replace the article search scan with FTS5

**Behaviour change — flag this to the reviewer.** `LIKE '%term%'` matches
mid-word; FTS5 matches token prefixes. After this task, searching `ndows` no
longer finds `Windows`, while `wind` still does. That is the normal trade for a
real index and is the intended behaviour, but it is a user-visible change and a
reviewer is entitled to reject it.

**Files:**
- Create: `drizzle/00NN_articles_fts.sql` (via `drizzle-kit generate --custom`)
- Create: `src/lib/articles/search-query.ts`
- Create: `src/lib/articles/search-query.test.ts`
- Modify: `src/lib/articles/queries.ts:1-16, 54-59`
- Test: `src/lib/articles/queries.test.ts` (exists — add cases)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - An FTS5 virtual table `articles_fts`, external-content over
    `articles(name, plain_text)`, kept current by three triggers. It is
    deliberately **not** declared in `src/lib/db/schema.ts` — drizzle has no
    virtual-table support, and drizzle-kit only diffs against its own snapshot,
    so an undeclared table is never dropped.
  - `toFtsQuery(term: string): string | null` — exported from
    `src/lib/articles/search-query.ts`. Returns a safe FTS5 `MATCH` expression,
    or `null` when the term has no usable tokens.

- [ ] **Step 1: Confirm FTS5 is compiled into the pinned better-sqlite3**

```bash
node -e "const D=require('better-sqlite3');const d=new D(':memory:');d.exec(\"CREATE VIRTUAL TABLE t USING fts5(a)\");console.log('fts5 ok')"
```

Expected: prints `fts5 ok`. If it throws `no such module: fts5`, **stop and
report** — the rest of this task is not viable and the finding needs a different
fix.

- [ ] **Step 2: Write the failing test for the query builder**

Create `src/lib/articles/search-query.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { toFtsQuery } from "./search-query";

describe("toFtsQuery", () => {
  it("quotes each token and ANDs them with a trailing prefix match", () => {
    expect(toFtsQuery("hello world")).toBe('"hello" "world"*');
  });

  it("returns null for a term with no usable tokens", () => {
    expect(toFtsQuery("")).toBeNull();
    expect(toFtsQuery("   ")).toBeNull();
  });

  it("neutralises FTS5 operators rather than letting them reach the parser", () => {
    // Unquoted, every one of these is FTS5 syntax: a bare `NOT`, a column
    // filter, a bareword operator. Quoting turns them all back into text, so
    // a user's search string can never be a query-syntax error -- or a way to
    // steer the query.
    expect(toFtsQuery("NOT foo")).toBe('"NOT" "foo"*');
    expect(toFtsQuery("name:foo")).toBe('"name:foo"*');
    expect(toFtsQuery("foo OR bar")).toBe('"foo" "OR" "bar"*');
  });

  it("escapes an embedded double quote by doubling it", () => {
    expect(toFtsQuery('say "hi"')).toBe('"say" """hi"""*');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/articles/search-query.test.ts`
Expected: FAIL — cannot resolve `./search-query`.

- [ ] **Step 4: Write the query builder**

Create `src/lib/articles/search-query.ts`:

```ts
/**
 * Turn a user's raw search box input into an FTS5 `MATCH` expression.
 *
 * Every token is wrapped in double quotes (with any embedded quote doubled,
 * FTS5's own escape) so nothing the user types can reach the query parser as
 * syntax: `NOT`, `OR`, `name:`, `*` and `^` are all just text after this. An
 * unquoted term is not merely a possible syntax error -- it is a way to steer
 * the query, which a search box must never be.
 *
 * Tokens are space-separated, which FTS5 reads as implicit AND. Only the last
 * token carries a `*`, so a term still matches while the user is mid-word
 * without every earlier word being treated as a prefix.
 *
 * Returns null when there is nothing to search for, which the caller treats as
 * "no search filter" rather than "match nothing".
 */
export function toFtsQuery(term: string): string | null {
  const tokens = term
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replaceAll('"', '""')}"`);

  if (tokens.length === 0) return null;

  return tokens.map((token, i) => (i === tokens.length - 1 ? `${token}*` : token)).join(" ");
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/articles/search-query.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Create the migration**

```bash
npx drizzle-kit generate --custom --name articles_fts
```

This creates an empty `.sql` plus the journal entry and snapshot. If the pinned
drizzle-kit does not support `--custom` (check `npx drizzle-kit generate --help`
first), **stop and report** rather than hand-writing a journal entry — a
mismatched journal is how a migration silently never runs.

Fill the generated file with:

```sql
CREATE VIRTUAL TABLE `articles_fts` USING fts5(
  `name`,
  `plain_text`,
  content=`articles`,
  content_rowid=`id`,
  tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
INSERT INTO `articles_fts`(`rowid`, `name`, `plain_text`)
  SELECT `id`, `name`, `plain_text` FROM `articles`;
--> statement-breakpoint
CREATE TRIGGER `articles_fts_insert` AFTER INSERT ON `articles` BEGIN
  INSERT INTO `articles_fts`(`rowid`, `name`, `plain_text`)
    VALUES (new.`id`, new.`name`, new.`plain_text`);
END;
--> statement-breakpoint
CREATE TRIGGER `articles_fts_delete` AFTER DELETE ON `articles` BEGIN
  INSERT INTO `articles_fts`(`articles_fts`, `rowid`, `name`, `plain_text`)
    VALUES ('delete', old.`id`, old.`name`, old.`plain_text`);
END;
--> statement-breakpoint
CREATE TRIGGER `articles_fts_update` AFTER UPDATE ON `articles` BEGIN
  INSERT INTO `articles_fts`(`articles_fts`, `rowid`, `name`, `plain_text`)
    VALUES ('delete', old.`id`, old.`name`, old.`plain_text`);
  INSERT INTO `articles_fts`(`rowid`, `name`, `plain_text`)
    VALUES (new.`id`, new.`name`, new.`plain_text`);
END;
```

`content=` makes this an external-content table: FTS5 stores only the index, not
a second copy of `plain_text`. The `'delete'` command rows are how an
external-content table is told to retract a row — a plain `DELETE FROM
articles_fts` would corrupt the index. The `INSERT ... SELECT` backfills every
existing article in one statement.

- [ ] **Step 7: Write the failing query tests**

Add these to the `describe("listArticles", ...)` block in
`src/lib/articles/queries.test.ts`. They use that file's existing helpers —
`currentUserId()`, `switchToOtherUser()`, `seedFeed()`, `seedArticle()`,
`client`, `schema` — all already defined there; read them before writing.

```ts
it("finds an article by a word in its body via the FTS index", async () => {
  await currentUserId();
  const feedId = seedFeed();
  seedArticle(feedId, { name: "Matching", plainText: "a guide to kubernetes operators" });
  seedArticle(feedId, { name: "Other", plainText: "an unrelated body" });

  const result = await queries.listArticles(parseListParams({ q: "kubernetes" }));
  expect(result.rows.map((r) => r.name)).toEqual(["Matching"]);
  expect(result.total).toBe(1);
});

it("finds an article by a prefix of the last search token", async () => {
  await currentUserId();
  const feedId = seedFeed();
  seedArticle(feedId, { name: "Matching", plainText: "a guide to kubernetes operators" });

  // Only the last token carries the `*`, so this is a prefix match on a whole
  // token -- not the mid-word match the old LIKE '%term%' would have given.
  const result = await queries.listArticles(parseListParams({ q: "kuber" }));
  expect(result.rows.map((r) => r.name)).toEqual(["Matching"]);
});

it("does not match a fragment from the middle of a word", async () => {
  await currentUserId();
  const feedId = seedFeed();
  seedArticle(feedId, { name: "Matching", plainText: "a guide to kubernetes operators" });

  // The documented behaviour change from LIKE '%term%'. Pinned so it is a
  // decision on record rather than a surprise.
  const result = await queries.listArticles(parseListParams({ q: "bernetes" }));
  expect(result.rows).toHaveLength(0);
});

it("keeps the FTS index current when an article's text is updated", async () => {
  await currentUserId();
  const feedId = seedFeed();
  const article = seedArticle(feedId, { name: "Matching", plainText: "kubernetes guide" });

  client.writeTransaction((tx) => {
    tx.update(schema.articles)
      .set({ plainText: "helm guide" })
      .where(eq(schema.articles.id, article.id))
      .run();
  });

  // Proves the AFTER UPDATE trigger fires -- both halves of it: the new word
  // is found and the old one is gone.
  expect((await queries.listArticles(parseListParams({ q: "helm" }))).rows).toHaveLength(1);
  expect((await queries.listArticles(parseListParams({ q: "kubernetes" }))).rows).toHaveLength(0);
});

it("drops an article out of the index when it is deleted", async () => {
  await currentUserId();
  const feedId = seedFeed();
  const article = seedArticle(feedId, { name: "Matching", plainText: "kubernetes guide" });

  client.writeTransaction((tx) => {
    tx.delete(schema.articles).where(eq(schema.articles.id, article.id)).run();
  });

  // Proves the AFTER DELETE trigger's `'delete'` command row reached the
  // external-content table. Without it the index keeps a dangling entry.
  const result = await queries.listArticles(parseListParams({ q: "kubernetes" }));
  expect(result.rows).toHaveLength(0);
});

it("treats a search string made of FTS operators as text, not syntax", async () => {
  await currentUserId();
  const feedId = seedFeed();
  seedArticle(feedId, { name: "Matching", plainText: "kubernetes guide" });

  // Unquoted, every one of these is FTS5 syntax and the query would throw.
  // A search box could never produce an error with LIKE and must not now.
  for (const q of ["NOT OR *", 'name:"', "^foo", "AND"]) {
    const result = await queries.listArticles(parseListParams({ q }));
    expect(result.rows).toHaveLength(0);
  }
});

it("never matches an article belonging to another user", async () => {
  await currentUserId();
  const feedId = seedFeed();
  seedArticle(feedId, { name: "Matching", plainText: "kubernetes guide" });

  await switchToOtherUser();

  // The FTS table is not user-scoped -- ownership still comes from the
  // feeds.userId join. This pins that the MATCH did not bypass it.
  const result = await queries.listArticles(parseListParams({ q: "kubernetes" }));
  expect(result.rows).toHaveLength(0);
});
```

`eq` must be imported from `drizzle-orm` in the test file if it is not already.

- [ ] **Step 8: Run the tests to verify they fail**

Run: `npx vitest run src/lib/articles/queries.test.ts`
Expected: FAIL on "does not match a fragment from the middle of a word" — the
`LIKE '%bernetes%'` in place today still matches, which is exactly the
behaviour being replaced. Several others pass already (LIKE also finds a whole
word and a prefix); that is fine, they are there to prove the switch does not
lose those cases. If the mid-word test *passes*, the query has not been read
correctly — stop and re-check before implementing.

- [ ] **Step 9: Switch the query over**

In `src/lib/articles/queries.ts`, remove `like` and `or` from the `drizzle-orm`
import if nothing else uses them, and add `sql`. Add:

```ts
import { toFtsQuery } from "./search-query";
```

Replace the search block (lines ~54-59):

```ts
  // Full-text search through the `articles_fts` external-content FTS5 index
  // (see the `articles_fts` migration), not a LIKE scan: the previous
  // `LIKE '%term%'` over `plainText` -- the largest column on the table --
  // full-scanned once for the rows and again for the count().
  //
  // Behaviour note: FTS5 matches token prefixes, where LIKE matched mid-word.
  // `wind` finds `Windows`; `ndows` no longer does.
  const term = params.q.trim();
  const ftsQuery = toFtsQuery(term);
  if (ftsQuery) {
    conditions.push(
      sql`${articles.id} IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH ${ftsQuery})`,
    );
  }
```

Both the `count()` query and the row query already build from `whereClause`, so
each picks this up with no further change.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run src/lib/articles/queries.test.ts src/lib/articles/search-query.test.ts`
Expected: PASS, all cases including the pre-existing search tests. If a
pre-existing test asserts a mid-word match, it is asserting the old behaviour —
update it and note the change in the commit body.

- [ ] **Step 11: Verify the index survives a real retention pass**

Run: `npx vitest run src/lib/jobs/handlers/handlers.test.ts`
Expected: PASS. The retention job hard-deletes articles and `restore.ts` wipes a
feed's articles; both go through `DELETE FROM articles`, so the
`articles_fts_delete` trigger keeps the index consistent. A failure here means a
trigger is wrong.

- [ ] **Step 12: Run the full checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/lib/articles/queries.ts src/lib/articles/queries.test.ts \
        src/lib/articles/search-query.ts src/lib/articles/search-query.test.ts drizzle/
git commit -m "perf(articles): Replace the LIKE search scan with an FTS5 index"
```

---

## Task 9: Record the new invariants in CLAUDE.md

Four of these changes are conventions a future agent can silently undo. They go
in `CLAUDE.md` or they will not survive.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the bullets**

Add each of the following as its own bullet under "Conventions", placed beside
the related existing material:

1. Beside the existing sync/`/api/v1` bullets: **`syncArticles` selects a named
   column list, never `db.select()`.** `rawContent` is a whole fetched HTML page
   and `plainText` is the largest column on the table; neither appears in
   `ArticleSummaryWire`, so a bare select reads both off disk for every row in
   both streams and discards them. `listArticles` documents the same rule.
   `articles_updated_id_idx` on `(updatedAt, id)` is the `updated` stream's
   counterpart to `articles_created_id_idx` — without it the query full-scans
   and temp-sorts on every sync call.
2. A new bullet: **An aggregated article is only rewritten when its content
   actually changed**, decided by `articles.contentHash`
   (`articleContentHash()` in `src/lib/aggregators/content-hash.ts`). Three
   things about that hash are load-bearing and each was a real trap: it covers
   the feed's **own** `date`, never the stored one, because the handler's
   `raw.date || new Date()` fallback would otherwise make an undated feed
   re-hash on every run and never settle; it covers **both** `content || raw_content`
   (what the blocks are parsed from) and `raw_content || content` (what the
   column stores), which are different expressions; and it is written **last**,
   after `writeBlocks()`, so a stored hash means the row *and* its blocks are
   current and a crash mid-write self-heals on the next run. The payoff is not
   only local I/O: `articles.updatedAt` carries `$onUpdate`, so an unconditional
   rewrite put every unchanged article back into `/api/v1`'s sync `updated`
   stream on every aggregation cycle. A `null` hash means "changed" — every row
   predating the column settles after one pass, and no backfill exists.
3. Beside the worker/`WORKER_CONCURRENCY` bullet: **`claim()` pre-checks for a
   pending job outside the write transaction, and the idle poll is jittered.**
   Four loops at a 2s poll used to take the exclusive `BEGIN IMMEDIATE` lock
   twice a second on a completely idle instance, all four waking in the same
   tick. The pre-check is advisory only — the transaction still re-selects and
   still guards its `UPDATE` on `status = 'pending'`, which is the
   compare-and-swap that makes concurrent loops safe. Do not "simplify" it away.
   `progress()` likewise reads before writing and returns without a transaction
   when the clamped value already matches.
4. Beside the search/articles material: **Article search goes through the
   `articles_fts` FTS5 external-content table, via `toFtsQuery()`.** Every token
   is quoted so a user's search string can never reach the FTS5 parser as
   syntax. The table is deliberately absent from `src/lib/db/schema.ts` —
   drizzle has no virtual-table support, and drizzle-kit diffs against its own
   snapshot, so an undeclared table is never dropped. Its three triggers are
   what keep it current; the `'delete'` command rows are mandatory for an
   external-content table, and a plain `DELETE FROM articles_fts` corrupts the
   index. FTS5 matches token prefixes where the previous `LIKE '%term%'` matched
   mid-word: `wind` finds `Windows`, `ndows` does not.

- [ ] **Step 2: Run the format check and commit**

```bash
npm run format:check
git add CLAUDE.md
git commit -m "docs: Record the performance-hardening invariants"
```

---

## Verification after all tasks

- [ ] `npm run lint && npm run format:check && npm run typecheck && npm test` — all green.
- [ ] Delete `data/`, run `npm run build`, and confirm `data/` was **not**
      recreated. This is CLAUDE.md's standing prerender invariant; none of these
      tasks should affect it, and a failure means a module-load-time database
      read crept in.
- [ ] Start the server against a database with existing articles and run one
      aggregation. The first pass logs a nonzero `updated` count (every row's
      `contentHash` is null); the **second** pass over the same unchanged feed
      must log `0 created, 0 updated, N unchanged`. If the second pass still
      reports updates, the hash is covering something volatile — check the
      `date` handling first.
- [ ] Search for a word you know is mid-article and confirm it is found; search
      for a mid-word fragment and confirm it is not. That is the expected FTS5
      behaviour change, not a bug.
