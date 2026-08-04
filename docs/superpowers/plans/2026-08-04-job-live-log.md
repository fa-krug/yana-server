# Background Job Live Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user open a background job from `/jobs` and see its raw captured output — persisted history plus a live tail while it runs.

**Architecture:** A new `job_logs` table stores one row per captured line. `src/lib/jobs/worker.ts` runs each handler inside an `AsyncLocalStorage`-scoped context (`src/lib/jobs/log-capture.ts`) so `console.log`/`info`/`warn`/`error` calls made *during that handler's own async execution* are redirected into that job's log — safe even though the same process serves HTTP requests concurrently, unlike a time-boxed global console patch. A jobId-keyed in-process pub/sub (`src/lib/jobs/log-bus.ts`) feeds a new session-authenticated SSE route, which a new `/jobs/[id]` detail page's client component consumes via `EventSource`.

**Tech Stack:** Next.js 16 (App Router, Route Handlers), Drizzle ORM + better-sqlite3, `node:async_hooks` (`AsyncLocalStorage`), `node:events` (`EventEmitter`), Vitest (`node` + `dom` projects), `@testing-library/react`.

## Global Constraints

- Line length 100, double quotes, semicolons, trailing commas (Prettier owns formatting).
- No driver mocks in `src/lib/**` tests — real temp SQLite files via `applyMigrationsAt()`.
- Every user-facing string goes in both `messages/en.json` and `messages/de.json`, identical key sets.
- `writeTransaction()` callbacks must be synchronous.
- A route/page that reaches the database calls a Dynamic API (or `connection()`) as its first statement — see CLAUDE.md's `connection()` bullet.
- Base UI components use the `render` prop, never Radix's `asChild` (not needed by this feature — no new Base UI components).
- Commit messages: `<type>(<scope>): <description>` (`feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`).

---

### Task 1: Schema — `job_logs` table

**Files:**
- Modify: `src/lib/db/schema/jobs.ts`
- Modify: `src/lib/db/schema.test.ts`
- Create (generated): `drizzle/0007_<name>.sql` and `drizzle/meta/_journal.json`/`0007_snapshot.json`

**Interfaces:**
- Produces: `jobLogs` (Drizzle table), `JobLog` (`typeof jobLogs.$inferSelect`), re-exported from `src/lib/db/schema.ts` via the existing `export * from "./schema/jobs"`.

- [ ] **Step 1: Write the failing schema tests**

Append to `src/lib/db/schema.test.ts`, inside the existing top-level test file (add a new `describe` block after `describe("phase 13 additive schema", ...)`, before `describe("updatedAt", ...)`):

```ts
describe("job logs", () => {
  it("creates job_logs as a selectable table", () => {
    const { connection, db } = freshDrizzle();
    expect(() => db.select().from(schema.jobLogs).all()).not.toThrow();
    connection.close();
  });

  it("rejects a stream value outside stdout/stderr", () => {
    const connection = freshDatabase();
    connection.exec("INSERT INTO jobs (kind) VALUES ('k')");

    expect(() =>
      connection.exec("INSERT INTO job_logs (job_id, stream, line) VALUES (1, 'bogus', 'x')"),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      connection.exec("INSERT INTO job_logs (job_id, stream, line) VALUES (1, 'stdout', 'ok')"),
    ).not.toThrow();
    connection.close();
  });

  it("cascades a deleted job's log lines away", () => {
    const connection = freshDatabase();
    connection.exec(`
      INSERT INTO jobs (kind) VALUES ('k');
      INSERT INTO job_logs (job_id, stream, line) VALUES (1, 'stdout', 'hello');
      INSERT INTO job_logs (job_id, stream, line) VALUES (1, 'stderr', 'world');
    `);

    connection.exec("DELETE FROM jobs WHERE id = 1");
    expect(count(connection, "job_logs")).toBe(0);
    connection.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/db/schema.test.ts`
Expected: FAIL — `schema.jobLogs is undefined` (table doesn't exist yet) and the SQL `INSERT INTO job_logs` statements fail with "no such table: job_logs".

- [ ] **Step 3: Add the table to the schema**

In `src/lib/db/schema/jobs.ts`, append after the `Job`/`NewJob` type exports at the end of the file:

```ts
/**
 * One row per captured console line for a job's run -- `src/lib/jobs/log-capture.ts`
 * redirects `console.log`/`info`/`warn`/`error` calls made inside a handler's own
 * async execution here, plus `src/lib/jobs/worker.ts`'s own lifecycle markers and
 * a failed handler's stack trace. `id` (globally auto-incrementing) doubles as the
 * per-job ordering/cursor key -- `WHERE job_id = ? AND id > ?` is a cheap indexed
 * range scan, so no separate per-job sequence column is needed.
 *
 * Cascades with its job: nothing deletes `jobs` rows today (confirmed --
 * `retention` only touches `articles`/`article_tombstones`), so in practice this
 * persists exactly as long as the job row it describes. A future job-cleanup
 * feature gets its log cleaned up for free.
 */
export const jobLogs = sqliteTable(
  "job_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    stream: text("stream").notNull(),
    line: text("line").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("job_logs_job_idx").on(table.jobId, table.id),
    check("job_logs_stream_check", sql`"stream" in ('stdout', 'stderr')`),
  ],
);

export type JobLog = typeof jobLogs.$inferSelect;
export type NewJobLog = typeof jobLogs.$inferInsert;
```

No new imports are needed — `sql`, `check`, `index`, `integer`, `sqliteTable`, `text` are already imported at the top of this file, and `jobs` (referenced by `jobId`) is defined earlier in the same file.

- [ ] **Step 4: Generate the migration**

Run: `npx drizzle-kit generate`

Expected: a new `drizzle/0007_<generated-name>.sql` (drizzle-kit picks the adjective-noun name) containing approximately:

```sql
CREATE TABLE `job_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`stream` text NOT NULL,
	`line` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "job_logs_stream_check" CHECK("stream" in ('stdout', 'stderr'))
);
--> statement-breakpoint
CREATE INDEX `job_logs_job_idx` ON `job_logs` (`job_id`,`id`);
```

and a matching new entry in `drizzle/meta/_journal.json` plus a new `drizzle/meta/00XX_snapshot.json`. This is a pure addition (no dropped column alongside it), so it needs no interactive prompt and no split into two migrations. Verify the generated file resembles the above — if drizzle-kit produced something materially different (e.g. missing the CHECK constraint), stop and re-check the schema code before continuing.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/db/schema.test.ts`
Expected: PASS (all three new tests, plus every pre-existing test in the file still green — `applyMigrationsAt()`/`freshDatabase()`/`freshDrizzle()` pick up the new migration automatically).

- [ ] **Step 6: Run the full test suite once for a baseline**

Run: `npm test`
Expected: PASS — no other file references `job_logs` yet, so nothing else should be affected.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/schema/jobs.ts src/lib/db/schema.test.ts drizzle/
git commit -m "feat(jobs): add job_logs table for captured job output"
```

---

### Task 2: Job log storage and pub/sub

**Files:**
- Modify: `src/lib/jobs/queue.ts`
- Create: `src/lib/jobs/log-bus.ts`
- Create: `src/lib/jobs/log-bus.test.ts`
- Modify: `src/lib/jobs/queue.test.ts` (create it if it does not already exist — check first with `ls src/lib/jobs/*.test.ts`; if `queue.test.ts` exists, append to it, matching its existing setup style)

**Interfaces:**
- Consumes: `jobLogs`/`JobLog` (Task 1), `writeTransaction`/`getDb` from `@/lib/db/client` (already imported in `queue.ts`).
- Produces:
  - `appendLogLine(jobId: number, stream: "stdout" | "stderr", line: string): JobLog` (queue.ts)
  - `listJobLogs(jobId: number, afterId?: number): JobLog[]` (queue.ts)
  - `publishJobLog(jobId: number, line: JobLog): void` (log-bus.ts)
  - `subscribeJobLog(jobId: number, listener: (line: JobLog) => void): () => void` (log-bus.ts)

- [ ] **Step 1: Write the failing test for `log-bus.ts`**

Create `src/lib/jobs/log-bus.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { publishJobLog, subscribeJobLog } from "./log-bus";
import type { JobLog } from "../db/schema";

function line(overrides: Partial<JobLog> = {}): JobLog {
  return {
    id: 1,
    jobId: 1,
    stream: "stdout",
    line: "hello",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("src/lib/jobs/log-bus", () => {
  it("delivers a published line only to subscribers of that job id", () => {
    const forJob1 = vi.fn();
    const forJob2 = vi.fn();
    subscribeJobLog(1, forJob1);
    subscribeJobLog(2, forJob2);

    publishJobLog(1, line({ jobId: 1 }));

    expect(forJob1).toHaveBeenCalledTimes(1);
    expect(forJob2).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeJobLog(3, listener);

    unsubscribe();
    publishJobLog(3, line({ jobId: 3 }));

    expect(listener).not.toHaveBeenCalled();
  });

  it("never throws when publishing with no subscribers", () => {
    expect(() => publishJobLog(999, line({ jobId: 999 }))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/jobs/log-bus.test.ts`
Expected: FAIL with "Cannot find module './log-bus'".

- [ ] **Step 3: Implement `log-bus.ts`**

Create `src/lib/jobs/log-bus.ts`:

```ts
import { EventEmitter } from "node:events";

import type { JobLog } from "../db/schema";

/**
 * In-process pub/sub for a job's live log lines, keyed by job id -- not by
 * user id like `src/lib/api/events.ts`'s bus. Not every job kind resolves to
 * an owning user (`retention`, `feed.logo`, ...), and `/jobs` is visible to
 * any signed-in user, not just a job's owner (`listJobs()`/`getJob()` apply
 * no ownership filter). Best-effort, same as `events.ts`: a dropped
 * subscriber loses nothing but a live update, since `listJobLogs()` remains
 * the source of truth a viewer can always re-fetch.
 */
const emitter = new EventEmitter();
// A job's log stream is one listener at a time in the common case, but
// nothing prevents two browser tabs watching the same job -- the default
// limit of 10 would log a spurious warning under ordinary use, not a leak.
emitter.setMaxListeners(0);

function channel(jobId: number): string {
  return `job:${jobId}`;
}

export function publishJobLog(jobId: number, line: JobLog): void {
  emitter.emit(channel(jobId), line);
}

/** Returns an unsubscribe function. */
export function subscribeJobLog(jobId: number, listener: (line: JobLog) => void): () => void {
  const name = channel(jobId);
  emitter.on(name, listener);
  return () => emitter.off(name, listener);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/jobs/log-bus.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Check for an existing `queue.test.ts` and write the failing tests for `queue.ts`'s additions**

Run: `ls src/lib/jobs/*.test.ts`

If `src/lib/jobs/queue.test.ts` exists, open it and match its exact setup (temp DB path, `beforeEach`/`afterEach` shape) rather than the sketch below — the structure must be identical to the rest of that file so tests share one consistent DB lifecycle. If it does not exist, create it using this full setup (mirroring `src/lib/jobs/worker.test.ts`'s real-database pattern):

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrationsAt } from "../db/test-support";

describe("src/lib/jobs/queue", () => {
  let dbPath: string;
  let queue: typeof import("./queue");
  let client: typeof import("../db/client");

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `yana-queue-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    applyMigrationsAt(dbPath);

    client = await import("../db/client");
    queue = await import("./queue");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  describe("appendLogLine / listJobLogs", () => {
    it("persists a line and returns it back from listJobLogs", () => {
      const jobId = queue.enqueue("test.job", {});

      const row = queue.appendLogLine(jobId, "stdout", "hello");

      expect(row.jobId).toBe(jobId);
      expect(row.stream).toBe("stdout");
      expect(row.line).toBe("hello");

      const lines = queue.listJobLogs(jobId);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual(row);
    });

    it("orders lines by id and respects the afterId cursor", () => {
      const jobId = queue.enqueue("test.job", {});
      const first = queue.appendLogLine(jobId, "stdout", "one");
      queue.appendLogLine(jobId, "stdout", "two");
      const third = queue.appendLogLine(jobId, "stdout", "three");

      expect(queue.listJobLogs(jobId).map((l) => l.line)).toEqual(["one", "two", "three"]);
      expect(queue.listJobLogs(jobId, first.id).map((l) => l.line)).toEqual(["two", "three"]);
      expect(queue.listJobLogs(jobId, third.id)).toEqual([]);
    });

    it("keeps different jobs' lines apart", () => {
      const jobA = queue.enqueue("test.job", {});
      const jobB = queue.enqueue("test.job", {});
      queue.appendLogLine(jobA, "stdout", "a-line");
      queue.appendLogLine(jobB, "stdout", "b-line");

      expect(queue.listJobLogs(jobA).map((l) => l.line)).toEqual(["a-line"]);
      expect(queue.listJobLogs(jobB).map((l) => l.line)).toEqual(["b-line"]);
    });

    it("publishes on the job log bus when a line is appended", async () => {
      const { subscribeJobLog } = await import("./log-bus");
      const jobId = queue.enqueue("test.job", {});
      const received: string[] = [];
      const unsubscribe = subscribeJobLog(jobId, (line) => received.push(line.line));

      queue.appendLogLine(jobId, "stderr", "boom");

      expect(received).toEqual(["boom"]);
      unsubscribe();
    });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/lib/jobs/queue.test.ts`
Expected: FAIL — `queue.appendLogLine is not a function`.

- [ ] **Step 7: Implement the additions in `queue.ts`**

In `src/lib/jobs/queue.ts`, update the top imports:

```ts
import { and, asc, count, desc, eq, gt, lte, sql } from "drizzle-orm";

import { publishUserEvent } from "../api/events";
import { getDb, writeTransaction } from "../db/client";
import { articles, feeds, jobLogs, jobs, runs } from "../db/schema";
import type { Job, JobLog, Run } from "../db/schema";
import { publishJobLog } from "./log-bus";
```

(only `gt`, `jobLogs`, `JobLog`, and `publishJobLog` are new; everything else already exists.)

Add these two functions after `listJobs()` at the end of the file:

```ts
export type JobLogStream = "stdout" | "stderr";

/**
 * Appends one captured line to `jobId`'s log and publishes it on the job log
 * bus for any live SSE viewer. Callers (`src/lib/jobs/log-capture.ts`,
 * `src/lib/jobs/worker.ts`) are responsible for catching a failure here --
 * this deliberately does not swallow one itself, so a caller inside an
 * `AsyncLocalStorage`-captured context can choose to log the failure through
 * the *original*, unpatched console rather than risk re-entering the patch.
 */
export function appendLogLine(jobId: number, stream: JobLogStream, line: string): JobLog {
  const row = writeTransaction((db) => {
    return db.insert(jobLogs).values({ jobId, stream, line }).returning().get();
  });

  publishJobLog(jobId, row);
  return row;
}

/** Every log line for `jobId`, ordered oldest first, after `afterId` (exclusive). */
export function listJobLogs(jobId: number, afterId = 0): JobLog[] {
  return getDb()
    .select()
    .from(jobLogs)
    .where(and(eq(jobLogs.jobId, jobId), gt(jobLogs.id, afterId)))
    .orderBy(asc(jobLogs.id))
    .all();
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run src/lib/jobs/queue.test.ts`
Expected: PASS (all tests in the file, new and pre-existing).

- [ ] **Step 9: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/jobs/queue.ts src/lib/jobs/queue.test.ts src/lib/jobs/log-bus.ts src/lib/jobs/log-bus.test.ts
git commit -m "feat(jobs): add job log storage and a jobId-keyed pub/sub"
```

---

### Task 3: Capture — `AsyncLocalStorage`-scoped console redirection

**Files:**
- Create: `src/lib/jobs/log-capture.ts`
- Create: `src/lib/jobs/log-capture.test.ts`

**Interfaces:**
- Consumes: `appendLogLine` (Task 2).
- Produces: `runWithLogCapture<T>(jobId: number, fn: () => Promise<T>): Promise<T>` — used by `src/lib/jobs/worker.ts` (Task 4).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/jobs/log-capture.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrationsAt } from "../db/test-support";

describe("src/lib/jobs/log-capture", () => {
  let dbPath: string;
  let queue: typeof import("./queue");
  let logCapture: typeof import("./log-capture");
  let client: typeof import("../db/client");

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `yana-log-capture-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    applyMigrationsAt(dbPath);

    client = await import("../db/client");
    queue = await import("./queue");
    logCapture = await import("./log-capture");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("redirects console.log to stdout lines for the active job", async () => {
    const jobId = queue.enqueue("test.job", {});

    await logCapture.runWithLogCapture(jobId, async () => {
      console.log("hello from the job");
    });

    const lines = queue.listJobLogs(jobId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ stream: "stdout", line: "hello from the job" });
  });

  it("redirects console.error to stderr lines", async () => {
    const jobId = queue.enqueue("test.job", {});

    await logCapture.runWithLogCapture(jobId, async () => {
      console.error("oh no");
    });

    expect(queue.listJobLogs(jobId)).toEqual([
      expect.objectContaining({ stream: "stderr", line: "oh no" }),
    ]);
  });

  it("splits a multi-line console call into separate rows", async () => {
    const jobId = queue.enqueue("test.job", {});

    await logCapture.runWithLogCapture(jobId, async () => {
      console.log("line one\nline two");
    });

    expect(queue.listJobLogs(jobId).map((l) => l.line)).toEqual(["line one", "line two"]);
  });

  it("does not capture a console call made outside any active context", async () => {
    const jobId = queue.enqueue("test.job", {});

    console.log("not part of any job");

    expect(queue.listJobLogs(jobId)).toEqual([]);
  });

  it("keeps two concurrently-running jobs' output apart", async () => {
    const jobA = queue.enqueue("test.job", {});
    const jobB = queue.enqueue("test.job", {});

    const pA = logCapture.runWithLogCapture(jobA, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      console.log("from A");
    });
    const pB = logCapture.runWithLogCapture(jobB, async () => {
      console.log("from B");
      await new Promise((resolve) => setTimeout(resolve, 40));
      console.log("from B again");
    });

    await Promise.all([pA, pB]);

    expect(queue.listJobLogs(jobA).map((l) => l.line)).toEqual(["from A"]);
    expect(queue.listJobLogs(jobB).map((l) => l.line)).toEqual(["from B", "from B again"]);
  });

  it("does not throw when the underlying log write fails", async () => {
    const jobId = queue.enqueue("test.job", {});
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    connection.close();

    await expect(
      logCapture.runWithLogCapture(jobId, async () => {
        console.log("should not throw even though the database connection is closed");
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/jobs/log-capture.test.ts`
Expected: FAIL with "Cannot find module './log-capture'".

- [ ] **Step 3: Implement `log-capture.ts`**

Create `src/lib/jobs/log-capture.ts`:

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";

import { appendLogLine } from "./queue";

type ConsoleMethod = "log" | "info" | "warn" | "error";

const STREAM_FOR: Record<ConsoleMethod, "stdout" | "stderr"> = {
  log: "stdout",
  info: "stdout",
  warn: "stderr",
  error: "stderr",
};

interface LogContext {
  jobId: number;
}

const als = new AsyncLocalStorage<LogContext>();

/**
 * Captured once, before any method below is patched -- the only safe thing
 * for the patch's own error handling to call. Calling the *patched*
 * `console.error` from inside the patch (e.g. on a failed `appendLogLine`
 * write) would re-enter this same function while the AsyncLocalStorage
 * context is still set, appending forever if the write keeps failing.
 */
const original: Record<ConsoleMethod, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function patch(method: ConsoleMethod): void {
  const stream = STREAM_FOR[method];
  console[method] = (...args: unknown[]) => {
    const context = als.getStore();
    if (!context) {
      original[method](...args);
      return;
    }

    const text = format(...args);
    for (const line of text.split("\n")) {
      try {
        appendLogLine(context.jobId, stream, line);
      } catch (err) {
        original.error(
          `[log-capture] failed to persist a log line for job ${context.jobId}:`,
          err,
        );
      }
    }
  };
}

(Object.keys(STREAM_FOR) as ConsoleMethod[]).forEach(patch);

/**
 * Runs `fn` with `console.log`/`info`/`warn`/`error` calls made during its own
 * async execution captured into `jobId`'s log, instead of the process's real
 * stdout/stderr. Scoped with `AsyncLocalStorage` rather than a time-boxed
 * global patch: `src/lib/jobs/worker.ts` runs jobs one at a time, but the same
 * process also serves HTTP requests concurrently, and a patch that was simply
 * "on" for the duration of an `await` would misattribute an unrelated
 * request's logging to whichever job happened to be running at that moment.
 * `AsyncLocalStorage` instead follows this specific call's own async
 * continuation, wherever it interleaves with anything else.
 */
export function runWithLogCapture<T>(jobId: number, fn: () => Promise<T>): Promise<T> {
  return als.run({ jobId }, fn);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/jobs/log-capture.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/jobs/log-capture.ts src/lib/jobs/log-capture.test.ts
git commit -m "feat(jobs): capture console output during a job's execution"
```

---

### Task 4: Wire capture into the worker

**Files:**
- Modify: `src/lib/jobs/worker.ts`
- Modify: `src/lib/jobs/worker.test.ts`

**Interfaces:**
- Consumes: `runWithLogCapture` (Task 3), `appendLogLine`/`listJobLogs` (Task 2).
- Produces: no new exports — same `runWorkerLoop`/`startWorker`/`stopWorker`/`isWorkerRunning` signatures as before, now with logging side effects.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/jobs/worker.test.ts`, as new `it(...)` blocks inside the existing `describe("src/lib/jobs/worker", ...)` block (after the existing "enforces job timeout" test, before "guards against starting multiple worker loops"):

```ts
  it("captures a handler's console output into the job's log", async () => {
    handlers.registerHandler("logging.job", async () => {
      console.log("doing the thing");
    });

    const id = queue.enqueue("logging.job", {}, { maxAttempts: 1 });

    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.stopWorker();
    await loopPromise;

    const lines = queue.listJobLogs(id).map((l) => ({ stream: l.stream, line: l.line }));
    expect(lines).toEqual([
      { stream: "stdout", line: "job started (attempt 1/1)" },
      { stream: "stdout", line: "doing the thing" },
      { stream: "stdout", line: "job completed" },
    ]);
  });

  it("logs a failed handler's full stack trace as stderr lines", async () => {
    handlers.registerHandler("failing.logged.job", async () => {
      throw new Error("kaboom");
    });

    const id = queue.enqueue("failing.logged.job", {}, { maxAttempts: 1 });

    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.stopWorker();
    await loopPromise;

    const lines = queue.listJobLogs(id);
    expect(lines[0]).toMatchObject({
      stream: "stdout",
      line: "job started (attempt 1/1)",
    });
    const stderrLines = lines.slice(1);
    expect(stderrLines.every((l) => l.stream === "stderr")).toBe(true);
    expect(stderrLines[0]!.line).toContain("kaboom");
    // A real Error's .stack includes a "at ..." frame beneath the message.
    expect(stderrLines.some((l) => l.line.includes("at "))).toBe(true);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/jobs/worker.test.ts`
Expected: FAIL — no `job_logs` rows exist yet for either job (`queue.listJobLogs(id)` returns `[]`).

- [ ] **Step 3: Wire it into `worker.ts`**

In `src/lib/jobs/worker.ts`, update the imports:

```ts
import { appendLogLine, claim, complete, fail, resetOrphaned } from "./queue";
import { getHandler } from "./handlers";
import { runWithLogCapture } from "./log-capture";
```

Add this helper above `runWorkerLoop`:

```ts
/**
 * `appendLogLine()` can throw (e.g. a busy database); a logging failure must
 * never fail the job it is trying to describe. This call always happens
 * outside `runWithLogCapture()`'s active context (before entering it, or
 * after it has already returned/thrown), so the plain `console.error` here
 * is the process's real stderr, not a captured job log line.
 */
function logSafe(jobId: number, stream: "stdout" | "stderr", line: string): void {
  try {
    appendLogLine(jobId, stream, line);
  } catch (err) {
    console.error(`[Worker] failed to append log line for job ${jobId}:`, err);
  }
}
```

Replace the `try`/`catch` inside `runWorkerLoop`'s `while` loop:

```ts
    try {
      await withTimeout(handler(job), timeoutMs);
      complete(job.id);
    } catch (err) {
      fail(job.id, err instanceof Error ? err : String(err));
    }
```

with:

```ts
    logSafe(job.id, "stdout", `job started (attempt ${job.attempts}/${job.maxAttempts})`);
    try {
      await runWithLogCapture(job.id, () => withTimeout(handler(job), timeoutMs));
      logSafe(job.id, "stdout", "job completed");
      complete(job.id);
    } catch (err) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      for (const line of detail.split("\n")) {
        logSafe(job.id, "stderr", line);
      }
      fail(job.id, err instanceof Error ? err : String(err));
    }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/jobs/worker.test.ts`
Expected: PASS — including all pre-existing tests in the file (they assert on `job.status`/`job.error`, which are unchanged).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/jobs/worker.ts src/lib/jobs/worker.test.ts
git commit -m "feat(jobs): log lifecycle markers and capture handler output in the worker"
```

---

### Task 5: SSE route — `/api/jobs/[id]/log-stream`

**Files:**
- Create: `src/app/api/jobs/[id]/log-stream/route.ts`
- Create: `src/app/api/jobs/[id]/log-stream/route.test.ts`

**Interfaces:**
- Consumes: `getJob`, `listJobLogs` (Task 2/existing), `subscribeJobLog` (Task 2), `requireUser` (`@/lib/auth/session`, existing).
- Produces: `GET(request, { params }): Promise<Response>` — consumed by `src/components/jobs/job-log-viewer.tsx` (Task 6) via `EventSource`.

No `connection()` call is needed: `requireUser()` awaits `headers()` as its first action, which already opts this route out of static prerendering — the same reasoning `src/app/media/avatars/[userId]/route.ts` documents for its own `requireUser()`-first shape. No `proxy.ts` change is needed either: `/api/jobs/**` is not in `PUBLIC_PREFIXES`, so the proxy already requires a session cookie to be present before this handler ever runs, exactly like every other route under `(app)`.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/jobs/[id]/log-stream/route.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";

/**
 * A request-scope stub, same pattern as `src/app/media/avatars/[userId]/route.test.ts`:
 * this route is session-cookie authenticated (`requireUser()`), not the
 * Bearer-token style `/api/v1/**` routes use, so `next/headers` needs
 * stubbing rather than `next/server`'s `connection()`.
 */
const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders),
);

/** The real digest `redirect()` throws; not stubbed. */
const REDIRECT = /^NEXT_REDIRECT/;

describe("GET /api/jobs/[id]/log-stream", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let queue: typeof import("@/lib/jobs/queue");

  const CREDENTIALS = { email: "a@example.com", password: "correct horse battery staple" };

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-job-log-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    queue = await import("@/lib/jobs/queue");
    ({ GET } = await import("./route"));
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    fs.rmSync(dbPath, { force: true });
    for (const suffix of ["-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  async function signedInCookie(): Promise<string> {
    await createUserWithPassword({ ...CREDENTIALS, firstName: "A", lastName: "B" });
    return signInCookie(auth, CREDENTIALS);
  }

  function get(
    jobId: string,
    options: { cookie?: string; after?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    if (options.cookie) requestHeaders.current = new Headers({ cookie: options.cookie });
    const url = new URL(`http://localhost/api/jobs/${jobId}/log-stream`);
    if (options.after) url.searchParams.set("after", options.after);
    return GET(new Request(url, { signal: options.signal }), {
      params: Promise.resolve({ id: jobId }),
    });
  }

  it("redirects to login when there is no session", async () => {
    const jobId = queue.enqueue("test.job", {});
    await expect(get(String(jobId))).rejects.toThrow(REDIRECT);
  });

  it("404s for a job id that does not exist", async () => {
    const cookie = await signedInCookie();
    const response = await get("999999", { cookie });
    expect(response.status).toBe(404);
  });

  it("streams persisted lines after the given cursor, then a live line", async () => {
    const cookie = await signedInCookie();
    const jobId = queue.enqueue("test.job", {});
    const first = queue.appendLogLine(jobId, "stdout", "one");
    queue.appendLogLine(jobId, "stdout", "two");

    const controller = new AbortController();
    const response = await get(String(jobId), {
      cookie,
      after: String(first.id),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const backfill = new TextDecoder().decode((await reader.read()).value);
    expect(backfill).toContain('"line":"two"');
    expect(backfill).not.toContain('"line":"one"');

    const readNext = reader.read();
    queue.appendLogLine(jobId, "stdout", "live line");
    const live = new TextDecoder().decode((await readNext).value);
    expect(live).toContain('"line":"live line"');

    controller.abort();
    await reader.cancel();
  });

  it("sends an end event and closes immediately for an already-terminal job", async () => {
    const cookie = await signedInCookie();
    const jobId = queue.enqueue("test.job", {}, { maxAttempts: 1 });
    queue.appendLogLine(jobId, "stdout", "done thing");
    queue.complete(jobId);

    const response = await get(String(jobId), { cookie });
    const reader = response.body!.getReader();

    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"line":"done thing"');

    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain("event: end");

    const third = await reader.read();
    expect(third.done).toBe(true);
  });

  it("unsubscribes and clears the keep-alive interval when the client disconnects", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const cookie = await signedInCookie();
    const jobId = queue.enqueue("test.job", {});

    const controller = new AbortController();
    const response = await get(String(jobId), { cookie, signal: controller.signal });
    const reader = response.body!.getReader();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const intervalId = setIntervalSpy.mock.results[0]!.value;

    controller.abort();
    await reader.cancel();
    await vi.waitFor(() => {
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
    });

    expect(() => queue.appendLogLine(jobId, "stdout", "after disconnect")).not.toThrow();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/api/jobs/\\[id\\]/log-stream/route.test.ts`
Expected: FAIL with "Cannot find module './route'".

- [ ] **Step 3: Implement the route**

Create `src/app/api/jobs/[id]/log-stream/route.ts`:

```ts
import { requireUser } from "@/lib/auth/session";
import { getJob, listJobLogs } from "@/lib/jobs/queue";
import { subscribeJobLog } from "@/lib/jobs/log-bus";

/**
 * How often a ping comment frame is written so intermediaries don't treat a
 * quiet-but-live connection as dead. Same interval and framing as
 * `src/app/api/v1/jobs/events/route.ts`.
 */
const PING_INTERVAL_MS = 15_000;

/**
 * The web UI's live tail for one job's log (`src/components/jobs/job-log-viewer.tsx`).
 * Session-authenticated (`requireUser()`), unlike the Bearer-auth
 * `/api/v1/jobs/events` -- `requireUser()` awaits `headers()` as its first
 * action, which is what opts this route out of static prerendering; see the
 * `connection()` bullet in CLAUDE.md and `src/app/media/avatars/[userId]/route.ts`
 * for the same shape.
 *
 * `?after=<id>` is the cursor: everything persisted after it is sent first
 * (oldest first), then new lines stream live. Both `listJobLogs()` and
 * `subscribeJobLog()` below are synchronous, and nothing awaits between them,
 * so there is no gap in a single-threaded process for a line to be published
 * and missed by both paths.
 *
 * Not user-scoped: `/jobs` today is visible to any signed-in user
 * (`listJobs()`/`getJob()` apply no ownership filter), so this route applies
 * none either.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireUser();

  const { id } = await params;
  const jobId = Number(id);
  const job = Number.isInteger(jobId) ? getJob(jobId) : null;
  if (!job) {
    return new Response(null, { status: 404 });
  }

  const url = new URL(request.url);
  const afterParam = Number(url.searchParams.get("after") ?? "0");
  const cursor = Number.isInteger(afterParam) && afterParam >= 0 ? afterParam : 0;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(keepAlive);
    unsubscribe?.();
  };

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      for (const line of listJobLogs(jobId, cursor)) {
        send("line", line);
      }

      const current = getJob(jobId);
      if (current?.status === "completed" || current?.status === "failed") {
        send("end", { status: current.status });
        controller.close();
        return;
      }

      unsubscribe = subscribeJobLog(jobId, (line) => send("line", line));

      keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, PING_INTERVAL_MS);

      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed -- e.g. `cancel()` ran first.
        }
      });
    },
    cancel: cleanup,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/app/api/jobs/\\[id\\]/log-stream/route.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run lint and the full test suite**

Run: `npm run lint && npm test`
Expected: both PASS. If lint flags the `lastId`/`void lastId` construct from Step 3, apply the simplification mentioned there.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/jobs/
git commit -m "feat(jobs): add a session-authenticated SSE route for a job's live log"
```

---

### Task 6: Log viewer client component

**Files:**
- Create: `src/components/jobs/job-log-viewer.tsx`
- Create: `src/components/jobs/job-log-viewer.test.tsx`
- Modify: `messages/en.json`
- Modify: `messages/de.json`

**Interfaces:**
- Produces: `<JobLogViewer jobId initialLines>` — consumed by `src/app/(app)/jobs/[id]/page.tsx` (Task 7).
- Consumes: `JobLogLine` type (defined in this file, matching the shape `queue.ts`'s `JobLog` serializes to over SSE/JSON — `id`, `stream`, `line`, `createdAt`; not the schema's `JobLog` type directly, since `createdAt` crosses the RSC boundary as an ISO string once JSON-serialized, not a `Date`).

Add to `messages/en.json`'s `"jobs"` object (after `"noJobs"`):

```json
    "log": "Log",
    "logEmpty": "No log output yet.",
    "logEnded": "Job finished — log ended."
```

Add to `messages/de.json`'s `"jobs"` object (after `"noJobs"`), keeping the exact same key set:

```json
    "log": "Protokoll",
    "logEmpty": "Noch keine Protokollausgabe.",
    "logEnded": "Auftrag beendet — Protokoll beendet."
```

(Remember the trailing comma on the preceding `"noJobs"` line in both files, and run `npm run format` afterwards.)

- [ ] **Step 1: Write the failing test**

Create `src/components/jobs/job-log-viewer.test.tsx`:

```tsx
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { JobLogViewer } from "./job-log-viewer";

/**
 * jsdom does not implement `EventSource` -- there is no existing precedent in
 * this repo for testing one, so this is a minimal stand-in: it records every
 * instance created (so a test can reach the one the component opened) and
 * lets a test fire a named event with a JSON-encoded payload, matching the
 * real `EventSource`'s `addEventListener(type, listener)` shape closely
 * enough for `JobLogViewer` to be unable to tell the difference.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const INITIAL = [
  { id: 1, stream: "stdout" as const, line: "job started (attempt 1/1)", createdAt: "2026-08-04T00:00:00.000Z" },
  { id: 2, stream: "stderr" as const, line: "oh no", createdAt: "2026-08-04T00:00:01.000Z" },
];

describe("JobLogViewer", () => {
  it("renders the initial lines", () => {
    renderWithProviders(<JobLogViewer jobId={7} initialLines={INITIAL} />);

    expect(screen.getByText("job started (attempt 1/1)")).toBeInTheDocument();
    expect(screen.getByText("oh no")).toBeInTheDocument();
  });

  it("shows the empty state with no lines", () => {
    renderWithProviders(<JobLogViewer jobId={7} initialLines={[]} />);

    expect(screen.getByText("No log output yet.")).toBeInTheDocument();
  });

  it("opens an EventSource at the job's log-stream URL, cursored after the last initial line", () => {
    renderWithProviders(<JobLogViewer jobId={7} initialLines={INITIAL} />);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe("/api/jobs/7/log-stream?after=2");
  });

  it("appends a line received over the live stream", () => {
    renderWithProviders(<JobLogViewer jobId={7} initialLines={INITIAL} />);
    const source = FakeEventSource.instances[0]!;

    act(() => {
      source.emit("line", { id: 3, stream: "stdout", line: "a new line", createdAt: "2026-08-04T00:00:02.000Z" });
    });

    expect(screen.getByText("a new line")).toBeInTheDocument();
  });

  it("shows the ended state and closes the source on an end event", () => {
    renderWithProviders(<JobLogViewer jobId={7} initialLines={INITIAL} />);
    const source = FakeEventSource.instances[0]!;

    act(() => {
      source.emit("end", { status: "completed" });
    });

    expect(screen.getByText("Job finished — log ended.")).toBeInTheDocument();
    expect(source.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/jobs/job-log-viewer.test.tsx`
Expected: FAIL with "Cannot find module './job-log-viewer'".

- [ ] **Step 3: Implement the component**

Create `src/components/jobs/job-log-viewer.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

export interface JobLogLine {
  id: number;
  stream: "stdout" | "stderr";
  line: string;
  createdAt: string;
}

export function JobLogViewer({
  jobId,
  initialLines,
}: {
  jobId: number;
  initialLines: JobLogLine[];
}) {
  const t = useTranslations("jobs");
  const [lines, setLines] = useState(initialLines);
  const [ended, setEnded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef(initialLines.at(-1)?.id ?? 0);

  useEffect(() => {
    const source = new EventSource(`/api/jobs/${jobId}/log-stream?after=${lastIdRef.current}`);

    source.addEventListener("line", (event) => {
      const line = JSON.parse((event as MessageEvent).data) as JobLogLine;
      lastIdRef.current = line.id;
      setLines((prev) => [...prev, line]);
    });

    source.addEventListener("end", () => {
      setEnded(true);
      source.close();
    });

    return () => source.close();
  }, [jobId]);

  useEffect(() => {
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight });
  }, [lines]);

  return (
    <div
      ref={containerRef}
      className="max-h-96 overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-xs"
    >
      {lines.length === 0 ? (
        <p className="text-muted-foreground">{t("logEmpty")}</p>
      ) : (
        lines.map((line) => (
          <div
            key={line.id}
            className={cn("whitespace-pre-wrap", line.stream === "stderr" && "text-destructive")}
          >
            {line.line}
          </div>
        ))
      )}
      {ended && <p className="mt-2 text-muted-foreground">{t("logEnded")}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/components/jobs/job-log-viewer.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the i18n parity test, format, and the full suite**

Run: `npx vitest run src/i18n/messages.test.ts && npm run format && npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/jobs/job-log-viewer.tsx src/components/jobs/job-log-viewer.test.tsx messages/en.json messages/de.json
git commit -m "feat(jobs): add the live log viewer client component"
```

---

### Task 7: Job detail page, table link, and the CLAUDE.md exemption list

**Files:**
- Create: `src/app/(app)/jobs/[id]/page.tsx`
- Modify: `src/components/jobs/jobs-table.tsx`
- Create: `src/components/jobs/jobs-table.test.tsx`
- Modify: `messages/en.json`
- Modify: `messages/de.json`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `getJob`/`listJobLogs` (Task 2), `JobLogViewer` (Task 6), `requireUser` (existing).
- Produces: the `/jobs/[id]` route; no exports consumed elsewhere.

Add to `messages/en.json`'s `"jobs"` object (after the three keys Task 6 added):

```json
    "detailTitle": "Job #{id}"
```

Add to `messages/de.json`'s `"jobs"` object, same position:

```json
    "detailTitle": "Auftrag #{id}"
```

- [ ] **Step 1: Write the failing test for the table link**

Create `src/components/jobs/jobs-table.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";
import type { Job } from "@/lib/db/schema";

import { JobsTable } from "./jobs-table";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    runId: null,
    kind: "aggregate",
    payload: {},
    status: "completed",
    attempts: 1,
    maxAttempts: 3,
    runAt: new Date("2026-08-01T00:00:00Z"),
    startedAt: new Date("2026-08-01T00:00:01Z"),
    finishedAt: new Date("2026-08-01T00:00:02Z"),
    progress: 100,
    error: "",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

describe("JobsTable", () => {
  it("links each row's kind to its detail page", () => {
    renderWithProviders(
      <JobsTable rows={[job({ id: 42, kind: "aggregate" })]} page={1} pageSize={50} total={1} />,
    );

    expect(screen.getByRole("link", { name: "aggregate" }).getAttribute("href")).toBe("/jobs/42");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/jobs/jobs-table.test.tsx`
Expected: FAIL — the `kind` cell renders as plain text today, so there is no `link` role with that name.

- [ ] **Step 3: Link the table's kind cell, and export `StatusBadge` for reuse**

In `src/components/jobs/jobs-table.tsx`, add the import and export the status badge (so the detail page can render the same colors instead of duplicating the switch statement):

```tsx
import Link from "next/link";
```

Change `function StatusBadge(...)` to `export function StatusBadge(...)` (same body, just exported).

Change the `kind` column's `cell`:

```tsx
    {
      key: "kind",
      header: t("kind"),
      cell: (job) => (
        <Link href={`/jobs/${job.id}`} className="font-mono text-sm hover:underline">
          {job.kind}
        </Link>
      ),
    },
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/components/jobs/jobs-table.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the detail page**

Create `src/app/(app)/jobs/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { JobLogViewer } from "@/components/jobs/job-log-viewer";
import { StatusBadge } from "@/components/jobs/jobs-table";
import { requireUser } from "@/lib/auth/session";
import { getJob, listJobLogs } from "@/lib/jobs/queue";

export default async function JobDetailPage({
  params,
}: {
  // Structural, not the generated `PageProps<"/jobs/[id]">` -- see
  // src/app/(app)/users/[id]/page.tsx for why.
  params: Promise<{ id: string }>;
}) {
  /** The gate, first -- `requireUser()` awaits `headers()`, opting this route
   *  out of static prerendering the same way src/app/(app)/users/[id]/page.tsx
   *  does with requireAdmin(); see the connection() bullet in CLAUDE.md. */
  await requireUser();

  const { id } = await params;
  const jobId = Number(id);
  const job = Number.isInteger(jobId) ? getJob(jobId) : null;
  if (!job) notFound();

  const logs = listJobLogs(job.id);
  const t = await getTranslations("jobs");

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("detailTitle", { id: job.id })}</h1>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">{t("kind")}</dt>
          <dd className="font-mono">{job.kind}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("status")}</dt>
          <dd>
            <StatusBadge status={job.status} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("attempts")}</dt>
          <dd>
            {job.attempts} / {job.maxAttempts}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("progress")}</dt>
          <dd>{job.progress}%</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("createdAt")}</dt>
          <dd>{job.createdAt.toLocaleString()}</dd>
        </div>
      </dl>

      <div>
        <h2 className="mb-2 text-sm font-medium">{t("log")}</h2>
        <JobLogViewer
          jobId={job.id}
          initialLines={logs.map((line) => ({
            id: line.id,
            stream: line.stream as "stdout" | "stderr",
            line: line.line,
            createdAt: line.createdAt.toISOString(),
          }))}
        />
      </div>
    </div>
  );
}
```

This page has no direct component test: it is an `async` server component, and per CLAUDE.md's testing conventions those cannot be rendered by testing-library (see `settings/page.tsx`, which is the same kind of untested-by-design page). It is verified manually in Step 8.

- [ ] **Step 6: Update the CLAUDE.md exemption list**

In `CLAUDE.md`, find the paragraph containing `**The five that do**:` (it lists the routes that reach the database via an already-awaited Dynamic API instead of an explicit `connection()` call). Update it to include the two new routes this feature adds — both call `requireUser()` as their first statement:

Change:

```
  route out just as well. **The five that do**: `src/app/(app)/layout.tsx`,
  because `requireUser()` awaits `headers()` before anything touches SQLite;
  `src/app/media/avatars/[userId]/route.ts`, for the same reason; and phase 5's
  three `/users` routes — `src/app/(app)/users/page.tsx`,
  `src/app/(app)/users/new/page.tsx`, `src/app/(app)/users/[id]/page.tsx` —
  where `requireAdmin()` does it. That exemption is only worth as much as the
```

to:

```
  route out just as well. **The seven that do**: `src/app/(app)/layout.tsx`,
  because `requireUser()` awaits `headers()` before anything touches SQLite;
  `src/app/media/avatars/[userId]/route.ts`, for the same reason;
  `src/app/(app)/jobs/[id]/page.tsx` and
  `src/app/api/jobs/[id]/log-stream/route.ts`, likewise (the job live-log
  feature's detail page and its SSE route, both gated by `requireUser()`
  before anything else); and phase 5's three `/users` routes —
  `src/app/(app)/users/page.tsx`, `src/app/(app)/users/new/page.tsx`,
  `src/app/(app)/users/[id]/page.tsx` — where `requireAdmin()` does it. That
  exemption is only worth as much as the
```

Leave the rest of that paragraph (the sentence beginning "it is the first statement of each of those three") unchanged — it refers specifically to the three `/users` routes, not the full list.

- [ ] **Step 7: Run the i18n parity test, format, lint, typecheck, and the full suite**

Run: `npx vitest run src/i18n/messages.test.ts && npm run format && npm run lint && npm run typecheck && npm test`
Expected: all PASS.

- [ ] **Step 8: Manually verify in a running dev server**

Run: `npm run dev`, then in a browser:

1. Sign in, go to `/jobs`. Confirm each row's `kind` is a clickable link.
2. Click one. Confirm `/jobs/[id]` renders the metadata grid and a log panel.
3. Trigger a real job (e.g. via the existing "aggregate" trigger, or by using `POST /api/v1/aggregate` if you have a feed configured) and watch its detail page while it runs — confirm new lines appear without a manual reload, and that "job started"/"job completed" markers show up.
4. Open the detail page for a job that already finished. Confirm its full history renders immediately and the log ends cleanly (no lingering "connecting" state, no console errors in the browser devtools).
5. Visit `/jobs/999999999` (an id that does not exist). Confirm a 404.

Stop the dev server once satisfied.

- [ ] **Step 9: Commit**

```bash
git add src/app/\(app\)/jobs/ src/components/jobs/jobs-table.tsx src/components/jobs/jobs-table.test.tsx messages/en.json messages/de.json CLAUDE.md
git commit -m "feat(jobs): add the job detail page with a live log viewer"
```

---

## Self-Review Notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-08-04-job-live-log-design.md` maps to a task — schema (Task 1), capture mechanism and its `AsyncLocalStorage` reasoning (Task 3), no size cap (no task needed — this is the absence of a feature, confirmed by Task 3's tests never asserting a truncation), live delivery (Task 5), UI (Tasks 6–7), touch points table (covered across Tasks 1–7), testing section (a test is written in every task).
- **Placeholder scan:** no TBD/TODO; every step shows real code or a real command.
- **Type consistency:** `JobLogStream`/`JobLog` (Task 2) flow unchanged into `log-capture.ts` (Task 3), `worker.ts` (Task 4), the SSE route (Task 5); the route's JSON payload shape (`id`, `stream`, `line`, `createdAt`) matches `JobLogLine` (Task 6) and the detail page's mapping (Task 7) field-for-field.
