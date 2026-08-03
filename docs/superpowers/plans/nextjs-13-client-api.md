# Phase 13: The Yana Client API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**This supersedes the earlier "intentionally incomplete" version of this file.** The brainstorming session it called for has happened; the design is
`docs/superpowers/specs/2026-08-03-client-api-design.md`. Read that first if anything below is unclear about *why* — this file is the *how*.

**Goal:** Ship the first-party client API: incremental article sync, feed/tag listing, star/read toggling, on-demand aggregation and per-article reload with completion notification over SSE, content-addressed image serving, and a webview-based device-pairing flow with self-service device management.

**Architecture:** A `/api/v1/**` route surface authenticated by a dedicated Better Auth *session* per device (not a cookie, not a nonexistent API-key plugin), reached via a webview login + custom-URL-scheme handoff. Sync is one cursor-based endpoint that doubles as "list everything" (empty cursor) and "delta" (non-empty cursor). Deletions are tracked via a new tombstones table. Aggregation triggers a `runs` row grouping N per-feed jobs; the existing in-process job worker publishes completion to a per-user in-memory event bus that a new SSE route forwards.

**Tech Stack:** Next.js 16 route handlers, Drizzle/better-sqlite3, Better Auth 1.6.25 (session primitives only — no `apiKey` plugin exists in this version), Zod for body validation, Vitest (node project, real SQLite, no mocks).

## Global Constraints

- Every query is scoped to the authenticated user. No exception, anywhere in this plan.
- "Doesn't belong to you" and "doesn't exist" always answer **404**, never 403 (existing convention: `requireAdmin()`, the avatar route).
- Error bodies are `{ "error": { "code": "...", "message": "..." } }` with a stable `code` — never a driver or Zod message, never a catalog key (the native client owns its own localization; this differs from the web UI's `errorKey` convention on purpose).
- Every write goes through `writeTransaction()` from `@/lib/db/client`, with a **synchronous** callback (see `src/lib/db/client.ts` — an `async` callback there silently commits before your code runs).
- Every new GET route handler calls `await connection()` from `next/server` as its **first statement**, before any auth or query logic — the same rule `src/app/health/route.ts` and every page in `src/app/(app)` already follow, and for the same reason: nothing here reads a Next "Dynamic API" like `cookies()`/`headers()`, so without an explicit `connection()` call `next build` could bake one of these routes as a static response.
- Migrations: run `npx drizzle-kit generate` after schema edits, then `npx drizzle-kit generate` is non-interactive **only** when a single `generate` call doesn't ask one table to both gain and lose a column. Task 1 is additive-only for exactly this reason; the `feeds.logo` drop is deliberately its own later task (Task 7).
- Style: 100-char lines, double quotes, semicolons, trailing commas (Prettier owns this — run `npm run format` if unsure).
- Run `npm run lint && npm run format:check && npm run typecheck && npm test` before considering any task's commit final if you've touched more than the one file the task names.

---

### Task 1: Additive schema changes — device sessions, tombstones, runs, logo hash

**Files:**
- Modify: `src/lib/db/schema/auth.ts` (add `deviceName` to `sessions`)
- Modify: `src/lib/db/schema/articles.ts` (add `articleTombstones` table)
- Modify: `src/lib/db/schema/jobs.ts` (add `runs` table, add `runId` to `jobs`)
- Modify: `src/lib/db/schema/feeds.ts` (add `logoImageHash` column — `logo` stays for now, dropped in Task 7)
- Modify: `src/lib/db/schema.ts` (re-export `runs`, `articleTombstones`; add their relations)
- Modify: `src/lib/auth/server.ts` (declare `session.additionalFields.deviceName`)
- Create: `drizzle/0005_<generated_name>.sql` (via `drizzle-kit generate`, name picked by the tool)
- Test: `src/lib/db/schema/schema.test.ts` (new assertions alongside whatever already exists there — check the file first)

**Interfaces:**
- Produces: `sessions.deviceName: string | null` (Drizzle property `deviceName`, column `device_name`)
- Produces: `articleTombstones` table — `{ id, articleId, userId, deletedAt }`, exported type `ArticleTombstone`/`NewArticleTombstone`
- Produces: `runs` table — `{ id, userId, status, totalJobs, completedJobs, failedJobs, createdAt, finishedAt }`, exported type `Run`/`NewRun`
- Produces: `jobs.runId: number | null` (FK → `runs.id`)
- Produces: `feeds.logoImageHash: string | null`
- Consumes: nothing from other tasks (this is the foundation everything else builds on)

- [ ] **Step 1: Add `deviceName` to the `sessions` table**

In `src/lib/db/schema/auth.ts`, add one line inside the `sessions` table definition, right after `impersonatedBy`:

```ts
    impersonatedBy: text("impersonated_by"),
    /**
     * Set only on a session minted by `/device/pair` (phase 13's client API) —
     * null for every ordinary browser session from `/login`. Declared as a
     * `session.additionalFields` entry in `src/lib/auth/server.ts` too; Better
     * Auth's adapter throws if the two disagree about which fields exist.
     */
    deviceName: text("device_name"),
```

- [ ] **Step 2: Add the `article_tombstones` table**

In `src/lib/db/schema/articles.ts`, add after the `articles` table closes (before the `articleBlocks` export), importing `users` at the top of the file (it currently only imports `feeds`):

```ts
import { feeds } from "./feeds";
import { users } from "./users";
```

```ts
/**
 * Records a hard-deleted article for phase 13's sync `removed` list.
 *
 * `userId` is denormalized on purpose: once the article (and possibly its
 * feed) is gone, nothing else lets this row be scoped to its owner. Every
 * hard-delete path (retention, feed deletion) must insert one of these for
 * each affected article *before* the delete, inside the same
 * `writeTransaction()`.
 */
export const articleTombstones = sqliteTable(
  "article_tombstones",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    articleId: integer("article_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deletedAt: integer("deleted_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("article_tombstones_user_deleted_idx").on(table.userId, table.deletedAt, table.id),
  ],
);

export type ArticleTombstone = typeof articleTombstones.$inferSelect;
export type NewArticleTombstone = typeof articleTombstones.$inferInsert;
```

- [ ] **Step 3: Add the `runs` table and `jobs.runId`**

In `src/lib/db/schema/jobs.ts`, import `users` and add a `runs` table before `jobs`, then add `runId` to `jobs`:

```ts
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users";

/**
 * Groups the N per-feed `aggregate` jobs one `POST /api/v1/aggregate` call
 * creates, so a client has one thing to poll/subscribe to instead of N job
 * ids. `completedJobs`/`failedJobs` are bumped by `src/lib/jobs/queue.ts`'s
 * `complete()`/`fail()` whenever a job carrying this run's id finishes.
 */
export const runs = sqliteTable(
  "runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"),
    totalJobs: integer("total_jobs").notNull(),
    completedJobs: integer("completed_jobs").notNull().default(0),
    failedJobs: integer("failed_jobs").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
  },
  (table) => [index("runs_user_idx").on(table.userId)],
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
```

Then in the same file, add `runId` to the existing `jobs` table (right after `id`, before `kind`), and import `runs`... actually `runs` is defined in the same file above `jobs`, so no import needed:

```ts
export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Set when this job was enqueued as part of a run (phase 13's aggregate trigger). */
    runId: integer("run_id").references(() => runs.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    // ... rest unchanged
```

Add an index for the run-lookup query in the `(table) => [...]` array: `index("jobs_run_idx").on(table.runId),`.

- [ ] **Step 4: Add `feeds.logoImageHash`**

In `src/lib/db/schema/feeds.ts`, add after `logoSourceUrl` (leave `logo` and `logoSourceUrl` both in place for now — Task 6 migrates `logo.ts` to write this new column, Task 7 drops `logo`):

```ts
    logo: text("logo"),
    /** Kept so the logo can be re-resolved without re-discovering the source. */
    logoSourceUrl: text("logo_source_url").notNull().default(""),
    /**
     * Content-addressed replacement for `logo`, referencing
     * `articleImages.contentHash`. Populated by Task 6; `logo` itself is
     * dropped in Task 7 once nothing reads it.
     */
    logoImageHash: text("logo_image_hash"),
```

- [ ] **Step 5: Re-export and add relations in the barrel**

`src/lib/db/schema.ts` already does `export * from "./schema/articles"` and `export * from "./schema/jobs"`, so `articleTombstones` and `runs` are re-exported automatically — no change needed there for the exports themselves. Add relations for both new tables (there is no relation requirement for a table with no `db.query.*` traversal planned, so this step is a no-op **unless** a later task needs `db.query.runs.findFirst({ with: ... })`-style access — it doesn't; every query in this plan is a plain `db.select()`. Skip adding relations. This sub-step exists to record that the decision was considered, not skipped by accident.)

- [ ] **Step 6: Declare `deviceName` in Better Auth's config**

In `src/lib/auth/server.ts`, add a `session` block (there isn't one yet beyond the existing `session: { expiresIn, updateAge, cookieCache }`) — extend the existing `session` object rather than adding a second one:

```ts
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 60 * 5 },
    /**
     * Declared here so Better Auth's adapter agrees with the Drizzle schema
     * about this field's existence — see the comment on `sessions.deviceName`
     * in `src/lib/db/schema/auth.ts`. `internalAdapter.createSession()`'s
     * `override` argument only persists a key the adapter knows to write.
     */
    additionalFields: {
      deviceName: { type: "string", required: false },
    },
  },
```

- [ ] **Step 7: Generate the migration**

```bash
npx drizzle-kit generate
```

Expected: one new file under `drizzle/`, something like `0005_<two-word-name>.sql`, containing `ALTER TABLE sessions ADD COLUMN device_name text;`, a `CREATE TABLE article_tombstones (...)`, a `CREATE TABLE runs (...)`, `ALTER TABLE jobs ADD COLUMN run_id integer REFERENCES runs(id) ON DELETE SET NULL;`, and `ALTER TABLE feeds ADD COLUMN logo_image_hash text;`. No interactive prompt should appear — if one does, a table in this diff has both an added and a dropped column, which means a schema edit leaked in that doesn't belong in this task.

- [ ] **Step 8: Write a schema/migration smoke test**

Add to (or create) `src/lib/db/schema/schema.test.ts`:

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";

import { applyMigrations } from "@/lib/db/test-support";
import * as schema from "./index"; // adjust to this file's real existing import path for `schema`

describe("phase 13 additive schema", () => {
  it("creates article_tombstones, runs, and the new columns", () => {
    const connection = new Database(":memory:");
    applyMigrations(connection);
    const db = drizzle(connection, { schema });

    expect(() => db.select().from(schema.articleTombstones).all()).not.toThrow();
    expect(() => db.select().from(schema.runs).all()).not.toThrow();

    const sessionCols = connection.pragma("table_info(sessions)") as { name: string }[];
    expect(sessionCols.some((c) => c.name === "device_name")).toBe(true);

    const jobCols = connection.pragma("table_info(jobs)") as { name: string }[];
    expect(jobCols.some((c) => c.name === "run_id")).toBe(true);

    const feedCols = connection.pragma("table_info(feeds)") as { name: string }[];
    expect(feedCols.some((c) => c.name === "logo_image_hash")).toBe(true);

    connection.close();
  });
});
```

If `src/lib/db/schema/schema.test.ts` doesn't exist yet, check for an existing schema test file first (CLAUDE.md mentions "schema/enums" tests exist) and follow its exact import style rather than the sketch above.

- [ ] **Step 9: Run the test**

```bash
npx vitest run src/lib/db/schema/schema.test.ts
```

Expected: PASS.

- [ ] **Step 10: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/db/schema/auth.ts src/lib/db/schema/articles.ts src/lib/db/schema/jobs.ts src/lib/db/schema/feeds.ts src/lib/auth/server.ts drizzle/ src/lib/db/schema/schema.test.ts
git commit -m "feat(schema): add device sessions, tombstones, runs, and logo hash columns"
```

---

### Task 2: Per-user event bus (`src/lib/api/events.ts`)

**Files:**
- Create: `src/lib/api/events.ts`
- Test: `src/lib/api/events.test.ts`

**Interfaces:**
- Consumes: nothing (only `node:events`)
- Produces: `publishUserEvent(userId: string, event: ApiEvent): void`, `subscribeUserEvents(userId: string, listener: (event: ApiEvent) => void): () => void`, and the `ApiEvent` union type — consumed by Task 3 (queue.ts) and Task 20 (SSE route)

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/api/events.test.ts
import { describe, expect, it, vi } from "vitest";

import { publishUserEvent, subscribeUserEvents } from "./events";

describe("events", () => {
  it("delivers a published event only to that user's subscribers", () => {
    const heardByA = vi.fn();
    const heardByB = vi.fn();
    subscribeUserEvents("user-a", heardByA);
    subscribeUserEvents("user-b", heardByB);

    publishUserEvent("user-a", { type: "job", payload: { jobId: 1, runId: null, kind: "article.reload", status: "completed", progress: 100 } });

    expect(heardByA).toHaveBeenCalledTimes(1);
    expect(heardByB).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe", () => {
    const heard = vi.fn();
    const unsubscribe = subscribeUserEvents("user-c", heard);
    unsubscribe();

    publishUserEvent("user-c", { type: "run", payload: { runId: 1, status: "completed", totalJobs: 1, completedJobs: 1, failedJobs: 0 } });

    expect(heard).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/api/events.test.ts
```

Expected: FAIL — `Cannot find module './events'`.

- [ ] **Step 3: Implement**

```ts
// src/lib/api/events.ts
import { EventEmitter } from "node:events";

/**
 * In-process pub/sub for phase 13's SSE notification (`/api/v1/jobs/events`).
 * No Redis, consistent with the job queue it rides on top of being a single
 * process with no broker of its own. Not the source of truth — a dropped
 * connection loses nothing but low-latency notification, since the jobs/runs
 * tables are what a client falls back to polling.
 */
const emitter = new EventEmitter();
// One user's aggregation trigger can fan out into dozens of jobs; each
// completion is one emit, so the default limit of 10 listeners would log a
// spurious warning under ordinary use, not under a leak.
emitter.setMaxListeners(0);

export type ApiEvent =
  | {
      type: "job";
      payload: { jobId: number; runId: number | null; kind: string; status: string; progress: number };
    }
  | {
      type: "run";
      payload: { runId: number; status: string; totalJobs: number; completedJobs: number; failedJobs: number };
    };

function channel(userId: string): string {
  return `user:${userId}`;
}

export function publishUserEvent(userId: string, event: ApiEvent): void {
  emitter.emit(channel(userId), event);
}

/** Returns an unsubscribe function. */
export function subscribeUserEvents(userId: string, listener: (event: ApiEvent) => void): () => void {
  const name = channel(userId);
  emitter.on(name, listener);
  return () => emitter.off(name, listener);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/lib/api/events.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/events.ts src/lib/api/events.test.ts
git commit -m "feat(api): add per-user event bus for job/run notifications"
```

---

### Task 3: Job queue run-tracking and event publishing

**Files:**
- Modify: `src/lib/jobs/queue.ts`
- Test: `src/lib/jobs/queue.test.ts` (extend if it exists — check first; if it doesn't, create it)

**Interfaces:**
- Consumes: `publishUserEvent` from Task 2 (`@/lib/api/events`); `runs`, `articles`, `feeds` from `@/lib/db/schema` (Task 1)
- Produces: `enqueueRun(userId: string, kind: string, payloads: Record<string, unknown>[]): number` (returns the new run's id) — consumed by Task 18 (`POST /api/v1/aggregate`); `getRun(id: number): Run | null` — consumed by Task 19 (`GET /api/v1/runs/:id`) and internally by `complete()`/`fail()`
- Modifies behavior of: `complete(id)`, `fail(id, error)` — now also bump a parent run's counters and publish events when applicable. `claim()`, `progress()`, `resetOrphaned()`, `getJob()`, `listJobs()` are unchanged.

- [ ] **Step 1: Write the failing tests**

Check `src/lib/jobs/queue.test.ts` first — if it exists, add these `describe` blocks to it; if not, create it importing whatever pattern `src/lib/jobs/worker.test.ts` (if present) or `src/lib/feeds/actions.test.ts` uses for a real, migrated temp database (no mocks):

```ts
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/lib/db/client";
import { feeds, jobs, runs, users } from "@/lib/db/schema";
import { complete, enqueueRun, fail, getRun } from "./queue";

// (Place inside whatever beforeEach/temp-database setup the rest of this
// file already uses — see Task 1's pattern from src/lib/feeds/actions.test.ts
// for seeding a user and a feed for real if this file has no such setup yet.)

describe("enqueueRun / run tracking", () => {
  it("creates a run row with totalJobs matching the payload count", () => {
    const userId = seedUserAndReturnId(); // reuse this file's own seeding helper
    const runId = enqueueRun(userId, "aggregate", [{ feedId: 1 }, { feedId: 2 }]);

    const run = getRun(runId);
    expect(run?.totalJobs).toBe(2);
    expect(run?.completedJobs).toBe(0);
    expect(run?.status).toBe("running");

    const createdJobs = getDb().select().from(jobs).where(eq(jobs.runId, runId)).all();
    expect(createdJobs).toHaveLength(2);
    expect(createdJobs.every((j) => j.kind === "aggregate")).toBe(true);
  });

  it("marks the run completed once every child job completes", () => {
    const userId = seedUserAndReturnId();
    const runId = enqueueRun(userId, "aggregate", [{ feedId: 1 }, { feedId: 2 }]);
    const childJobs = getDb().select().from(jobs).where(eq(jobs.runId, runId)).all();

    complete(childJobs[0].id);
    expect(getRun(runId)?.status).toBe("running");

    complete(childJobs[1].id);
    expect(getRun(runId)?.status).toBe("completed");
    expect(getRun(runId)?.finishedAt).not.toBeNull();
  });

  it("marks the run failed if any child job fails", () => {
    const userId = seedUserAndReturnId();
    const runId = enqueueRun(userId, "aggregate", [{ feedId: 1 }, { feedId: 2 }]);
    const childJobs = getDb().select().from(jobs).where(eq(jobs.runId, runId)).all();

    complete(childJobs[0].id);
    fail(childJobs[1].id, "boom"); // exhausts maxAttempts=3 by default; see note below

    // fail() retries up to maxAttempts before going terminal — this test
    // should enqueue with maxAttempts: 1 via a direct jobs.update if
    // enqueueRun doesn't expose per-job maxAttempts (it doesn't, by design:
    // every job in a run gets the same default). Adjust by calling
    // getDb().update(jobs).set({ maxAttempts: 1 }).where(eq(jobs.id, childJobs[1].id)).run()
    // before calling fail(), so the first failure is already terminal.
    expect(getRun(runId)?.status).toBe("failed");
  });
});
```

Adjust the `seedUserAndReturnId()` reference to whatever this file's real seeding helper is named — do not invent a new one if `queue.test.ts` doesn't have a database fixture yet; in that case, copy the `beforeEach`/`seedUser` pattern from `src/lib/feeds/actions.test.ts:77-89` verbatim (temp `DATABASE_PATH`, `applyMigrationsAt`, `createUserWithPassword`).

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/lib/jobs/queue.test.ts
```

Expected: FAIL — `enqueueRun`/`getRun` are not exported yet.

- [ ] **Step 3: Implement**

In `src/lib/jobs/queue.ts`, add imports and the new functions:

```ts
import { and, asc, count, desc, eq, lte, sql } from "drizzle-orm";

import { writeTransaction, getDb } from "../db/client";
import { articles, feeds, jobs, runs } from "../db/schema";
import type { Job, Run } from "../db/schema";
import { publishUserEvent } from "../api/events";
```

Add near the bottom, before `getJob`:

```ts
export function enqueueRun(userId: string, kind: string, payloads: Record<string, unknown>[]): number {
  return writeTransaction((db) => {
    const run = db
      .insert(runs)
      .values({ userId, status: "running", totalJobs: payloads.length })
      .returning({ id: runs.id })
      .get();

    if (payloads.length > 0) {
      db.insert(jobs)
        .values(payloads.map((payload) => ({ kind, payload, runId: run.id })))
        .run();
    }

    return run.id;
  });
}

export function getRun(id: number): Run | null {
  return getDb().select().from(runs).where(eq(runs.id, id)).get() ?? null;
}

/** Which user a job's completion/failure should notify, or null if none applies. */
function resolveJobUserId(job: Job): string | null {
  if (job.runId !== null) {
    const run = getDb().select({ userId: runs.userId }).from(runs).where(eq(runs.id, job.runId)).get();
    return run?.userId ?? null;
  }
  if (job.kind === "article.reload") {
    const articleId = Number(job.payload?.articleId);
    if (!articleId) return null;
    const row = getDb()
      .select({ userId: feeds.userId })
      .from(articles)
      .innerJoin(feeds, eq(articles.feedId, feeds.id))
      .where(eq(articles.id, articleId))
      .get();
    return row?.userId ?? null;
  }
  // Other job kinds (feed.logo, feed.update, feed.restore, retention) are
  // internal maintenance the client API never triggers and never needs to
  // hear about.
  return null;
}

function bumpRunCounters(
  tx: ReturnType<typeof getDb>,
  runId: number,
  outcome: "completed" | "failed",
): void {
  if (outcome === "completed") {
    tx.update(runs).set({ completedJobs: sql`${runs.completedJobs} + 1` }).where(eq(runs.id, runId)).run();
  } else {
    tx.update(runs).set({ failedJobs: sql`${runs.failedJobs} + 1` }).where(eq(runs.id, runId)).run();
  }

  const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) return;

  if (run.completedJobs + run.failedJobs >= run.totalJobs) {
    tx.update(runs)
      .set({ status: run.failedJobs > 0 ? "failed" : "completed", finishedAt: new Date() })
      .where(eq(runs.id, runId))
      .run();
  }
}

function publishJobOutcome(job: Job, status: "completed" | "failed"): void {
  const userId = resolveJobUserId(job);
  if (!userId) return;

  publishUserEvent(userId, {
    type: "job",
    payload: { jobId: job.id, runId: job.runId, kind: job.kind, status, progress: status === "completed" ? 100 : job.progress },
  });

  if (job.runId !== null) {
    const run = getRun(job.runId);
    if (run) {
      publishUserEvent(userId, {
        type: "run",
        payload: {
          runId: run.id,
          status: run.status,
          totalJobs: run.totalJobs,
          completedJobs: run.completedJobs,
          failedJobs: run.failedJobs,
        },
      });
    }
  }
}
```

Now modify `complete()` and the terminal branch of `fail()` to call these. `complete()` becomes:

```ts
export function complete(id: number): void {
  const job = writeTransaction((db) => {
    const current = db.select().from(jobs).where(eq(jobs.id, id)).get();
    db.update(jobs)
      .set({ status: "completed", finishedAt: new Date(), progress: 100 })
      .where(eq(jobs.id, id))
      .run();
    if (current?.runId !== null && current?.runId !== undefined) {
      bumpRunCounters(db, current.runId, "completed");
    }
    return current;
  });

  if (job) publishJobOutcome({ ...job, status: "completed", progress: 100 }, "completed");
}
```

And in `fail()`, in the branch that sets `status: "failed"` (attempts exhausted), add the same publish call. Modify only that branch — the retry (non-terminal) branch is unchanged:

```ts
export function fail(id: number, error: string | Error): void {
  const errMsg = typeof error === "string" ? error : error?.message || String(error);
  const now = new Date();

  const outcome = writeTransaction((db) => {
    const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) return null;

    if (job.attempts >= job.maxAttempts) {
      db.update(jobs)
        .set({ status: "failed", finishedAt: now, error: errMsg })
        .where(eq(jobs.id, id))
        .run();
      if (job.runId !== null) bumpRunCounters(db, job.runId, "failed");
      return { job, terminal: true as const };
    }

    const backoffMs = Math.pow(2, Math.max(0, job.attempts - 1)) * 60_000;
    const nextRunAt = new Date(now.getTime() + backoffMs);
    db.update(jobs)
      .set({ status: "pending", startedAt: null, runAt: nextRunAt, error: errMsg })
      .where(eq(jobs.id, id))
      .run();
    return { job, terminal: false as const };
  });

  if (outcome?.terminal) publishJobOutcome({ ...outcome.job, status: "failed" }, "failed");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/jobs/queue.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full jobs suite to check nothing else broke**

```bash
npx vitest run src/lib/jobs
```

Expected: PASS — `complete()`/`fail()`'s existing callers (the worker, other job handlers' tests) still work; the run-tracking branches are all `if (job.runId !== null)`-guarded no-ops for jobs with no run.

- [ ] **Step 6: Commit**

```bash
git add src/lib/jobs/queue.ts src/lib/jobs/queue.test.ts
git commit -m "feat(jobs): track aggregation runs and publish completion events"
```

---

### Task 4: Retention job writes tombstones before deleting

**Files:**
- Modify: `src/lib/jobs/handlers/retention.ts`
- Test: `src/lib/jobs/handlers/retention.test.ts` (extend if present, else create)

**Interfaces:**
- Consumes: `articleTombstones` from `@/lib/db/schema` (Task 1)
- Produces: no new exports — same `handleRetentionJob(job: Job): Promise<void>` signature, now also populates `article_tombstones` and prunes tombstones past the retention window

- [ ] **Step 1: Write the failing test**

```ts
// add to src/lib/jobs/handlers/retention.test.ts
it("writes a tombstone for every article it deletes", async () => {
  // ... reuse this file's existing seeding for a user, a feed, and an
  // old, unstarred article past the retention cutoff ...
  await handleRetentionJob({} as Job);

  const tombstones = getDb().select().from(articleTombstones).all();
  expect(tombstones).toHaveLength(1);
  expect(tombstones[0].articleId).toBe(oldArticleId);
  expect(tombstones[0].userId).toBe(userId);

  const remaining = getDb().select().from(articles).where(eq(articles.id, oldArticleId)).all();
  expect(remaining).toHaveLength(0);
});

it("prunes tombstones older than the retention window", async () => {
  // Seed a tombstone whose deletedAt already predates the cutoff...
  writeTransaction((tx) =>
    tx.insert(articleTombstones).values({
      articleId: 999,
      userId,
      deletedAt: new Date(Date.now() - 999 * 24 * 60 * 60_000),
    }).run(),
  );

  await handleRetentionJob({} as Job);

  const remaining = getDb().select().from(articleTombstones).where(eq(articleTombstones.articleId, 999)).all();
  expect(remaining).toHaveLength(0);
});
```

Fill in the seeding calls to match whatever this file's existing tests already set up (a user, `user_settings`, a feed, an old article) — read the current file first; do not duplicate seeding helpers it already has.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/lib/jobs/handlers/retention.test.ts
```

Expected: FAIL (no tombstones written yet).

- [ ] **Step 3: Implement**

Rewrite `src/lib/jobs/handlers/retention.ts`:

```ts
import { and, eq, inArray, lte } from "drizzle-orm";

import { getDb, writeTransaction } from "@/lib/db/client";
import { articleTombstones, articles, feeds, userSettings, type Job } from "@/lib/db/schema";

const RETENTION_TOMBSTONE_DAYS = 90;

function deleteWithTombstones(
  db: ReturnType<typeof getDb>,
  userId: string,
  feedIds: number[],
  cutoff: Date,
): void {
  const doomed = db
    .select({ id: articles.id })
    .from(articles)
    .where(and(inArray(articles.feedId, feedIds), eq(articles.starred, false), lte(articles.createdAt, cutoff)))
    .all();

  if (doomed.length === 0) return;

  db.insert(articleTombstones)
    .values(doomed.map((a) => ({ articleId: a.id, userId })))
    .run();

  db.delete(articles)
    .where(inArray(articles.id, doomed.map((a) => a.id)))
    .run();
}

export async function handleRetentionJob(_job: Job): Promise<void> {
  const db = getDb();
  const settingsList = db.select().from(userSettings).all();

  const defaultRetentionDays = 60;

  if (settingsList.length === 0) {
    // No per-user settings rows exist (a database with no users at all).
    // Nothing to tombstone as there is no owner to attribute one to.
  } else {
    for (const settings of settingsList) {
      const retentionDays = settings.articleRetentionDays ?? defaultRetentionDays;
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60_000);

      const userFeeds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, settings.userId)).all();
      const feedIds = userFeeds.map((f) => f.id);
      if (feedIds.length === 0) continue;

      writeTransaction((tx) => deleteWithTombstones(tx, settings.userId, feedIds, cutoff));
    }
  }

  // Tombstones themselves can't usefully outlive the window a sync cursor
  // can still trust (src/lib/api/sync.ts's cursor-expiry check) — see the
  // design doc, §2.
  const tombstoneCutoff = new Date(Date.now() - RETENTION_TOMBSTONE_DAYS * 24 * 60 * 60_000);
  writeTransaction((tx) => {
    tx.delete(articleTombstones).where(lte(articleTombstones.deletedAt, tombstoneCutoff)).run();
  });
}
```

Note this drops the old "no settings rows exist -> delete everything past a hardcoded 60-day cutoff with no owner" branch's *unattributed* deletes (the original code deleted with no tombstone at all in that branch, because there was no `userId` to attribute one to). Since every real installation has at least the bootstrap admin's `user_settings` row (per `ensureAdminExists()`), this branch is effectively dead in production; it's kept only so a database with zero users doesn't throw, and it does not tombstone (there is no owner). This is a narrower behavior than before (previously it deleted broadly with no tombstones at all in that branch); confirm this matches intent, or ask before shipping if any test currently exercises that branch expecting the old behavior.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/jobs/handlers/retention.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/jobs/handlers/retention.ts src/lib/jobs/handlers/retention.test.ts
git commit -m "feat(jobs): tombstone articles the retention job deletes"
```

---

### Task 5: Feed deletion writes tombstones before cascading

**Files:**
- Modify: `src/lib/feeds/actions.ts` (the `deleteFeeds` function, currently at line 367)
- Test: `src/lib/feeds/actions.test.ts` (extend)

**Interfaces:**
- Consumes: `articleTombstones` (Task 1)
- Produces: no signature change to `deleteFeeds(ids: number[]): Promise<{ ok: boolean; deleted: number }>`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/feeds/actions.test.ts` (in whatever `describe` block already covers `deleteFeeds`, or a new one):

```ts
it("tombstones every article belonging to a deleted feed", async () => {
  const userId = await currentUserId();
  const feed = await actions.createFeed({ name: "Doomed", aggregator: "full_website", identifier: "https://example.com" });
  // seed one article on that feed directly via raw(client.getDb())...
  raw(client.getDb()).exec(
    `INSERT INTO articles (name, identifier, date, feed_id) VALUES ('A', 'a1', ${Math.floor(Date.now() / 1000)}, ${feed.id})`,
  );
  const articleId = raw(client.getDb()).prepare("SELECT id FROM articles WHERE feed_id = ?").get(feed.id).id;

  await actions.deleteFeeds([feed.id]);

  const tombstones = raw(client.getDb())
    .prepare("SELECT * FROM article_tombstones WHERE article_id = ?")
    .all(articleId);
  expect(tombstones).toHaveLength(1);
  expect(tombstones[0].user_id).toBe(userId);
});
```

Adjust field/return shapes (`createFeed`'s exact return type, `currentUserId()`'s exact call form) to match what this file's existing tests actually use — read the surrounding tests before writing this one; do not guess at a signature this file doesn't already exercise.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/feeds/actions.test.ts -t "tombstones every article"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Replace `deleteFeeds` (currently `src/lib/feeds/actions.ts:367-380`):

```ts
export async function deleteFeeds(ids: number[]) {
  if (ids.length === 0) return { ok: true, deleted: 0 };

  const userId = await currentUserId();

  return writeTransaction((tx) => {
    const ownedFeeds = tx
      .select({ id: feeds.id })
      .from(feeds)
      .where(and(inArray(feeds.id, ids), eq(feeds.userId, userId)))
      .all();
    const ownedFeedIds = ownedFeeds.map((f) => f.id);

    if (ownedFeedIds.length > 0) {
      const doomedArticles = tx
        .select({ id: articles.id })
        .from(articles)
        .where(inArray(articles.feedId, ownedFeedIds))
        .all();

      if (doomedArticles.length > 0) {
        tx.insert(articleTombstones)
          .values(doomedArticles.map((a) => ({ articleId: a.id, userId })))
          .run();
      }
    }

    const result = tx
      .delete(feeds)
      .where(and(inArray(feeds.id, ids), eq(feeds.userId, userId)))
      .run();
    revalidatePath("/feeds");
    return { ok: true, deleted: result.changes };
  });
}
```

Add `articles` and `articleTombstones` to this file's existing import from `@/lib/db/schema` at the top.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/lib/feeds/actions.test.ts -t "tombstones every article"
```

Expected: PASS.

- [ ] **Step 5: Run the whole file to confirm no regression**

```bash
npx vitest run src/lib/feeds/actions.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/feeds/actions.ts src/lib/feeds/actions.test.ts
git commit -m "feat(feeds): tombstone articles when their feed is deleted"
```

---

### Task 6: Feed logos become content-addressed

**Files:**
- Modify: `src/lib/feeds/logo.ts` (`storeLogo`)
- Test: `src/lib/feeds/logo.test.ts` (extend)

**Interfaces:**
- Consumes: `storeImageBytes` from `@/lib/aggregators/images/store` (already exists)
- Produces: `storeLogo(feedId: number, bytes: Buffer, sourceUrl: string): Promise<string>` — same signature, now returns the content **hash** instead of a relative file path, and sets `feeds.logoImageHash` instead of `feeds.logo`

- [ ] **Step 1: Write the failing test**

`src/lib/feeds/logo.test.ts` currently has **no database fixture at all** — its existing tests (`pickBestIcon`, `removeWhiteBackground`) are pure functions with no `beforeEach`/temp database. `storeLogo` needs a real migrated database and a real feed row, so add this fixture alongside the existing tests rather than assuming one exists:

```ts
import { eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

import { pickBestIcon, removeWhiteBackground, storeLogo } from "./logo";

describe("storeLogo", () => {
  let dbPath: string;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let feedId: number;

  beforeEach(async () => {
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-logo-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");

    const { createUserWithPassword } = await import("@/lib/auth/server");
    const user = await createUserWithPassword({ email: "a@example.com", password: "correct horse battery staple" });
    const feed = client.writeTransaction((tx) =>
      tx
        .insert(schema.feeds)
        .values({ name: "F", aggregator: "full_website", identifier: "https://x.example", userId: user.id })
        .returning({ id: schema.feeds.id })
        .get(),
    );
    feedId = feed.id;
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  async function solidWhitePng() {
    return await (await import("sharp")).default({
      create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    }).png().toBuffer();
  }

  it("stores the logo content-addressed and sets logoImageHash", async () => {
    const bytes = await solidWhitePng();
    const hash = await storeLogo(feedId, bytes, "https://example.com/favicon.ico");

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const feed = client.getDb().select().from(schema.feeds).where(eq(schema.feeds.id, feedId)).get();
    expect(feed?.logoImageHash).toBe(hash);
    expect(feed?.logoSourceUrl).toBe("https://example.com/favicon.ico");

    const image = client
      .getDb()
      .select()
      .from(schema.articleImages)
      .where(eq(schema.articleImages.contentHash, hash))
      .get();
    expect(image).toBeDefined();
  });

  it("dedupes two feeds with an identical favicon", async () => {
    const { createUserWithPassword } = await import("@/lib/auth/server");
    const otherUser = await createUserWithPassword({ email: "b@example.com", password: "correct horse battery staple" });
    const otherFeed = client.writeTransaction((tx) =>
      tx
        .insert(schema.feeds)
        .values({ name: "G", aggregator: "full_website", identifier: "https://y.example", userId: otherUser.id })
        .returning({ id: schema.feeds.id })
        .get(),
    );

    const bytes = await solidWhitePng();
    const hashA = await storeLogo(feedId, bytes, "https://a.example.com/favicon.ico");
    const hashB = await storeLogo(otherFeed.id, bytes, "https://b.example.com/favicon.ico");

    expect(hashA).toBe(hashB);
    const rows = client
      .getDb()
      .select()
      .from(schema.articleImages)
      .where(eq(schema.articleImages.contentHash, hashA))
      .all();
    expect(rows).toHaveLength(1);
  });
});
```

Note this reuses `solidWhitePng()`'s *shape* from the file's existing helper of the same name (line 6) but redeclares it locally inside the new `describe` block via a dynamic `sharp` import, since the existing top-level `solidWhitePng()` already does exactly this — if hoisting the existing top-level helper into this block works without conflict, prefer that over the duplicate; check when writing this.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/lib/feeds/logo.test.ts
```

Expected: FAIL — `logoImageHash` doesn't exist yet on the returned feed, `storeLogo` still returns a path.

- [ ] **Step 3: Implement**

Replace `storeLogo` in `src/lib/feeds/logo.ts`:

```ts
import { storeImageBytes } from "../aggregators/images/store";
import { writeTransaction } from "../db/client";
import { feeds } from "../db/schema";

// (drop the old `path`/`mediaRoot` imports from this function's old body if
// nothing else in this file still needs them — `removeWhiteBackground` and
// `discoverLogo` above don't, so check whether `path`/`fs` are still used
// elsewhere in the file before removing their imports entirely.)

export async function storeLogo(feedId: number, bytes: Buffer, sourceUrl: string): Promise<string> {
  let processed = await removeWhiteBackground(bytes);

  processed = await sharp(processed)
    .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp()
    .toBuffer();

  const contentHash = await storeImageBytes(processed, "image/webp", { compress: false });
  if (!contentHash) {
    throw new Error(`storeLogo: storeImageBytes refused feed ${feedId}'s logo bytes`);
  }

  writeTransaction((tx) => {
    tx.update(feeds)
      .set({ logoImageHash: contentHash, logoSourceUrl: sourceUrl })
      .where(eq(feeds.id, feedId))
      .run();
  });

  return contentHash;
}
```

`compress: false` because this function already resized/re-encoded to WebP itself (`storeImageBytes`'s own compression path is for raw fetched bytes, not for output this function has already finished processing) — passing `compress: true` here would double-process a 128×128 WebP through `compressImage()` for no benefit. Keep the `eq` import from `drizzle-orm` (already imported in this file for the old version).

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/feeds/logo.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the handler's test too**

```bash
npx vitest run src/lib/jobs/handlers/logo.test.ts
```

Expected: PASS — `handleLogoJob` calls `storeLogo` unchanged; only the returned value's shape and the column written differ, both internal to `storeLogo`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/feeds/logo.ts src/lib/feeds/logo.test.ts
git commit -m "feat(feeds): store feed logos content-addressed, like article images"
```

---

### Task 7: Drop `feeds.logo` and update the web UI

**Files:**
- Modify: `src/lib/db/schema/feeds.ts` (remove the `logo` column)
- Modify: `src/components/feeds/feeds-table.tsx` (line 44, render `logoImageHash` via the new image route instead of `logo`)
- Create: `drizzle/0006_<generated_name>.sql`
- Test: `src/components/feeds/feeds-table.test.tsx` (check first — update if it asserts on the old `logo` field)

**Interfaces:**
- Consumes: `logoImageHash` (Task 1/6); the `/api/v1/images/:hash` route this points at doesn't exist until Task 23, but that's fine — `<img src>` pointing at a route that 404s until then doesn't break the build or this task's own tests, which only assert on the rendered `src` attribute.
- Produces: `feeds` no longer has a `logo` column or Drizzle property.

- [ ] **Step 1: Remove the column**

In `src/lib/db/schema/feeds.ts`, delete this line entirely:

```ts
    logo: text("logo"),
```

- [ ] **Step 2: Generate the migration**

```bash
npx drizzle-kit generate
```

Expected: a **new** migration file containing only `ALTER TABLE feeds DROP COLUMN logo;` (or SQLite's rebuild-table equivalent — drizzle-kit may emit a full 12-step table rebuild for a SQLite column drop; either is fine, don't hand-edit it). No interactive prompt, because this generate call's diff is a pure drop with no add on the same table (the add happened in Task 1's migration, already applied).

- [ ] **Step 3: Update the web UI**

In `src/components/feeds/feeds-table.tsx`, change line 44:

```tsx
          {row.logoImageHash ? (
            <AvatarImage src={`/api/v1/images/${row.logoImageHash}`} alt={row.name} />
          ) : null}
```

- [ ] **Step 4: Check and fix the component test**

```bash
npx vitest run src/components/feeds/feeds-table.test.tsx
```

If it fails on a `logo` field in fixture data, update the fixture to use `logoImageHash` instead. If it passes unchanged, still open the file and confirm no fixture still shapes a `Feed` row with a stale `logo` property (that would typecheck-fail separately).

- [ ] **Step 5: Typecheck the whole project**

```bash
npm run typecheck
```

Expected: PASS — this is the step that catches any other stale `.logo` reference this plan's earlier `grep` missed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/schema/feeds.ts src/components/feeds/feeds-table.tsx drizzle/ src/components/feeds/feeds-table.test.tsx
git commit -m "feat(feeds): drop the file-path logo column, now content-addressed"
```

---

### Task 8: `src/lib/api/auth.ts` — Bearer/cookie resolution for `/api/v1/**`

**Files:**
- Create: `src/lib/api/auth.ts`
- Test: `src/lib/api/auth.test.ts`

**Interfaces:**
- Consumes: `sessions`, `users` from `@/lib/db/schema`; `auth` from `@/lib/auth/server`
- Produces: `class ApiError extends Error { status: number; code: string }`, `apiErrorResponse(error: ApiError): Response`, `requireApiUser(request: Request): Promise<User>` — consumed by every route in Tasks 14–23

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/api/auth.test.ts
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyMigrationsAt } from "@/lib/db/test-support";

describe("requireApiUser", () => {
  let dbPath: string;
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let apiAuth: typeof import("./auth");

  beforeEach(async () => {
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-api-auth-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    client = await import("@/lib/db/client");
    apiAuth = await import("./auth");
  });

  afterEach(() => {
    fs.rmSync(dbPath, { force: true });
  });

  it("resolves a valid device session token to its user", async () => {
    const user = await createUserWithPassword({ email: "a@example.com", password: "correct horse battery staple" });
    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession(user.id, false, { deviceName: "Test iPhone" });

    const request = new Request("https://example.com/api/v1/feeds", {
      headers: { authorization: `Bearer ${session.token}` },
    });

    const resolved = await apiAuth.requireApiUser(request);
    expect(resolved.id).toBe(user.id);
  });

  it("rejects a missing or garbage token", async () => {
    const request = new Request("https://example.com/api/v1/feeds", {
      headers: { authorization: "Bearer not-a-real-token" },
    });

    await expect(apiAuth.requireApiUser(request)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects with no Authorization header and no cookie", async () => {
    const request = new Request("https://example.com/api/v1/feeds");
    await expect(apiAuth.requireApiUser(request)).rejects.toMatchObject({ status: 401 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/lib/api/auth.test.ts
```

Expected: FAIL — `Cannot find module './auth'`.

- [ ] **Step 3: Implement**

```ts
// src/lib/api/auth.ts
import { and, eq, gt } from "drizzle-orm";

import { auth } from "@/lib/auth/server";
import { getDb } from "@/lib/db/client";
import { sessions, users, type User } from "@/lib/db/schema";

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export function apiErrorResponse(error: ApiError): Response {
  return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
}

function userForBearerToken(token: string): User | null {
  const row = getDb()
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .get();
  return row?.user ?? null;
}

/**
 * Resolve the caller of an `/api/v1/**` request.
 *
 * Bearer first (the native client's device session token, minted by
 * `/device/pair` — see Task 9). Falling back to the ordinary cookie session
 * when there's no Authorization header is what lets `/api/v1/images/:hash`
 * serve the web UI's own `<img>` tags (feed logos, article images) through
 * the same route the native client uses, without a second image-serving
 * mechanism.
 */
export async function requireApiUser(request: Request): Promise<User> {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    const user = token ? userForBearerToken(token) : null;
    if (!user) throw new ApiError(401, "unauthorized", "Invalid or expired token.");
    return user;
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) throw new ApiError(401, "unauthorized", "Sign in required.");
  return session.user as User;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/api/auth.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/auth.ts src/lib/api/auth.test.ts
git commit -m "feat(api): resolve /api/v1 callers from a Bearer device session or cookie"
```

---

### Task 9: Device pairing route (`GET /device/pair`)

**Files:**
- Modify: `src/lib/auth/server.ts` (add `createDeviceSession` export)
- Create: `src/app/device/pair/route.ts`
- Test: `src/app/device/pair/route.test.ts`

**Interfaces:**
- Consumes: `requireUser` from `@/lib/auth/session`
- Produces: `createDeviceSession(userId: string, deviceName: string): Promise<{ token: string }>` (exported from `@/lib/auth/server`, also used directly by Task 8's-adjacent tests and any later test needing a device token without going through this HTTP route)

- [ ] **Step 1: Write the failing test**

```ts
// src/app/device/pair/route.test.ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyMigrationsAt } from "@/lib/db/test-support";

const { requestHeaders, cookieJar } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  cookieJar: new Map<string, string>(),
}));

vi.mock("next/headers", async () => (await import("@/test/next-headers")).nextHeadersStub(requestHeaders, cookieJar));

describe("GET /device/pair", () => {
  let dbPath: string;
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let signInCookie: typeof import("@/lib/auth/test-support").signInCookie;
  let GET: typeof import("./route").GET;
  let client: typeof import("@/lib/db/client");

  beforeEach(async () => {
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-device-pair-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    ({ signInCookie } = await import("@/lib/auth/test-support"));
    client = await import("@/lib/db/client");
    ({ GET } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  it("mints a device session and redirects to the custom scheme with its token", async () => {
    const user = await createUserWithPassword({ email: "a@example.com", password: "correct horse battery staple" });
    (client.getDb() as unknown as { $client: import("better-sqlite3").Database }).$client.exec(
      `INSERT INTO user_settings (user_id) VALUES ('${user.id}')`,
    );
    const cookie = await signInCookie(auth, { email: "a@example.com", password: "correct horse battery staple" });
    requestHeaders.current = new Headers({ cookie });

    const request = new Request("https://example.com/device/pair?scheme=yana&deviceName=Test%20iPhone");
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("yana://auth-callback?token=")).toBe(true);

    const token = new URL(location.replace("yana://", "https://")).searchParams.get("token");
    const row = client
      .getDb()
      .select()
      .from((await import("@/lib/db/schema")).sessions)
      .where(eq((await import("@/lib/db/schema")).sessions.token, token!))
      .get();
    expect(row?.deviceName).toBe("Test iPhone");
    expect(row?.userId).toBe(user.id);
  });

  it("redirects to /login when there is no session", async () => {
    requestHeaders.current = new Headers();
    const request = new Request("https://example.com/device/pair?scheme=yana&deviceName=X");
    await expect(GET(request)).rejects.toThrow(); // requireUser()'s redirect surfaces as a thrown Next redirect in this harness
  });
});
```

The second test's exact assertion depends on how `requireUser()`'s redirect behaves when called from a plain route handler rather than a page — verify by running it; if it instead returns a redirect Response rather than throwing, change the assertion to check `response.status === 307` and `Location` header `/login`. Don't guess further than that without running it.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/app/device/pair/route.test.ts
```

Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Add `createDeviceSession` to `src/lib/auth/server.ts`**

Add near `linkPasswordCredential`, at the bottom of the file before `export type Auth`:

```ts
/**
 * Mint a dedicated Better Auth session for a device, distinct from the
 * browser's own session token — see `sessions.deviceName` and the design
 * doc's §1. This is the credential `/device/pair` hands to the native app;
 * revoking it (via `auth.api.revokeSession`) is the entire device-management
 * story, because a device's Bearer token IS a session token.
 */
export async function createDeviceSession(userId: string, deviceName: string): Promise<{ token: string }> {
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId, false, { deviceName });
  return { token: session.token };
}
```

- [ ] **Step 4: Implement the route**

```ts
// src/app/device/pair/route.ts
import { createDeviceSession } from "@/lib/auth/server";
import { requireUser } from "@/lib/auth/session";

/**
 * The webview lands here right after signing in. Session-cookie-authenticated
 * (this route is reached inside a real browser navigation with the cookie
 * Better Auth just set) -- not a new auth mechanism, just `requireUser()`
 * like every other page in `(app)`.
 *
 * The redirect target is a custom URL scheme the native app registers and
 * intercepts before it ever becomes a network request
 * (`decidePolicyForNavigationAction` on the WKWebView side) -- see the design
 * doc §1 for why a device session, not a nonexistent "API key", is the
 * credential handed over here.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await requireUser();

  const url = new URL(request.url);
  const scheme = url.searchParams.get("scheme") || "yana";
  const deviceName = url.searchParams.get("deviceName") || "Unnamed device";

  const { token } = await createDeviceSession(user.id, deviceName);

  const callback = new URL(`${scheme}://auth-callback`);
  callback.searchParams.set("token", token);

  return Response.redirect(callback.toString(), 307);
}
```

Note: `Response.redirect()` validates its URL argument is parseable as a URL — a custom scheme like `yana://` is a valid absolute URL syntactically (scheme + authority), so this should work, but confirm by running the test; if the platform's `Response.redirect()` rejects non-http(s) schemes, fall back to `new Response(null, { status: 307, headers: { Location: callback.toString() } })` instead, which imposes no such restriction.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run src/app/device/pair/route.test.ts
```

Expected: PASS (adjusting the second test per Step 1's note if needed).

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/server.ts src/app/device/pair/route.ts src/app/device/pair/route.test.ts
git commit -m "feat(auth): add the device pairing route and createDeviceSession"
```

---

### Task 10: Device management data layer (list + revoke)

**Files:**
- Modify: `src/lib/account/queries.ts` (add `DeviceSummary`, `listDevices`, extend `AccountOverview`)
- Modify: `src/lib/account/actions.ts` (add `removeDevice`)
- Modify: `messages/en.json`, `messages/de.json` (add `account.devices.*` keys)
- Test: `src/lib/account/actions.test.ts` (extend, if a real-db test file for account actions exists at this path — check first)

**Interfaces:**
- Consumes: `auth.api.listSessions`, `auth.api.revokeSession` (Better Auth core, already unblocked by `disabledPaths`)
- Produces: `type DeviceSummary = { token: string; deviceName: string; createdAt: Date; updatedAt: Date }`; `listDevices(): Promise<DeviceSummary[]>`; `removeDevice(input: unknown): Promise<AccountResult>` — consumed by Task 11 (UI)

- [ ] **Step 1: Add the catalog keys first**

In `messages/en.json`, inside the `"account"` object, add a sibling to `"passkeys"`:

```json
    "devices": {
      "title": "Devices",
      "description": "Devices signed in to the Yana app. Revoking one signs it out immediately.",
      "empty": "No devices are paired yet.",
      "revoke": "Revoke",
      "revoked": "Device revoked",
      "revokeFailed": "Could not revoke that device",
      "pairedOn": "Paired {date}"
    },
```

Mirror the exact same keys with German values in `messages/de.json`, in the same position (the parity test enforces identical key sets — `npm test` will catch a mismatch, but match structure now to save a round trip):

```json
    "devices": {
      "title": "Geräte",
      "description": "Geräte, die bei der Yana-App angemeldet sind. Ein Widerruf meldet das Gerät sofort ab.",
      "empty": "Es sind noch keine Geräte gekoppelt.",
      "revoke": "Widerrufen",
      "revoked": "Gerät widerrufen",
      "revokeFailed": "Das Gerät konnte nicht widerrufen werden",
      "pairedOn": "Gekoppelt am {date}"
    },
```

- [ ] **Step 2: Write the failing test for the query/action layer**

Check whether `src/lib/account/actions.test.ts` exists (CLAUDE.md's testing section implies real-db tests exist for library code broadly, but confirm for this specific module before assuming its shape). If it exists, add:

```ts
it("lists paired devices and omits the browser's own session", async () => {
  const userId = await currentUserId(); // this file's existing helper, signed in via cookie
  const ctx = await (await import("@/lib/auth/server")).auth.$context;
  await ctx.internalAdapter.createSession(userId, false, { deviceName: "iPhone" });

  const { listDevices } = await import("./queries");
  const devices = await listDevices();

  expect(devices).toHaveLength(1);
  expect(devices[0].deviceName).toBe("iPhone");
});

it("revokes a device session by token", async () => {
  await currentUserId();
  const ctx = await (await import("@/lib/auth/server")).auth.$context;
  const session = await ctx.internalAdapter.createSession(await currentUserId(), false, { deviceName: "iPad" });

  const { removeDevice } = await import("./actions");
  const result = await removeDevice({ token: session.token });

  expect(result.ok).toBe(true);
  const { listDevices } = await import("./queries");
  expect(await listDevices()).toHaveLength(0);
});
```

If this test file doesn't exist yet for `account/actions.ts`, create it following `src/lib/feeds/actions.test.ts`'s exact boilerplate (temp `DATABASE_PATH`, `applyMigrationsAt`, `signInCookie`, `nextHeadersStub`) rather than inventing a new setup style.

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run src/lib/account/actions.test.ts -t "device"
```

Expected: FAIL — `listDevices`/`removeDevice` don't exist.

- [ ] **Step 4: Implement `listDevices` in `src/lib/account/queries.ts`**

```ts
export type DeviceSummary = {
  token: string;
  deviceName: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * This user's device sessions -- ordinary `sessions` rows with `deviceName`
 * set, as opposed to the browser's own session, which has none. Through
 * `auth.api.listSessions` for the same reason `listPasskeys()` above does:
 * it scopes to the caller's own session, one fewer place a missing
 * `WHERE user_id = ?` could leak.
 */
export async function listDevices(): Promise<DeviceSummary[]> {
  const allSessions = await auth.api.listSessions({ headers: await headers() });

  return allSessions
    .filter((session): session is typeof session & { deviceName: string } => Boolean(session.deviceName))
    .map((session) => ({
      token: session.token,
      deviceName: session.deviceName,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
```

Add `listDevices()` to `getAccountOverview()`'s returned object and to `AccountOverview`'s type:

```ts
export type AccountOverview = {
  user: User;
  passkeys: PasskeySummary[];
  devices: DeviceSummary[];
  hasPassword: boolean;
};

export async function getAccountOverview(): Promise<AccountOverview> {
  const user = await currentUserRow();

  return {
    user,
    passkeys: await listPasskeys(),
    devices: await listDevices(),
    hasPassword: hasPasswordCredential(user.id),
  };
}
```

- [ ] **Step 5: Implement `removeDevice` in `src/lib/account/actions.ts`**

Add near `removePasskey`, following the same "look it up, check ownership implicitly via the endpoint's own scoping, call the Better Auth endpoint, report" shape:

```ts
const deviceRef = z.object({ token: z.string().min(1) });

/**
 * Revoke a device session. Unlike `removePasskey`, there is no "last one"
 * guard here -- revoking every device just means re-pairing, never account
 * lockout, because the browser's own cookie session is untouched (it isn't
 * one of the sessions `deviceName` marks).
 */
export async function removeDevice(input: unknown): Promise<Result> {
  await requireUser();
  const parsed = deviceRef.safeParse(input);
  if (!parsed.success) return { ok: false };

  try {
    // `revokeSession` verifies the token belongs to the caller's own userId
    // before deleting it (see the endpoint's own implementation in
    // better-auth); a token naming someone else's device session is refused
    // by the library, not by a WHERE clause written here.
    await auth.api.revokeSession({ body: { token: parsed.data.token }, headers: await headers() });
  } catch (error) {
    console.error("Failed to revoke a device session", error);
    return { ok: false };
  }

  revalidatePath("/account");
  return { ok: true };
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx vitest run src/lib/account/actions.test.ts -t "device"
```

Expected: PASS.

- [ ] **Step 7: Run the message-parity test**

```bash
npx vitest run src/i18n/messages.test.ts
```

Expected: PASS — catches any key mismatch between `en.json`/`de.json` from Step 1.

- [ ] **Step 8: Commit**

```bash
git add src/lib/account/queries.ts src/lib/account/actions.ts messages/en.json messages/de.json src/lib/account/actions.test.ts
git commit -m "feat(account): list and revoke paired device sessions"
```

---

### Task 11: Device management UI

**Files:**
- Create: `src/components/account/device-section.tsx`
- Modify: `src/app/(app)/account/page.tsx` (render `<DeviceSection>`)
- Test: `src/components/account/device-section.test.tsx`

**Interfaces:**
- Consumes: `DeviceSummary` (Task 10), `removeDevice` action (Task 10), `attempt` from `@/lib/account/result`
- Produces: `<DeviceSection devices={DeviceSummary[]} />`

- [ ] **Step 1: Write the failing component test**

Model this closely on `src/components/account/passkey-section.test.tsx` — read it first for the exact `renderWithProviders()` call shape this project's `dom` project expects, then write:

```tsx
// src/components/account/device-section.test.tsx
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { DeviceSection } from "./device-section";

vi.mock("@/lib/account/actions", () => ({ removeDevice: vi.fn() }));

describe("DeviceSection", () => {
  it("lists devices and shows the empty state with none", () => {
    renderWithProviders(<DeviceSection devices={[]} />);
    expect(screen.getByText(/no devices are paired/i)).toBeInTheDocument();
  });

  it("renders a device row with a revoke button", () => {
    renderWithProviders(
      <DeviceSection
        devices={[{ token: "tok1", deviceName: "iPhone", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") }]}
      />,
    );
    expect(screen.getByText("iPhone")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /revoke/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/components/account/device-section.test.tsx
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement, modeled on `PasskeySection`**

```tsx
// src/components/account/device-section.tsx
"use client";

import { Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { removeDevice } from "@/lib/account/actions";
import { attempt } from "@/lib/account/result";
import type { DeviceSummary } from "@/lib/account/queries";

/**
 * List and revoke device sessions. There is no delete guard here the way
 * `PasskeySection` has one: revoking every device only means re-pairing --
 * the browser's own cookie session is a separate, unmarked session and is
 * never listed here (see `listDevices()`'s filter on `deviceName`).
 */
export function DeviceSection({ devices }: { devices: DeviceSummary[] }) {
  const t = useTranslations("account");
  const format = useFormatter();
  const router = useRouter();
  const [pending, start] = useTransition();

  function revoke(token: string) {
    start(async () => {
      const result = await attempt(() => removeDevice({ token }));
      if (result.ok) {
        toast.success(t("devices.revoked"));
        router.refresh();
      } else {
        toast.error(t("devices.revokeFailed"));
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("devices.title")}</CardTitle>
        <CardDescription>{t("devices.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {devices.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("devices.empty")}</p>
        ) : (
          devices.map((device) => (
            <div key={device.token} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Smartphone className="text-muted-foreground size-4" />
                <div>
                  <p className="text-sm font-medium">{device.deviceName}</p>
                  <p className="text-muted-foreground text-xs">
                    {t("devices.pairedOn", { date: format.dateTime(device.createdAt, { dateStyle: "medium" }) })}
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" disabled={pending} onClick={() => revoke(device.token)}>
                {t("devices.revoke")}
              </Button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Wire it into the account page**

In `src/app/(app)/account/page.tsx`, add the import and render it after `<PasskeySection>`:

```tsx
import { DeviceSection } from "@/components/account/device-section";
```

```tsx
async function Sections() {
  const { user, passkeys, devices, hasPassword } = await getAccountOverview();

  return (
    <div className="space-y-6">
      <ProfileSection user={{ id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, image: user.image }} />
      <PasswordSection hasPassword={hasPassword} />
      <PasskeySection passkeys={passkeys} hasPassword={hasPassword} />
      <DeviceSection devices={devices} />
    </div>
  );
}
```

And bump the `<CardSkeletonGroup count={3} />` fallback to `count={4}` to match the new fourth card.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run src/components/account/device-section.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/components/account/device-section.tsx src/components/account/device-section.test.tsx src/app/\(app\)/account/page.tsx
git commit -m "feat(account): add the device management UI"
```

---

### Task 12: `src/lib/api/serializers.ts`

**Files:**
- Create: `src/lib/api/serializers.ts`
- Test: `src/lib/api/serializers.test.ts`

**Interfaces:**
- Consumes: `Article`, `Feed`, `Tag` types from `@/lib/db/schema`
- Produces: `serializeArticleSummary(article: Article): ArticleSummaryWire`, `serializeFeed(feed: Feed, tagIds: number[]): FeedWire`, `serializeTag(tag: Tag): TagWire`, and their wire-type exports — consumed by Tasks 13–14, 21–22

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/api/serializers.test.ts
import { describe, expect, it } from "vitest";

import type { Article, Feed, Tag } from "@/lib/db/schema";
import { serializeArticleSummary, serializeFeed, serializeTag } from "./serializers";

const baseArticle: Article = {
  id: 1,
  name: "Title",
  identifier: "https://example.com/a",
  rawContent: "",
  plainText: "",
  date: new Date("2026-01-01T00:00:00Z"),
  read: false,
  starred: true,
  author: "",
  icon: null,
  feedId: 5,
  createdAt: new Date("2026-01-02T00:00:00Z"),
  updatedAt: new Date("2026-01-03T00:00:00Z"),
};

describe("serializeArticleSummary", () => {
  it("projects dates to ISO strings and keeps booleans", () => {
    const wire = serializeArticleSummary(baseArticle);
    expect(wire).toEqual({
      id: 1,
      feedId: 5,
      name: "Title",
      identifier: "https://example.com/a",
      date: "2026-01-01T00:00:00.000Z",
      author: "",
      icon: null,
      read: false,
      starred: true,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
  });
});

describe("serializeFeed", () => {
  it("attaches the given tagIds", () => {
    const feed = {
      id: 1,
      name: "Feed",
      aggregator: "full_website",
      identifier: "https://example.com",
      dailyLimit: 20,
      enabled: true,
      userId: "u1",
      redditSubredditId: null,
      youtubeChannelId: null,
      options: {},
      logoSourceUrl: "",
      logoImageHash: "abc123",
      createdAt: new Date(),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    } as Feed;

    expect(serializeFeed(feed, [1, 2])).toMatchObject({
      id: 1,
      tagIds: [1, 2],
      logoImageHash: "abc123",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("serializeTag", () => {
  it("projects id, name, color", () => {
    expect(serializeTag({ id: 1, name: "News", color: "red" } as Tag)).toEqual({ id: 1, name: "News", color: "red" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/api/serializers.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// src/lib/api/serializers.ts
import type { Article, Feed, Tag } from "@/lib/db/schema";

export interface ArticleSummaryWire {
  id: number;
  feedId: number;
  name: string;
  identifier: string;
  date: string;
  author: string;
  icon: string | null;
  read: boolean;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
}

export function serializeArticleSummary(article: Article): ArticleSummaryWire {
  return {
    id: article.id,
    feedId: article.feedId,
    name: article.name,
    identifier: article.identifier,
    date: article.date.toISOString(),
    author: article.author,
    icon: article.icon,
    read: article.read,
    starred: article.starred,
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
  };
}

export interface FeedWire {
  id: number;
  name: string;
  aggregator: string;
  identifier: string;
  enabled: boolean;
  dailyLimit: number;
  tagIds: number[];
  logoImageHash: string | null;
  updatedAt: string;
}

export function serializeFeed(feed: Feed, tagIds: number[]): FeedWire {
  return {
    id: feed.id,
    name: feed.name,
    aggregator: feed.aggregator,
    identifier: feed.identifier,
    enabled: feed.enabled,
    dailyLimit: feed.dailyLimit,
    tagIds,
    logoImageHash: feed.logoImageHash,
    updatedAt: feed.updatedAt.toISOString(),
  };
}

export interface TagWire {
  id: number;
  name: string;
  color: string;
}

export function serializeTag(tag: Tag): TagWire {
  return { id: tag.id, name: tag.name, color: tag.color };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/lib/api/serializers.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/serializers.ts src/lib/api/serializers.test.ts
git commit -m "feat(api): add wire serializers for articles, feeds, and tags"
```

---

### Task 13: `src/lib/api/sync.ts` — cursor + delta query

**Files:**
- Create: `src/lib/api/sync.ts`
- Test: `src/lib/api/sync.test.ts`

**Interfaces:**
- Consumes: `serializeArticleSummary` (Task 12); `articles`, `articleTombstones`, `feeds` from `@/lib/db/schema`
- Produces: `SyncCursor` type, `ZERO_CURSOR`, `encodeCursor`, `decodeCursor`, `syncArticles(userId: string, cursor: SyncCursor, limit: number): SyncResult` — consumed by Task 14

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/api/sync.test.ts
import { eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

describe("sync", () => {
  let dbPath: string;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let sync: typeof import("./sync");
  let userId: string;
  let feedId: number;

  beforeEach(async () => {
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-sync-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;

    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    sync = await import("./sync");

    const { createUserWithPassword } = await import("@/lib/auth/server");
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";
    const user = await createUserWithPassword({ email: "a@example.com", password: "correct horse battery staple" });
    userId = user.id;

    const feed = client.writeTransaction((tx) =>
      tx.insert(schema.feeds).values({ name: "F", aggregator: "full_website", identifier: "https://x.example", userId }).returning({ id: schema.feeds.id }).get(),
    );
    feedId = feed.id;
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  it("returns everything as `new` on the zero cursor", () => {
    client.writeTransaction((tx) =>
      tx.insert(schema.articles).values({ name: "A1", identifier: "a1", date: new Date(), feedId }).run(),
    );

    const page = sync.syncArticles(userId, sync.ZERO_CURSOR, 100);
    expect("resyncRequired" in page).toBe(false);
    if ("resyncRequired" in page) throw new Error("unreachable");
    expect(page.new).toHaveLength(1);
    expect(page.updated).toHaveLength(0);
    expect(page.removed).toHaveLength(0);
  });

  it("a second call with the returned cursor sees nothing new", () => {
    client.writeTransaction((tx) =>
      tx.insert(schema.articles).values({ name: "A1", identifier: "a1", date: new Date(), feedId }).run(),
    );
    const first = sync.syncArticles(userId, sync.ZERO_CURSOR, 100);
    if ("resyncRequired" in first) throw new Error("unreachable");

    const second = sync.syncArticles(userId, sync.decodeCursor(first.nextCursor), 100);
    if ("resyncRequired" in second) throw new Error("unreachable");
    expect(second.new).toHaveLength(0);
    expect(second.updated).toHaveLength(0);
  });

  it("surfaces a starred toggle as an update, not a duplicate new", () => {
    const inserted = client.writeTransaction((tx) =>
      tx.insert(schema.articles).values({ name: "A1", identifier: "a1", date: new Date(), feedId }).returning({ id: schema.articles.id }).get(),
    );
    const first = sync.syncArticles(userId, sync.ZERO_CURSOR, 100);
    if ("resyncRequired" in first) throw new Error("unreachable");

    client.writeTransaction((tx) =>
      tx.update(schema.articles).set({ starred: true }).where(eq(schema.articles.id, inserted.id)).run(),
    );

    const second = sync.syncArticles(userId, sync.decodeCursor(first.nextCursor), 100);
    if ("resyncRequired" in second) throw new Error("unreachable");
    expect(second.new).toHaveLength(0);
    expect(second.updated).toHaveLength(1);
    expect(second.updated[0].starred).toBe(true);
  });

  it("surfaces a hard delete as a removed id", () => {
    const inserted = client.writeTransaction((tx) =>
      tx.insert(schema.articles).values({ name: "A1", identifier: "a1", date: new Date(), feedId }).returning({ id: schema.articles.id }).get(),
    );
    const first = sync.syncArticles(userId, sync.ZERO_CURSOR, 100);
    if ("resyncRequired" in first) throw new Error("unreachable");

    client.writeTransaction((tx) => {
      tx.insert(schema.articleTombstones).values({ articleId: inserted.id, userId }).run();
      tx.delete(schema.articles).where(eq(schema.articles.id, inserted.id)).run();
    });

    const second = sync.syncArticles(userId, sync.decodeCursor(first.nextCursor), 100);
    if ("resyncRequired" in second) throw new Error("unreachable");
    expect(second.removed).toEqual([inserted.id]);
  });

  it("requires a resync when the cursor predates a pruned tombstone", () => {
    client.writeTransaction((tx) =>
      tx.insert(schema.articleTombstones).values({
        articleId: 999,
        userId,
        deletedAt: new Date(),
      }).run(),
    );

    // A cursor claiming to have already seen everything up to the epoch,
    // while a tombstone newer than that already exists and nothing older
    // does -- meaning anything between "the epoch" and this tombstone that
    // might have been pruned is now unaccounted for.
    const page = sync.syncArticles(userId, sync.ZERO_CURSOR, 100);
    // The zero cursor is always younger than any real tombstone's deletedAt,
    // so this should NOT trigger resync -- it's a fresh client with nothing
    // to miss. Verify instead with a cursor whose removedPos already claims
    // to be past this tombstone, then insert an OLDER tombstone afterward to
    // simulate a gap:
    if ("resyncRequired" in page) throw new Error("unreachable");
    const laterCursor = sync.decodeCursor(page.nextCursor);

    client.writeTransaction((tx) =>
      tx.delete(schema.articleTombstones).where(eq(schema.articleTombstones.articleId, 999)).run(),
    );
    client.writeTransaction((tx) =>
      tx.insert(schema.articleTombstones).values({
        articleId: 998,
        userId,
        deletedAt: new Date(Date.now() - 999 * 24 * 60 * 60_000), // older than laterCursor's removedPos
      }).run(),
    );

    const result = sync.syncArticles(userId, laterCursor, 100);
    expect("resyncRequired" in result).toBe(true);
  });
});
```

This last test is intentionally awkward to construct (simulating "a tombstone the client can no longer see the full history behind" requires manufacturing a gap by hand) — if it proves too fragile once written, simplify to: seed a tombstone with `deletedAt` far in the past, call `syncArticles` with a cursor whose `removedPos[0]` is a timestamp *after* that tombstone's `deletedAt` (constructed directly via `encodeCursor`, not derived from a real prior call), and assert `resyncRequired`. That more directly tests `cursorExpired()`'s actual condition without narrative scaffolding.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/lib/api/sync.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// src/lib/api/sync.ts
import { and, asc, eq, gt, inArray, notInArray, or } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { articleTombstones, articles, feeds } from "@/lib/db/schema";
import { serializeArticleSummary, type ArticleSummaryWire } from "./serializers";

export interface SyncCursor {
  newPos: [number, number];
  updatedPos: [number, number];
  removedPos: [number, number];
}

export const ZERO_CURSOR: SyncCursor = { newPos: [0, 0], updatedPos: [0, 0], removedPos: [0, 0] };

function isPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number";
}

function isSyncCursor(value: unknown): value is SyncCursor {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isPair(v.newPos) && isPair(v.updatedPos) && isPair(v.removedPos);
}

export function encodeCursor(cursor: SyncCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** Never throws -- an unparseable or malformed cursor is treated as "start over," not a client error. */
export function decodeCursor(raw: string | null | undefined): SyncCursor {
  if (!raw) return ZERO_CURSOR;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return isSyncCursor(parsed) ? parsed : ZERO_CURSOR;
  } catch {
    return ZERO_CURSOR;
  }
}

export interface SyncPage {
  new: ArticleSummaryWire[];
  updated: ArticleSummaryWire[];
  removed: number[];
  nextCursor: string;
}

export type SyncResult = SyncPage | { resyncRequired: true };

function secondsOf(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function fromSeconds(seconds: number): Date {
  return new Date(seconds * 1000);
}

/**
 * True when some deletion between the client's cursor and now has already
 * been pruned by the retention job's tombstone cleanup -- i.e. a delta from
 * here could omit a `removed` id the client never learned about. See the
 * design doc §3, "Cursor expiry."
 */
function cursorExpired(userId: string, cursor: SyncCursor): boolean {
  const oldest = getDb()
    .select({ deletedAt: articleTombstones.deletedAt })
    .from(articleTombstones)
    .where(eq(articleTombstones.userId, userId))
    .orderBy(asc(articleTombstones.deletedAt), asc(articleTombstones.id))
    .limit(1)
    .get();

  if (!oldest) return false;
  return secondsOf(oldest.deletedAt) > cursor.removedPos[0];
}

export function syncArticles(userId: string, cursor: SyncCursor, limit: number): SyncResult {
  if (cursorExpired(userId, cursor)) return { resyncRequired: true };

  const db = getDb();
  const userFeedIds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, userId));

  const newRows = db
    .select()
    .from(articles)
    .where(
      and(
        inArray(articles.feedId, userFeedIds),
        or(
          gt(articles.createdAt, fromSeconds(cursor.newPos[0])),
          and(eq(articles.createdAt, fromSeconds(cursor.newPos[0])), gt(articles.id, cursor.newPos[1])),
        ),
      ),
    )
    .orderBy(asc(articles.createdAt), asc(articles.id))
    .limit(limit)
    .all();

  const newIds = newRows.map((row) => row.id);

  const updatedRows = db
    .select()
    .from(articles)
    .where(
      and(
        inArray(articles.feedId, userFeedIds),
        newIds.length > 0 ? notInArray(articles.id, newIds) : undefined,
        or(
          gt(articles.updatedAt, fromSeconds(cursor.updatedPos[0])),
          and(eq(articles.updatedAt, fromSeconds(cursor.updatedPos[0])), gt(articles.id, cursor.updatedPos[1])),
        ),
      ),
    )
    .orderBy(asc(articles.updatedAt), asc(articles.id))
    .limit(limit)
    .all();

  const removedRows = db
    .select()
    .from(articleTombstones)
    .where(
      and(
        eq(articleTombstones.userId, userId),
        or(
          gt(articleTombstones.deletedAt, fromSeconds(cursor.removedPos[0])),
          and(eq(articleTombstones.deletedAt, fromSeconds(cursor.removedPos[0])), gt(articleTombstones.id, cursor.removedPos[1])),
        ),
      ),
    )
    .orderBy(asc(articleTombstones.deletedAt), asc(articleTombstones.id))
    .limit(limit)
    .all();

  const nextNewPos: [number, number] =
    newRows.length > 0 ? [secondsOf(newRows.at(-1)!.createdAt), newRows.at(-1)!.id] : cursor.newPos;
  const nextUpdatedPos: [number, number] =
    updatedRows.length > 0 ? [secondsOf(updatedRows.at(-1)!.updatedAt), updatedRows.at(-1)!.id] : cursor.updatedPos;
  const nextRemovedPos: [number, number] =
    removedRows.length > 0 ? [secondsOf(removedRows.at(-1)!.deletedAt), removedRows.at(-1)!.id] : cursor.removedPos;

  return {
    new: newRows.map(serializeArticleSummary),
    updated: updatedRows.map(serializeArticleSummary),
    removed: removedRows.map((row) => row.articleId),
    nextCursor: encodeCursor({ newPos: nextNewPos, updatedPos: nextUpdatedPos, removedPos: nextRemovedPos }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/api/sync.test.ts
```

Expected: PASS. If `notInArray(articles.id, [])`/an empty `inArray` on `userFeedIds` (a user with zero feeds) produces invalid SQL rather than an empty result, fix by short-circuiting: if `userFeedIds` resolves to zero rows, return an all-empty `SyncPage` before building the queries. Confirm by running the test with a user that has no feed — add one if the current suite doesn't already cover it.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/sync.ts src/lib/api/sync.test.ts
git commit -m "feat(api): add the sync cursor and delta query"
```

---

### Task 14: `GET /api/v1/articles/sync`

**Files:**
- Create: `src/app/api/v1/articles/sync/route.ts`
- Test: `src/app/api/v1/articles/sync/route.test.ts`

**Interfaces:**
- Consumes: `requireApiUser`, `ApiError`, `apiErrorResponse` (Task 8); `decodeCursor`, `syncArticles` (Task 13)
- Produces: the route itself; no exports consumed elsewhere

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/v1/articles/sync/route.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

describe("GET /api/v1/articles/sync", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  beforeEach(async () => {
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-sync-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    ({ GET } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  it("401s with no Authorization header", async () => {
    const response = await GET(new Request("https://example.com/api/v1/articles/sync"));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns this user's articles only", async () => {
    const user = await createUserWithPassword({ email: "a@example.com", password: "correct horse battery staple" });
    const other = await createUserWithPassword({ email: "b@example.com", password: "correct horse battery staple" });
    const { token } = await createDeviceSession(user.id, "Test");

    const feedA = client.writeTransaction((tx) =>
      tx.insert(schema.feeds).values({ name: "A", aggregator: "full_website", identifier: "https://a", userId: user.id }).returning({ id: schema.feeds.id }).get(),
    );
    const feedB = client.writeTransaction((tx) =>
      tx.insert(schema.feeds).values({ name: "B", aggregator: "full_website", identifier: "https://b", userId: other.id }).returning({ id: schema.feeds.id }).get(),
    );
    client.writeTransaction((tx) => {
      tx.insert(schema.articles).values({ name: "Mine", identifier: "m1", date: new Date(), feedId: feedA.id }).run();
      tx.insert(schema.articles).values({ name: "Theirs", identifier: "t1", date: new Date(), feedId: feedB.id }).run();
    });

    const response = await GET(new Request("https://example.com/api/v1/articles/sync", { headers: { authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.new).toHaveLength(1);
    expect(body.new[0].name).toBe("Mine");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/app/api/v1/articles/sync/route.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// src/app/api/v1/articles/sync/route.ts
import { connection } from "next/server";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { decodeCursor, syncArticles } from "@/lib/api/sync";

export async function GET(request: Request): Promise<Response> {
  await connection();
  try {
    const user = await requireApiUser(request);
    const url = new URL(request.url);
    const cursor = decodeCursor(url.searchParams.get("cursor"));
    const requestedLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 200;

    return Response.json(syncArticles(user.id, cursor, limit));
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/app/api/v1/articles/sync/route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/v1/articles/sync/route.ts src/app/api/v1/articles/sync/route.test.ts
git commit -m "feat(api): add GET /api/v1/articles/sync"
```

---

### Task 15: `GET /api/v1/articles/[id]/content`

**Files:**
- Create: `src/app/api/v1/articles/[id]/content/route.ts`
- Test: `src/app/api/v1/articles/[id]/content/route.test.ts`

**Interfaces:**
- Consumes: `requireApiUser`/`ApiError`/`apiErrorResponse` (Task 8); `readBlocks` from `@/lib/aggregators/blocks/storage` (existing); `encodeDocument` from `@/lib/aggregators/blocks/schema` (existing)

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/v1/articles/[id]/content/route.test.ts
// Same beforeEach/afterEach boilerplate as Task 14's test file.
it("404s for another user's article", async () => {
  const owner = await createUserWithPassword({ email: "owner@example.com", password: "correct horse battery staple" });
  const other = await createUserWithPassword({ email: "other@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(other.id, "Test");

  const feed = client.writeTransaction((tx) =>
    tx.insert(schema.feeds).values({ name: "F", aggregator: "full_website", identifier: "https://x", userId: owner.id }).returning({ id: schema.feeds.id }).get(),
  );
  const article = client.writeTransaction((tx) =>
    tx.insert(schema.articles).values({ name: "A", identifier: "a1", date: new Date(), feedId: feed.id }).returning({ id: schema.articles.id }).get(),
  );

  const response = await GET(
    new Request(`https://example.com/api/v1/articles/${article.id}/content`, { headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ id: String(article.id) }) },
  );
  expect(response.status).toBe(404);
});

it("returns the encoded block document for the owner", async () => {
  const owner = await createUserWithPassword({ email: "owner2@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(owner.id, "Test");

  const feed = client.writeTransaction((tx) =>
    tx.insert(schema.feeds).values({ name: "F", aggregator: "full_website", identifier: "https://x", userId: owner.id }).returning({ id: schema.feeds.id }).get(),
  );
  const article = client.writeTransaction((tx) =>
    tx.insert(schema.articles).values({ name: "A", identifier: "a1", date: new Date(), feedId: feed.id }).returning({ id: schema.articles.id }).get(),
  );

  const response = await GET(
    new Request(`https://example.com/api/v1/articles/${article.id}/content`, { headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ id: String(article.id) }) },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ version: 1, blocks: [] }); // no blocks written for this article; adjust `version` to match FORMAT_VERSION's real value
});
```

Check `FORMAT_VERSION`'s actual value in `src/lib/aggregators/blocks/types.ts` before asserting `version: 1` literally.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run "src/app/api/v1/articles/[id]/content/route.test.ts"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/app/api/v1/articles/[id]/content/route.ts
import { and, eq, inArray } from "drizzle-orm";
import { connection } from "next/server";

import { encodeDocument } from "@/lib/aggregators/blocks/schema";
import { readBlocks } from "@/lib/aggregators/blocks/storage";
import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { getDb } from "@/lib/db/client";
import { articles, feeds } from "@/lib/db/schema";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  await connection();
  try {
    const user = await requireApiUser(request);
    const { id } = await ctx.params;
    const articleId = Number(id);
    if (!Number.isInteger(articleId)) throw new ApiError(404, "not_found");

    const db = getDb();
    const userFeedIds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, user.id));
    const article = db
      .select({ id: articles.id })
      .from(articles)
      .where(and(eq(articles.id, articleId), inArray(articles.feedId, userFeedIds)))
      .get();
    if (!article) throw new ApiError(404, "not_found");

    const blocks = await readBlocks(articleId);
    return Response.json(encodeDocument(blocks));
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run "src/app/api/v1/articles/[id]/content/route.test.ts"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/v1/articles/[id]/content/route.ts" "src/app/api/v1/articles/[id]/content/route.test.ts"
git commit -m "feat(api): add GET /api/v1/articles/:id/content"
```

---

### Task 16: `PATCH /api/v1/articles/[id]`

**Files:**
- Create: `src/app/api/v1/articles/[id]/route.ts`
- Test: `src/app/api/v1/articles/[id]/route.test.ts`

**Interfaces:**
- Consumes: Task 8, Task 12 (`serializeArticleSummary`)

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/v1/articles/[id]/route.test.ts
// Same boilerplate as Task 14/15.
it("toggles starred and returns the updated summary", async () => {
  const owner = await createUserWithPassword({ email: "o@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(owner.id, "Test");
  const feed = client.writeTransaction((tx) =>
    tx.insert(schema.feeds).values({ name: "F", aggregator: "full_website", identifier: "https://x", userId: owner.id }).returning({ id: schema.feeds.id }).get(),
  );
  const article = client.writeTransaction((tx) =>
    tx.insert(schema.articles).values({ name: "A", identifier: "a1", date: new Date(), feedId: feed.id }).returning({ id: schema.articles.id }).get(),
  );

  const response = await PATCH(
    new Request(`https://example.com/api/v1/articles/${article.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ starred: true }),
    }),
    { params: Promise.resolve({ id: String(article.id) }) },
  );

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.starred).toBe(true);
});

it("404s for another user's article and leaves it unchanged", async () => {
  const owner = await createUserWithPassword({ email: "o2@example.com", password: "correct horse battery staple" });
  const other = await createUserWithPassword({ email: "o3@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(other.id, "Test");
  const feed = client.writeTransaction((tx) =>
    tx.insert(schema.feeds).values({ name: "F", aggregator: "full_website", identifier: "https://x", userId: owner.id }).returning({ id: schema.feeds.id }).get(),
  );
  const article = client.writeTransaction((tx) =>
    tx.insert(schema.articles).values({ name: "A", identifier: "a1", date: new Date(), feedId: feed.id }).returning({ id: schema.articles.id }).get(),
  );

  const response = await PATCH(
    new Request(`https://example.com/api/v1/articles/${article.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ starred: true }),
    }),
    { params: Promise.resolve({ id: String(article.id) }) },
  );
  expect(response.status).toBe(404);

  const row = client.getDb().select().from(schema.articles).where(eq(schema.articles.id, article.id)).get();
  expect(row?.starred).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run "src/app/api/v1/articles/[id]/route.test.ts"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/app/api/v1/articles/[id]/route.ts
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { serializeArticleSummary } from "@/lib/api/serializers";
import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, feeds } from "@/lib/db/schema";

const patchBody = z.object({ starred: z.boolean().optional(), read: z.boolean().optional() });

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await requireApiUser(request);
    const { id } = await ctx.params;
    const articleId = Number(id);
    if (!Number.isInteger(articleId)) throw new ApiError(404, "not_found");

    const json = await request.json().catch(() => ({}));
    const parsed = patchBody.safeParse(json);
    if (!parsed.success || (parsed.data.starred === undefined && parsed.data.read === undefined)) {
      throw new ApiError(400, "invalid_body", "Provide starred and/or read.");
    }

    const userFeedIds = getDb().select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, user.id));

    const updated = writeTransaction((tx) => {
      const result = tx
        .update(articles)
        .set(parsed.data)
        .where(and(eq(articles.id, articleId), inArray(articles.feedId, userFeedIds)))
        .run();
      if (result.changes === 0) return null;
      return tx.select().from(articles).where(eq(articles.id, articleId)).get() ?? null;
    });

    if (!updated) throw new ApiError(404, "not_found");
    return Response.json(serializeArticleSummary(updated));
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
```

Note the ownership check happens in the `UPDATE ... WHERE` clause, and the re-`SELECT` after only runs when `result.changes > 0` — re-selecting unconditionally (with no ownership clause) would leak another user's article data on a 0-row update, which is exactly the enumeration bug the 404-not-403 convention exists to prevent.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run "src/app/api/v1/articles/[id]/route.test.ts"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/v1/articles/[id]/route.ts" "src/app/api/v1/articles/[id]/route.test.ts"
git commit -m "feat(api): add PATCH /api/v1/articles/:id for star/read"
```

---

### Task 17: `POST /api/v1/articles/[id]/reload`

**Files:**
- Create: `src/app/api/v1/articles/[id]/reload/route.ts`
- Test: `src/app/api/v1/articles/[id]/reload/route.test.ts`

**Interfaces:**
- Consumes: Task 8

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/v1/articles/[id]/reload/route.test.ts
// Same boilerplate.
it("enqueues an article.reload job scoped to the owner", async () => {
  const owner = await createUserWithPassword({ email: "o@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(owner.id, "Test");
  const feed = client.writeTransaction((tx) =>
    tx.insert(schema.feeds).values({ name: "F", aggregator: "full_website", identifier: "https://x", userId: owner.id }).returning({ id: schema.feeds.id }).get(),
  );
  const article = client.writeTransaction((tx) =>
    tx.insert(schema.articles).values({ name: "A", identifier: "a1", date: new Date(), feedId: feed.id }).returning({ id: schema.articles.id }).get(),
  );

  const response = await POST(
    new Request(`https://example.com/api/v1/articles/${article.id}/reload`, { method: "POST", headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ id: String(article.id) }) },
  );

  expect(response.status).toBe(202);
  const body = await response.json();
  expect(typeof body.jobId).toBe("number");

  const job = client.getDb().select().from(schema.jobs).where(eq(schema.jobs.id, body.jobId)).get();
  expect(job?.kind).toBe("article.reload");
  expect(job?.payload).toMatchObject({ articleId: article.id });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run "src/app/api/v1/articles/[id]/reload/route.test.ts"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/app/api/v1/articles/[id]/reload/route.ts
import { and, eq, inArray } from "drizzle-orm";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, feeds, jobs } from "@/lib/db/schema";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await requireApiUser(request);
    const { id } = await ctx.params;
    const articleId = Number(id);
    if (!Number.isInteger(articleId)) throw new ApiError(404, "not_found");

    const userFeedIds = getDb().select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, user.id));

    const jobId = writeTransaction((tx) => {
      const article = tx
        .select({ id: articles.id })
        .from(articles)
        .where(and(eq(articles.id, articleId), inArray(articles.feedId, userFeedIds)))
        .get();
      if (!article) return null;

      const inserted = tx
        .insert(jobs)
        .values({ kind: "article.reload", payload: { articleId } })
        .returning({ id: jobs.id })
        .get();
      return inserted.id;
    });

    if (jobId === null) throw new ApiError(404, "not_found");
    return Response.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run "src/app/api/v1/articles/[id]/reload/route.test.ts"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/v1/articles/[id]/reload/route.ts" "src/app/api/v1/articles/[id]/reload/route.test.ts"
git commit -m "feat(api): add POST /api/v1/articles/:id/reload"
```

---

### Task 18: `POST /api/v1/aggregate`

**Files:**
- Create: `src/app/api/v1/aggregate/route.ts`
- Test: `src/app/api/v1/aggregate/route.test.ts`

**Interfaces:**
- Consumes: Task 8; `enqueueRun` (Task 3)

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/v1/aggregate/route.test.ts
// Same boilerplate.
it("creates a run with one job per enabled feed", async () => {
  const owner = await createUserWithPassword({ email: "o@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(owner.id, "Test");
  client.writeTransaction((tx) => {
    tx.insert(schema.feeds).values({ name: "A", aggregator: "full_website", identifier: "https://a", userId: owner.id, enabled: true }).run();
    tx.insert(schema.feeds).values({ name: "B", aggregator: "full_website", identifier: "https://b", userId: owner.id, enabled: true }).run();
    tx.insert(schema.feeds).values({ name: "C", aggregator: "full_website", identifier: "https://c", userId: owner.id, enabled: false }).run();
  });

  const response = await POST(new Request("https://example.com/api/v1/aggregate", { method: "POST", headers: { authorization: `Bearer ${token}` } }));
  expect(response.status).toBe(202);
  const body = await response.json();
  expect(typeof body.runId).toBe("number");

  const run = client.getDb().select().from(schema.runs).where(eq(schema.runs.id, body.runId)).get();
  expect(run?.totalJobs).toBe(2); // the disabled feed is excluded

  const childJobs = client.getDb().select().from(schema.jobs).where(eq(schema.jobs.runId, body.runId)).all();
  expect(childJobs).toHaveLength(2);
  expect(childJobs.every((j) => j.kind === "aggregate")).toBe(true);
});

it("returns a null runId with no enabled feeds", async () => {
  const owner = await createUserWithPassword({ email: "o2@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(owner.id, "Test");

  const response = await POST(new Request("https://example.com/api/v1/aggregate", { method: "POST", headers: { authorization: `Bearer ${token}` } }));
  expect(response.status).toBe(202);
  expect((await response.json()).runId).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/app/api/v1/aggregate/route.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/app/api/v1/aggregate/route.ts
import { and, eq } from "drizzle-orm";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { getDb } from "@/lib/db/client";
import { feeds } from "@/lib/db/schema";
import { enqueueRun } from "@/lib/jobs/queue";

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser(request);
    const enabledFeeds = getDb()
      .select({ id: feeds.id })
      .from(feeds)
      .where(and(eq(feeds.userId, user.id), eq(feeds.enabled, true)))
      .all();

    if (enabledFeeds.length === 0) return Response.json({ runId: null }, { status: 202 });

    const runId = enqueueRun(user.id, "aggregate", enabledFeeds.map((feed) => ({ feedId: feed.id })));
    return Response.json({ runId }, { status: 202 });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/app/api/v1/aggregate/route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/v1/aggregate/route.ts src/app/api/v1/aggregate/route.test.ts
git commit -m "feat(api): add POST /api/v1/aggregate"
```

---

### Task 19: `GET /api/v1/runs/[id]`

**Files:**
- Create: `src/app/api/v1/runs/[id]/route.ts`
- Test: `src/app/api/v1/runs/[id]/route.test.ts`

**Interfaces:**
- Consumes: Task 8

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/v1/runs/[id]/route.test.ts
it("404s for a run belonging to another user", async () => {
  const owner = await createUserWithPassword({ email: "o@example.com", password: "correct horse battery staple" });
  const other = await createUserWithPassword({ email: "o2@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(other.id, "Test");
  const { enqueueRun } = await import("@/lib/jobs/queue");
  const runId = enqueueRun(owner.id, "aggregate", [{ feedId: 1 }]);

  const response = await GET(
    new Request(`https://example.com/api/v1/runs/${runId}`, { headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ id: String(runId) }) },
  );
  expect(response.status).toBe(404);
});

it("returns run counters for the owner", async () => {
  const owner = await createUserWithPassword({ email: "o3@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(owner.id, "Test");
  const { enqueueRun } = await import("@/lib/jobs/queue");
  const runId = enqueueRun(owner.id, "aggregate", [{ feedId: 1 }, { feedId: 2 }]);

  const response = await GET(
    new Request(`https://example.com/api/v1/runs/${runId}`, { headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ id: String(runId) }) },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ runId, status: "running", totalJobs: 2, completedJobs: 0, failedJobs: 0 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run "src/app/api/v1/runs/[id]/route.test.ts"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/app/api/v1/runs/[id]/route.ts
import { and, eq } from "drizzle-orm";
import { connection } from "next/server";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  await connection();
  try {
    const user = await requireApiUser(request);
    const { id } = await ctx.params;
    const runId = Number(id);
    if (!Number.isInteger(runId)) throw new ApiError(404, "not_found");

    const run = getDb().select().from(runs).where(and(eq(runs.id, runId), eq(runs.userId, user.id))).get();
    if (!run) throw new ApiError(404, "not_found");

    return Response.json({
      runId: run.id,
      status: run.status,
      totalJobs: run.totalJobs,
      completedJobs: run.completedJobs,
      failedJobs: run.failedJobs,
    });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run "src/app/api/v1/runs/[id]/route.test.ts"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/v1/runs/[id]/route.ts" "src/app/api/v1/runs/[id]/route.test.ts"
git commit -m "feat(api): add GET /api/v1/runs/:id"
```

---

### Task 20: `GET /api/v1/jobs/events` (SSE)

**Files:**
- Create: `src/app/api/v1/jobs/events/route.ts`
- Test: `src/app/api/v1/jobs/events/route.test.ts`

**Interfaces:**
- Consumes: Task 8; `subscribeUserEvents` (Task 2)

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/v1/jobs/events/route.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyMigrationsAt } from "@/lib/db/test-support";

describe("GET /api/v1/jobs/events", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;
  let publishUserEvent: typeof import("@/lib/api/events").publishUserEvent;

  beforeEach(async () => {
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-sse-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    ({ publishUserEvent } = await import("@/lib/api/events"));
    ({ GET } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  it("streams a published event as an SSE frame", async () => {
    const user = await createUserWithPassword({ email: "a@example.com", password: "correct horse battery staple" });
    const { token } = await createDeviceSession(user.id, "Test");

    const controller = new AbortController();
    const request = new Request("https://example.com/api/v1/jobs/events", {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });

    const response = await GET(request);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const readNext = reader.read();

    publishUserEvent(user.id, { type: "job", payload: { jobId: 1, runId: null, kind: "article.reload", status: "completed", progress: 100 } });

    const { value } = await readNext;
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: job");
    expect(text).toContain('"jobId":1');

    controller.abort();
    reader.cancel();
  });
});
```

This test's exact timing (does `reader.read()` resolve promptly once `publishUserEvent` fires synchronously inside the same tick?) depends on the `ReadableStream` implementation's microtask scheduling — run it and adjust with an `await Promise.resolve()` or a short `setTimeout`-based wait before asserting if it's flaky, rather than assuming it resolves instantly.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/app/api/v1/jobs/events/route.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// src/app/api/v1/jobs/events/route.ts
import { connection } from "next/server";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { subscribeUserEvents } from "@/lib/api/events";

const PING_INTERVAL_MS = 15_000;

export async function GET(request: Request): Promise<Response> {
  await connection();

  let user;
  try {
    user = await requireApiUser(request);
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const unsubscribe = subscribeUserEvents(user.id, (event) => send(event.type, event.payload));

      const keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, PING_INTERVAL_MS);

      const cleanup = () => {
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting.
        }
      };

      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/app/api/v1/jobs/events/route.test.ts
```

Expected: PASS (adjusting for stream timing per Step 1's note if needed).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/v1/jobs/events/route.ts src/app/api/v1/jobs/events/route.test.ts
git commit -m "feat(api): add SSE job/run notification stream"
```

---

### Task 21: `GET /api/v1/feeds`

**Files:**
- Create: `src/app/api/v1/feeds/route.ts`
- Test: `src/app/api/v1/feeds/route.test.ts`

**Interfaces:**
- Consumes: Task 8, Task 12 (`serializeFeed`)

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/v1/feeds/route.test.ts
it("returns this user's feeds with their tagIds", async () => {
  const owner = await createUserWithPassword({ email: "o@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(owner.id, "Test");
  const feed = client.writeTransaction((tx) =>
    tx.insert(schema.feeds).values({ name: "F", aggregator: "full_website", identifier: "https://x", userId: owner.id }).returning({ id: schema.feeds.id }).get(),
  );
  const tag = client.writeTransaction((tx) =>
    tx.insert(schema.tags).values({ name: "News", userId: owner.id }).returning({ id: schema.tags.id }).get(),
  );
  client.writeTransaction((tx) => tx.insert(schema.feedTags).values({ feedId: feed.id, tagId: tag.id }).run());

  const response = await GET(new Request("https://example.com/api/v1/feeds", { headers: { authorization: `Bearer ${token}` } }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.feeds).toHaveLength(1);
  expect(body.feeds[0].tagIds).toEqual([tag.id]);
});

it("returns an empty list with no feeds", async () => {
  const owner = await createUserWithPassword({ email: "o2@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(owner.id, "Test");

  const response = await GET(new Request("https://example.com/api/v1/feeds", { headers: { authorization: `Bearer ${token}` } }));
  expect((await response.json()).feeds).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/app/api/v1/feeds/route.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/app/api/v1/feeds/route.ts
import { eq, inArray } from "drizzle-orm";
import { connection } from "next/server";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { serializeFeed } from "@/lib/api/serializers";
import { getDb } from "@/lib/db/client";
import { feedTags, feeds } from "@/lib/db/schema";

export async function GET(request: Request): Promise<Response> {
  await connection();
  try {
    const user = await requireApiUser(request);
    const db = getDb();
    const feedRows = db.select().from(feeds).where(eq(feeds.userId, user.id)).all();

    if (feedRows.length === 0) return Response.json({ feeds: [] });

    const feedIds = feedRows.map((feed) => feed.id);
    const tagRows = db
      .select({ feedId: feedTags.feedId, tagId: feedTags.tagId })
      .from(feedTags)
      .where(inArray(feedTags.feedId, feedIds))
      .all();

    const tagIdsByFeed = new Map<number, number[]>();
    for (const row of tagRows) {
      const list = tagIdsByFeed.get(row.feedId) ?? [];
      list.push(row.tagId);
      tagIdsByFeed.set(row.feedId, list);
    }

    return Response.json({
      feeds: feedRows.map((feed) => serializeFeed(feed, tagIdsByFeed.get(feed.id) ?? [])),
    });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/app/api/v1/feeds/route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/v1/feeds/route.ts src/app/api/v1/feeds/route.test.ts
git commit -m "feat(api): add GET /api/v1/feeds"
```

---

### Task 22: `GET /api/v1/tags`

**Files:**
- Create: `src/app/api/v1/tags/route.ts`
- Test: `src/app/api/v1/tags/route.test.ts`

**Interfaces:**
- Consumes: Task 8, Task 12 (`serializeTag`)

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/v1/tags/route.test.ts
it("returns only this user's tags", async () => {
  const owner = await createUserWithPassword({ email: "o@example.com", password: "correct horse battery staple" });
  const other = await createUserWithPassword({ email: "o2@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(owner.id, "Test");
  client.writeTransaction((tx) => {
    tx.insert(schema.tags).values({ name: "Mine", userId: owner.id }).run();
    tx.insert(schema.tags).values({ name: "Theirs", userId: other.id }).run();
  });

  const response = await GET(new Request("https://example.com/api/v1/tags", { headers: { authorization: `Bearer ${token}` } }));
  const body = await response.json();
  expect(body.tags).toHaveLength(1);
  expect(body.tags[0].name).toBe("Mine");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/app/api/v1/tags/route.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/app/api/v1/tags/route.ts
import { eq } from "drizzle-orm";
import { connection } from "next/server";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { serializeTag } from "@/lib/api/serializers";
import { getDb } from "@/lib/db/client";
import { tags } from "@/lib/db/schema";

export async function GET(request: Request): Promise<Response> {
  await connection();
  try {
    const user = await requireApiUser(request);
    const tagRows = getDb().select().from(tags).where(eq(tags.userId, user.id)).all();
    return Response.json({ tags: tagRows.map(serializeTag) });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/app/api/v1/tags/route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/v1/tags/route.ts src/app/api/v1/tags/route.test.ts
git commit -m "feat(api): add GET /api/v1/tags"
```

---

### Task 23: `GET /api/v1/images/[hash]`

**Files:**
- Create: `src/app/api/v1/images/[hash]/route.ts`
- Test: `src/app/api/v1/images/[hash]/route.test.ts`

**Interfaces:**
- Consumes: Task 8; `mediaRoot` from `@/lib/avatar-storage`; `buildImageRef` from `@/lib/aggregators/images/store` (existing)

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/v1/images/[hash]/route.test.ts
import fs from "node:fs/promises";
import path from "node:path";
// ... plus the usual boilerplate

it("serves bytes for a feed's own logo hash", async () => {
  const owner = await createUserWithPassword({ email: "o@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(owner.id, "Test");

  const mediaDir = path.join(dbPath + "-media");
  process.env.MEDIA_PATH = mediaDir;
  const relativeFile = "article_images/deadbeef.webp";
  await fs.mkdir(path.dirname(path.join(mediaDir, relativeFile)), { recursive: true });
  await fs.writeFile(path.join(mediaDir, relativeFile), Buffer.from([1, 2, 3]));

  const hash = "d".repeat(64);
  client.writeTransaction((tx) => {
    tx.insert(schema.articleImages).values({ contentHash: hash, file: relativeFile, contentType: "image/webp", byteSize: 3 }).run();
    tx.insert(schema.feeds).values({ name: "F", aggregator: "full_website", identifier: "https://x", userId: owner.id, logoImageHash: hash }).run();
  });

  const response = await GET(
    new Request(`https://example.com/api/v1/images/${hash}`, { headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ hash }) },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/webp");
});

it("404s for a hash the caller doesn't own", async () => {
  const owner = await createUserWithPassword({ email: "o2@example.com", password: "correct horse battery staple" });
  const other = await createUserWithPassword({ email: "o3@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(other.id, "Test");

  const hash = "e".repeat(64);
  client.writeTransaction((tx) => {
    tx.insert(schema.articleImages).values({ contentHash: hash, file: "article_images/e.webp", contentType: "image/webp", byteSize: 3 }).run();
    tx.insert(schema.feeds).values({ name: "F", aggregator: "full_website", identifier: "https://x", userId: owner.id, logoImageHash: hash }).run();
  });

  const response = await GET(
    new Request(`https://example.com/api/v1/images/${hash}`, { headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ hash }) },
  );
  expect(response.status).toBe(404);
});

it("404s for a malformed hash without querying the database", async () => {
  const owner = await createUserWithPassword({ email: "o4@example.com", password: "correct horse battery staple" });
  const { token } = await createDeviceSession(owner.id, "Test");

  const response = await GET(
    new Request("https://example.com/api/v1/images/not-a-hash", { headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ hash: "not-a-hash" }) },
  );
  expect(response.status).toBe(404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run "src/app/api/v1/images/[hash]/route.test.ts"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/app/api/v1/images/[hash]/route.ts
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { connection } from "next/server";

import { buildImageRef } from "@/lib/aggregators/images/store";
import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { mediaRoot } from "@/lib/avatar-storage";
import { getDb } from "@/lib/db/client";
import { articleBlocks, articleImages, articles, feeds } from "@/lib/db/schema";

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function ownsHash(userId: string, hash: string): boolean {
  const db = getDb();

  const viaLogo = db
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(eq(feeds.userId, userId), eq(feeds.logoImageHash, hash)))
    .get();
  if (viaLogo) return true;

  const viaArticle = db
    .select({ id: articleBlocks.id })
    .from(articleBlocks)
    .innerJoin(articles, eq(articleBlocks.articleId, articles.id))
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(and(eq(feeds.userId, userId), eq(articleBlocks.imageRef, buildImageRef(hash))))
    .get();
  return Boolean(viaArticle);
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ hash: string }> },
): Promise<Response> {
  await connection();
  try {
    const user = await requireApiUser(request);
    const { hash } = await ctx.params;
    if (!HASH_PATTERN.test(hash)) throw new ApiError(404, "not_found");
    if (!ownsHash(user.id, hash)) throw new ApiError(404, "not_found");

    const image = getDb().select().from(articleImages).where(eq(articleImages.contentHash, hash)).get();
    if (!image) throw new ApiError(404, "not_found");

    const bytes = await fs.readFile(path.join(mediaRoot(), image.file));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": image.contentType,
        "Content-Length": String(bytes.byteLength),
        "X-Content-Type-Options": "nosniff",
        // Immutable: the URL *is* the content hash, so nothing can go stale
        // under it -- unlike the avatar route, which explicitly declines this
        // until it has a version token of its own.
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run "src/app/api/v1/images/[hash]/route.test.ts"
```

Expected: PASS.

- [ ] **Step 5: Full verification pass**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```

Expected: all four PASS. This is the last task, so this is the whole plan's final gate.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/v1/images/[hash]/route.ts" "src/app/api/v1/images/[hash]/route.test.ts"
git commit -m "feat(api): add GET /api/v1/images/:hash"
```

---

## Notes for whoever executes this

- **Task 1 is the load-bearing one.** Every later task depends on its schema. Get it fully green (migration applied, test passing) before starting Task 2.
- **Tasks 4–7 touch existing, working code** (retention, feed deletion, feed logos, the feeds table UI). Run each file's *full* existing test suite after your change, not just the new test — regressions there are the ones this plan is most likely to introduce.
- **The two-migration split (Task 1 additive, Task 7 the `feeds.logo` drop) is not optional.** Generating them together produces a non-interactive `drizzle-kit generate` failure in CI or any headless shell — see CLAUDE.md's note on this. Do Task 6 (migrate the code off `logo`) before Task 7 (drop the column), not the other way around.
- **Every route test in Tasks 14–23 imports its own device session** via `createDeviceSession` (Task 9) rather than going through the HTTP `/device/pair` route — that's deliberate; only Task 9's own test exercises the route itself.
- **`requireApiUser`'s cookie fallback (Task 8) is what keeps Task 7's `feeds-table.tsx` change working** — the web UI's `<img src="/api/v1/images/:hash">` has no Bearer token, only the browser's ordinary cookie. If Task 23 is done before Task 8's cookie fallback, the web UI's feed logos will 401, not display.
