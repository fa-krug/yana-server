# Jobs Bulk Cancel & Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bulk Cancel and bulk Delete actions to the `/jobs` ("Aufgaben") list, plus the same two actions for a single job on `/jobs/[id]`.

**Architecture:** Two new job statuses (`cancelling`, `cancelled`) ride on the existing plain-text `jobs.status` column (no migration needed). A cooperative-cancellation checkpoint (`isCancelRequested()`) is added to the two handlers that loop over many items; `worker.ts` special-cases a new `JobCancelledError` into the new terminal state instead of retrying. Three new server actions (`cancelJobs`, `deleteJobs`, `getJobsStatus`) back the UI; deleting a still-running job requests cancellation, polls until it stops, then deletes it — never leaving it half-cancelled.

**Tech Stack:** Next.js 16 (App Router, Server Actions), Drizzle + better-sqlite3, next-intl, Vitest (`node` + `dom` projects), Testing Library, Base UI (`@base-ui/react`) via this repo's shadcn components.

## Global Constraints

- Line length 100, double quotes, semicolons, trailing commas (Prettier). Run `npm run lint && npm run format:check && npm run typecheck && npm test` before considering any task done.
- No Radix `asChild` — Base UI's `render` prop only. `<ConfirmDestructive trigger={<Button>...</Button>} .../>` is the established pattern; do not change it.
- Every user-facing string comes from `messages/en.json` **and** `messages/de.json`, identical key sets (`src/i18n/messages.test.ts` enforces this).
- Server actions never return raw driver/zod/prose errors — only catalog keys (`errorKey: NamespaceKey<"jobs">`).
- No server action is ever awaited bare from a client component — always through `attempt()`/`attemptCall()` (`@/lib/attempt`).
- `writeTransaction()`'s callback must be synchronous (no `async`), and nesting is supported (joins the outer transaction) — see `src/lib/db/client.ts`.
- A component receives only the columns it renders, never the whole row (`<JobActions job={{ id, status }} />`, not the full `Job`).
- Test files: `.test.ts` under `src/lib/**` uses the real-SQLite `node` Vitest project (`applyMigrationsAt()` from `src/lib/db/test-support.ts`); `.test.tsx` under `src/components/**` uses the `dom` project (`renderWithProviders()` from `src/test/render.tsx`, router mocked via `@/test/next-navigation`).

---

## Task 1: Cancellation primitives — `queue.ts`, `log-bus.ts`, the log-stream route

**Files:**
- Create: `src/lib/jobs/errors.ts`
- Modify: `src/lib/jobs/queue.ts`
- Modify: `src/lib/jobs/log-bus.ts`
- Modify: `src/app/api/jobs/[id]/log-stream/route.ts`
- Test: `src/lib/jobs/queue.test.ts`

**Interfaces:**
- Produces (for Tasks 2, 3, 5): `JobCancelledError` (class, no constructor args) from `src/lib/jobs/errors.ts`; `requestCancel(id: number): "cancelled" | "cancelling" | "unchanged"`, `isCancelRequested(id: number): boolean`, `cancelled(id: number): void` from `src/lib/jobs/queue.ts`.
- Consumes: nothing new — only existing `queue.ts`/`log-bus.ts` internals (`bumpRunCounters`, `publishJobOutcome`, `publishJobTerminal`, `writeTransaction`, `getDb`).

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/jobs/queue.test.ts`, inside the existing top-level `describe("src/lib/jobs/queue", ...)` block (so it shares the file's `beforeEach`/`afterEach`/`client`/`queue` setup — do not duplicate that setup):

```ts
  describe("requestCancel", () => {
    it("cancels a pending job immediately, without claiming it first", () => {
      const id = queue.enqueue("noop", {});

      const outcome = queue.requestCancel(id);
      expect(outcome).toBe("cancelled");

      const job = queue.getJob(id);
      expect(job?.status).toBe("cancelled");
      expect(job?.finishedAt).not.toBeNull();
    });

    it("asks a running job to stop, without marking it cancelled yet", () => {
      const id = queue.enqueue("noop", {});
      queue.claim();

      const outcome = queue.requestCancel(id);
      expect(outcome).toBe("cancelling");

      const job = queue.getJob(id);
      expect(job?.status).toBe("cancelling");
      expect(job?.finishedAt).toBeNull();
    });

    it("is a no-op against an already-terminal job", () => {
      const id = queue.enqueue("noop", {});
      queue.claim();
      queue.complete(id);

      const outcome = queue.requestCancel(id);
      expect(outcome).toBe("unchanged");
      expect(queue.getJob(id)?.status).toBe("completed");
    });

    it("is a no-op for a job id that does not exist", () => {
      expect(queue.requestCancel(999_999)).toBe("unchanged");
    });
  });

  describe("isCancelRequested", () => {
    it("is true only once a running job has been asked to stop", () => {
      const id = queue.enqueue("noop", {});
      queue.claim();
      expect(queue.isCancelRequested(id)).toBe(false);

      queue.requestCancel(id);
      expect(queue.isCancelRequested(id)).toBe(true);
    });
  });

  describe("cancelled", () => {
    it("marks a job cancelled, bumps its run's failedJobs counter, and publishes a terminal event", async () => {
      const { subscribeJobTerminal } = await import("./log-bus");
      const userId = seedUserAndReturnId();
      const runId = queue.enqueueRun(userId, "noop", [{}]);
      const [job] = client.getDb().select().from(jobs).where(eq(jobs.runId, runId)).all();
      queue.claim();

      const heard: unknown[] = [];
      const unsubscribe = subscribeJobTerminal(job!.id, (status) => heard.push(status));

      queue.cancelled(job!.id);
      unsubscribe();

      const updated = queue.getJob(job!.id);
      expect(updated?.status).toBe("cancelled");
      expect(updated?.finishedAt).not.toBeNull();

      const run = queue.getRun(runId);
      expect(run?.failedJobs).toBe(1);
      expect(heard).toEqual(["cancelled"]);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/jobs/queue.test.ts`
Expected: FAIL — `queue.requestCancel is not a function` (and similarly for `isCancelRequested`/`cancelled`).

- [ ] **Step 3: Implement**

Create `src/lib/jobs/errors.ts`:

```ts
/**
 * Thrown by a job handler that notices `isCancelRequested()` (`./queue`) at
 * one of its cooperative-cancellation checkpoints. `worker.ts` catches this
 * specifically and calls `cancelled()` instead of `fail()` -- no retry, no
 * stderr spam from a stack trace that isn't a bug.
 */
export class JobCancelledError extends Error {
  constructor() {
    super("job cancelled");
    this.name = "JobCancelledError";
  }
}
```

In `src/lib/jobs/queue.ts`, widen `publishJobOutcome`'s status parameter (find `function publishJobOutcome(job: Job, status: "completed" | "failed"): void {`) to:

```ts
function publishJobOutcome(job: Job, status: "completed" | "failed" | "cancelled"): void {
```

Then add the three new exports. Place them after `progress()` and before `resetOrphaned()`:

```ts
export type CancelOutcome = "cancelled" | "cancelling" | "unchanged";

/**
 * Ask a job to stop. A `pending` job is cancelled immediately -- it never
 * started, so there is nothing to interrupt. A `running` job is only asked:
 * it becomes `cancelling`, and stays that way until its handler notices
 * `isCancelRequested()` at one of its own checkpoints and worker.ts calls
 * `cancelled()`. Anything already terminal, or already `cancelling`, is left
 * alone.
 */
export function requestCancel(id: number): CancelOutcome {
  const job = getDb().select().from(jobs).where(eq(jobs.id, id)).get();
  if (!job) return "unchanged";

  if (job.status === "pending") {
    cancelled(id);
    return "cancelled";
  }

  if (job.status === "running") {
    const result = writeTransaction((db) =>
      db
        .update(jobs)
        .set({ status: "cancelling" })
        .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
        .run(),
    );
    return result.changes === 1 ? "cancelling" : "unchanged";
  }

  return "unchanged";
}

/** Cheap indexed read a handler calls at its own checkpoints -- the same
 * per-item database round trip `progress()` already makes, so this adds no
 * new cost pattern to a loop that already has one. */
export function isCancelRequested(id: number): boolean {
  const row = getDb().select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id)).get();
  return row?.status === "cancelling";
}

/**
 * The terminal transition a cancellation lands on -- reached either
 * instantly (`requestCancel()` on a still-pending job) or after a running
 * job's handler notices `isCancelRequested()` and worker.ts calls this
 * instead of `fail()`. Mirrors `complete()`/`fail()`: sets `finishedAt`,
 * bumps the parent run's counters into the same bucket `fail()` uses (a
 * cancelled job is not a run success, and `waitForRun()`'s poll only
 * recognizes a run as terminal once `completedJobs + failedJobs >=
 * totalJobs`), and publishes a terminal event so an open SSE viewer closes
 * out instead of hanging.
 */
export function cancelled(id: number): void {
  const job = writeTransaction((db) => {
    const current = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!current) return null;

    db.update(jobs)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(jobs.id, id))
      .run();

    if (current.runId !== null) {
      bumpRunCounters(db, current.runId, "failed");
    }

    return current;
  });

  if (job) {
    publishJobOutcome({ ...job, status: "cancelled" }, "cancelled");
    publishJobTerminal(id, "cancelled");
  }
}
```

In `src/lib/jobs/log-bus.ts`, widen both the terminal publish/subscribe types:

```ts
export function publishJobTerminal(jobId: number, status: "completed" | "failed" | "cancelled"): void {
```

```ts
export function subscribeJobTerminal(
  jobId: number,
  listener: (status: "completed" | "failed" | "cancelled") => void,
): () => void {
```

In `src/app/api/jobs/[id]/log-stream/route.ts`, widen the immediate-close check (the only line that needs to change there):

```ts
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/jobs/queue.test.ts src/lib/jobs/log-bus.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `resetOrphaned`'s new branch**

Add to the existing `resetOrphaned` tests in `queue.test.ts`:

```ts
    it("finalizes an orphaned cancelling job as cancelled, rather than resuming it as pending", () => {
      const id = queue.enqueue("noop", {});
      queue.claim();
      queue.requestCancel(id); // -> "cancelling"

      const resetCount = queue.resetOrphaned(new Date(Date.now() + 1000));

      // The return value keeps counting only the running -> pending branch,
      // unchanged from before this task -- src/lib/jobs/integration.test.ts
      // depends on that exact count.
      expect(resetCount).toBe(0);
      expect(queue.getJob(id)?.status).toBe("cancelled");
    });
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- src/lib/jobs/queue.test.ts`
Expected: FAIL — the orphaned `cancelling` row is still `cancelling` (or, if it's classified as `running`-adjacent by mistake, some other wrong status), not `cancelled`.

- [ ] **Step 7: Implement**

Replace `resetOrphaned()` in `queue.ts` with:

```ts
export function resetOrphaned(before: Date): number {
  // A job that was mid-cancellation when the previous process died: honor
  // the cancellation rather than resuming it as a fresh pending attempt,
  // since a "cancelling" row exists only because a human asked it to stop.
  const orphanedCancelling = getDb()
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "cancelling"), lte(jobs.startedAt, before)))
    .all();
  for (const { id } of orphanedCancelling) {
    cancelled(id);
  }

  return writeTransaction((db) => {
    const result = db
      .update(jobs)
      .set({
        status: "pending",
        startedAt: null,
      })
      .where(and(eq(jobs.status, "running"), lte(jobs.startedAt, before)))
      .run();

    return result.changes;
  });
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- src/lib/jobs/queue.test.ts src/lib/jobs/integration.test.ts`
Expected: PASS (including the pre-existing "recovers from crash mid-run" integration test, whose `expect(resetCount).toBe(5)` must be unaffected).

- [ ] **Step 9: Full verification and commit**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: all green.

```bash
git add src/lib/jobs/errors.ts src/lib/jobs/queue.ts src/lib/jobs/queue.test.ts src/lib/jobs/log-bus.ts src/app/api/jobs/\[id\]/log-stream/route.ts
git commit -m "feat(jobs): add cooperative-cancellation primitives to the job queue"
```

---

## Task 2: `worker.ts` honors `JobCancelledError`

**Files:**
- Modify: `src/lib/jobs/worker.ts`
- Test: `src/lib/jobs/worker.test.ts`

**Interfaces:**
- Consumes (from Task 1): `JobCancelledError` from `@/lib/jobs/errors` (import as `"./errors"` from within `src/lib/jobs/`), `cancelled(id: number): void` from `./queue`.
- Produces: nothing new for later tasks — this task is a leaf.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/jobs/worker.test.ts`:

```ts
  it("cancels the job, without retrying, when a handler throws JobCancelledError", async () => {
    const { JobCancelledError } = await import("./errors");
    handlers.registerHandler("cancelling.job", async () => {
      throw new JobCancelledError();
    });

    const id = queue.enqueue("cancelling.job", {}, { maxAttempts: 3 });

    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.stopWorker();
    await loopPromise;

    const job = queue.getJob(id);
    expect(job?.status).toBe("cancelled");
    expect(job?.attempts).toBe(1);
    expect(job?.error).toBe("");

    const lines = queue.listJobLogs(id).map((l) => l.line);
    expect(lines).toEqual(["job started (attempt 1/3)", "job cancelled"]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/jobs/worker.test.ts`
Expected: FAIL — `job?.status` is `"pending"` (the normal retry path, since `fail()` backs off below `maxAttempts`) instead of `"cancelled"`, and the log line `"job cancelled"` is missing.

- [ ] **Step 3: Implement**

In `src/lib/jobs/worker.ts`, add the two new imports:

```ts
import { appendLogLine, cancelled, claim, complete, fail, resetOrphaned } from "./queue";
import { JobCancelledError } from "./errors";
```

Then change the `catch` block inside `runWorkerLoop()` from:

```ts
    } catch (err) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      for (const line of detail.split("\n")) {
        appendLogLine(job.id, "stderr", line);
      }
      fail(job.id, err instanceof Error ? err : String(err));
    }
```

to:

```ts
    } catch (err) {
      if (err instanceof JobCancelledError) {
        appendLogLine(job.id, "stdout", "job cancelled");
        cancelled(job.id);
        continue;
      }

      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      for (const line of detail.split("\n")) {
        appendLogLine(job.id, "stderr", line);
      }
      fail(job.id, err instanceof Error ? err : String(err));
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/jobs/worker.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification and commit**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: all green (including `src/lib/jobs/integration.test.ts`, unaffected by this change).

```bash
git add src/lib/jobs/worker.ts src/lib/jobs/worker.test.ts
git commit -m "feat(jobs): stop retrying a job whose handler reports cancellation"
```

---

## Task 3: Cancellation checkpoints in `aggregate.ts` and `retention.ts`

**Files:**
- Modify: `src/lib/jobs/handlers/aggregate.ts`
- Modify: `src/lib/jobs/handlers/retention.ts`
- Test: `src/lib/jobs/handlers/handlers.test.ts`

**Interfaces:**
- Consumes (from Task 1): `isCancelRequested(id: number): boolean` from `../queue`, `JobCancelledError` from `../errors`.
- Produces: nothing new for later tasks — this task is a leaf. (`feed.update`/`feed.restore` inherit this checkpoint for free, since both delegate to `handleAggregateJob`.)

- [ ] **Step 1: Mock `isCancelRequested` in the test file, defaulting to "never cancel"**

At the top of `src/lib/jobs/handlers/handlers.test.ts`, alongside the existing `vi.mock("@/lib/aggregators/factory", ...)` and `vi.mock("@/lib/feeds/logo", ...)` calls, add:

```ts
vi.mock("../queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../queue")>();
  return { ...actual, isCancelRequested: vi.fn(() => false) };
});
```

This keeps every existing test in the file working unchanged (cancellation is never requested by default) while giving the two new tests below a mock to control.

- [ ] **Step 2: Run the full test file to confirm this alone breaks nothing**

Run: `npm test -- src/lib/jobs/handlers/handlers.test.ts`
Expected: PASS (every existing test, unchanged in behavior).

- [ ] **Step 3: Write the failing test for `aggregate.ts`**

Add inside the existing `describe("aggregate", ...)` block:

```ts
    it("stops the article loop once cancellation is requested, keeping already-processed articles", async () => {
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

      const rawArticles = [
        { name: "One", identifier: "art-1", raw_content: "<p>1</p>", content: "<p>1</p>", date: new Date() },
        { name: "Two", identifier: "art-2", raw_content: "<p>2</p>", content: "<p>2</p>", date: new Date() },
        { name: "Three", identifier: "art-3", raw_content: "<p>3</p>", content: "<p>3</p>", date: new Date() },
      ];

      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => rawArticles,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      vi.mocked(queue.isCancelRequested).mockReturnValueOnce(false).mockReturnValueOnce(true);

      const aggregateHandler = handlers.getHandler("aggregate");
      const job = makeJob("aggregate", { feedId });

      const { JobCancelledError } = await import("../errors");
      await expect(aggregateHandler!(job)).rejects.toThrow(JobCancelledError);

      const inserted = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.feedId, feedId))
        .all();
      expect(inserted).toHaveLength(1);
    });
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- src/lib/jobs/handlers/handlers.test.ts`
Expected: FAIL — all 3 articles are inserted (no checkpoint exists yet), and no `JobCancelledError` is thrown.

- [ ] **Step 5: Implement the `aggregate.ts` checkpoint**

In `src/lib/jobs/handlers/aggregate.ts`, add the two imports:

```ts
import { JobCancelledError } from "../errors";
import { appendLogLine, isCancelRequested, progress } from "../queue";
```

Then change the loop's opening line from:

```ts
  for (let i = 0; i < total; i++) {
    const raw = rawArticles[i];
```

to:

```ts
  for (let i = 0; i < total; i++) {
    if (isCancelRequested(job.id)) {
      throw new JobCancelledError();
    }

    const raw = rawArticles[i];
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- src/lib/jobs/handlers/handlers.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing test for `retention.ts`**

Add a new `describe` block after the existing `describe("retention", ...)` block:

```ts
  describe("retention cancellation", () => {
    it("stops processing further users once cancellation is requested", async () => {
      let userAId = "";
      let userBId = "";
      client.writeTransaction((db) => {
        const a = db
          .insert(schema.users)
          .values({ id: "user-a", email: "a@example.com" })
          .returning({ id: schema.users.id })
          .get();
        const b = db
          .insert(schema.users)
          .values({ id: "user-b", email: "b@example.com" })
          .returning({ id: schema.users.id })
          .get();
        userAId = a.id;
        userBId = b.id;

        db.insert(schema.userSettings).values({ userId: userAId, articleRetentionDays: 60 }).run();
        db.insert(schema.userSettings).values({ userId: userBId, articleRetentionDays: 60 }).run();

        const feedA = db
          .insert(schema.feeds)
          .values({ name: "Feed A", userId: userAId })
          .returning({ id: schema.feeds.id })
          .get();
        const feedB = db
          .insert(schema.feeds)
          .values({ name: "Feed B", userId: userBId })
          .returning({ id: schema.feeds.id })
          .get();

        const eightyDaysAgo = Math.floor((Date.now() - 80 * 24 * 3_600_000) / 1000);

        const a1 = db
          .insert(schema.articles)
          .values({ name: "Old A", identifier: "a1", feedId: feedA.id, date: new Date("2024-01-01"), starred: false })
          .returning({ id: schema.articles.id })
          .get();
        db.run(sql`UPDATE articles SET created_at = ${eightyDaysAgo} WHERE id = ${a1.id}`);

        const b1 = db
          .insert(schema.articles)
          .values({ name: "Old B", identifier: "b1", feedId: feedB.id, date: new Date("2024-01-01"), starred: false })
          .returning({ id: schema.articles.id })
          .get();
        db.run(sql`UPDATE articles SET created_at = ${eightyDaysAgo} WHERE id = ${b1.id}`);
      });

      vi.mocked(queue.isCancelRequested).mockReturnValueOnce(false).mockReturnValueOnce(true);

      const retentionHandler = handlers.getHandler("retention");
      const job = makeJob("retention");

      const { JobCancelledError } = await import("../errors");
      await expect(retentionHandler!(job)).rejects.toThrow(JobCancelledError);

      const remaining = client.getDb().select().from(schema.articles).all();
      const identifiers = remaining.map((a) => a.identifier);
      expect(identifiers).not.toContain("a1"); // user A's retention already ran
      expect(identifiers).toContain("b1"); // user B never reached
    });
  });
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npm test -- src/lib/jobs/handlers/handlers.test.ts`
Expected: FAIL — both `a1` and `b1` are deleted (no checkpoint), and no `JobCancelledError` is thrown.

- [ ] **Step 9: Implement the `retention.ts` checkpoint**

In `src/lib/jobs/handlers/retention.ts`, add the two imports:

```ts
import { JobCancelledError } from "../errors";
import { appendLogLine, isCancelRequested } from "../queue";
```

Then change the per-user loop's opening line, inside `handleRetentionJob`, from:

```ts
    for (const settings of settingsList) {
      const retentionDays = settings.articleRetentionDays ?? defaultRetentionDays;
```

to:

```ts
    for (const settings of settingsList) {
      if (isCancelRequested(job.id)) {
        throw new JobCancelledError();
      }

      const retentionDays = settings.articleRetentionDays ?? defaultRetentionDays;
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npm test -- src/lib/jobs/handlers/handlers.test.ts`
Expected: PASS.

- [ ] **Step 11: Full verification and commit**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: all green.

```bash
git add src/lib/jobs/handlers/aggregate.ts src/lib/jobs/handlers/retention.ts src/lib/jobs/handlers/handlers.test.ts
git commit -m "feat(jobs): honor cancellation mid-loop in aggregate and retention handlers"
```

---

## Task 4: i18n — new `jobs` catalog keys

**Files:**
- Modify: `messages/en.json`
- Modify: `messages/de.json`

**Interfaces:**
- Produces (for Tasks 5, 6, 7): the following keys under the `jobs` namespace, consumed via `useTranslations("jobs")` / `getTranslations("jobs")`: `bulkCancel`, `bulkDelete`, `bulkDeleteTitle` (ICU plural, param `count`), `bulkDeleteDescription` (ICU plural, param `count`), `deleteConfirm`, `cancelRequested` (ICU plural, param `count`), `cancelNone`, `deleted` (ICU plural, param `count`), `sessionEnded`, `requestFailed`.
- Consumes: nothing.

- [ ] **Step 1: Add the English keys**

In `messages/en.json`, the `jobs` object currently ends with `"detailTitle": "Job #{id}"`. Change that line to add a trailing comma and append the new keys, so the whole `jobs` object reads:

```json
  "jobs": {
    "title": "Jobs",
    "kind": "Kind",
    "status": "Status",
    "attempts": "Attempts",
    "progress": "Progress",
    "error": "Error",
    "createdAt": "Created At",
    "runAt": "Run At",
    "filterStatus": "Filter Status",
    "filterKind": "Filter Kind",
    "all": "All",
    "noJobs": "No jobs found.",
    "log": "Log",
    "logEmpty": "No log output yet.",
    "logEnded": "Job finished — log ended.",
    "detailTitle": "Job #{id}",
    "bulkCancel": "Cancel",
    "bulkDelete": "Delete",
    "bulkDeleteTitle": "{count, plural, one {Delete this job?} other {Delete these # jobs?}}",
    "bulkDeleteDescription": "{count, plural, one {The job and its log} other {The # jobs and their logs}} will be permanently removed. A still-running job is stopped first.",
    "deleteConfirm": "Delete",
    "cancelRequested": "{count, plural, one {Cancellation requested for # job} other {Cancellation requested for # jobs}}",
    "cancelNone": "Nothing to cancel — those jobs already finished.",
    "deleted": "{count, plural, one {# job deleted} other {# jobs deleted}}",
    "sessionEnded": "Your session ended. Sign in again to continue.",
    "requestFailed": "The server did not answer. Check your connection and try again."
  },
```

- [ ] **Step 2: Add the identical German keys**

In `messages/de.json`, the `jobs` object currently ends with `"detailTitle": "Auftrag #{id}"`. Apply the same change:

```json
  "jobs": {
    "title": "Aufgaben",
    "kind": "Art",
    "status": "Status",
    "attempts": "Versuche",
    "progress": "Fortschritt",
    "error": "Fehler",
    "createdAt": "Erstellt am",
    "runAt": "Ausführen am",
    "filterStatus": "Status filtern",
    "filterKind": "Art filtern",
    "all": "Alle",
    "noJobs": "Keine Aufgaben gefunden.",
    "log": "Protokoll",
    "logEmpty": "Noch keine Protokollausgabe.",
    "logEnded": "Auftrag beendet — Protokoll beendet.",
    "detailTitle": "Auftrag #{id}",
    "bulkCancel": "Abbrechen",
    "bulkDelete": "Löschen",
    "bulkDeleteTitle": "{count, plural, one {Diesen Auftrag löschen?} other {Diese # Aufträge löschen?}}",
    "bulkDeleteDescription": "{count, plural, one {Der Auftrag und sein Protokoll werden} other {Die # Aufträge und ihre Protokolle werden}} dauerhaft entfernt. Ein noch laufender Auftrag wird zuerst gestoppt.",
    "deleteConfirm": "Löschen",
    "cancelRequested": "{count, plural, one {Abbruch für # Auftrag angefordert} other {Abbruch für # Aufträge angefordert}}",
    "cancelNone": "Nichts abzubrechen — diese Aufträge sind bereits beendet.",
    "deleted": "{count, plural, one {# Auftrag gelöscht} other {# Aufträge gelöscht}}",
    "sessionEnded": "Deine Sitzung ist beendet. Melde dich erneut an, um fortzufahren.",
    "requestFailed": "Der Server hat nicht geantwortet. Prüfe deine Verbindung und versuche es erneut."
  },
```

- [ ] **Step 3: Verify catalog parity and the compiler-checked key type**

Run: `npm test -- src/i18n/messages.test.ts && npm run typecheck`
Expected: PASS — both catalogs define the identical key set, and `NamespaceKey<"jobs">` now includes the new keys.

- [ ] **Step 4: Commit**

```bash
git add messages/en.json messages/de.json
git commit -m "feat(jobs): add i18n keys for bulk cancel/delete"
```

---

## Task 5: Server actions — `cancelJobs`, `deleteJobs`, `getJobsStatus`

**Files:**
- Modify: `src/lib/jobs/actions.ts`
- Create: `src/lib/jobs/result.ts`
- Create: `src/lib/jobs/wait-for-jobs-terminal.ts`
- Modify: `src/lib/db/schema/jobs.ts` (doc comment only)
- Test: `src/lib/jobs/actions.test.ts`

**Interfaces:**
- Consumes (from Task 1): `requestCancel(id: number): "cancelled" | "cancelling" | "unchanged"` from `@/lib/jobs/queue`. (from Task 4): the `jobs.sessionEnded`/`jobs.requestFailed`/`jobs.requestFailed` catalog keys, already present.
- Produces (for Tasks 6, 7): `cancelJobs(ids: number[]): Promise<{ ok: true; affected: number }>`, `deleteJobs(ids: number[]): Promise<{ ok: true; deleted: number; stopping: number[] }>`, `getJobsStatus(ids: number[]): Promise<{ id: number; status: string }[]>` from `@/lib/jobs/actions`; `attempt` (the `attemptIn("jobs", ...)` binding, signature `<Result extends ActionResult<"jobs">>(call: () => Promise<Result>) => Promise<Result | ActionFailure<"jobs">>`) from `@/lib/jobs/result`; `waitForJobsTerminal(ids: number[]): Promise<boolean>` from `@/lib/jobs/wait-for-jobs-terminal`.

- [ ] **Step 1: Restructure `actions.test.ts` to share its setup across multiple `describe` blocks**

The file currently has all of its `beforeEach`/`afterEach`/helper functions nested *inside* `describe("getRunStatus", ...)`. Wrap the entire existing file content in one outer `describe`, matching `queue.test.ts`'s shape, so the new `describe("cancelJobs", ...)`/`describe("deleteJobs", ...)`/`describe("getJobsStatus", ...)` blocks added below can reuse the same `beforeEach`/`afterEach`/`seedUser`/`signInAs`/`raw`/`requestAs` without duplicating them.

Change:

```ts
describe("getRunStatus", () => {
  let dbPath: string;
  ...
});
```

to:

```ts
describe("src/lib/jobs/actions", () => {
  let dbPath: string;
  ...
  // (everything that was inside the old describe body stays exactly as it
  // was: the `let` declarations, `raw`/`requestAs`/`seedUser`/`signInAs`,
  // `beforeEach`, `afterEach`)

  describe("getRunStatus", () => {
    it("returns the run's status for its owner", async () => {
      // unchanged
    });
    // ...the other two existing tests, unchanged
  });
});
```

Also add one more helper next to `seedUser`, for the admin-bypass tests below:

```ts
  async function seedAdmin(email: string): Promise<string> {
    const user = await createUserWithPassword({
      email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "admin",
    });
    return user.id;
  }
```

- [ ] **Step 2: Run the full file to confirm the restructuring alone changes nothing**

Run: `npm test -- src/lib/jobs/actions.test.ts`
Expected: PASS (the three pre-existing `getRunStatus` tests, unchanged).

- [ ] **Step 3: Write the failing tests for `cancelJobs`, `deleteJobs`, `getJobsStatus`**

Add these as sibling `describe` blocks to `describe("getRunStatus", ...)`, inside the outer `describe("src/lib/jobs/actions", ...)`:

```ts
  describe("cancelJobs", () => {
    it("cancels a pending job immediately", async () => {
      const userId = await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId });

      const result = await jobsActions.cancelJobs([id]);
      expect(result).toEqual({ ok: true, affected: 1 });
      expect(queue.getJob(id)?.status).toBe("cancelled");
    });

    it("asks a running job to stop", async () => {
      const userId = await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId });
      queue.claim();

      const result = await jobsActions.cancelJobs([id]);
      expect(result).toEqual({ ok: true, affected: 1 });
      expect(queue.getJob(id)?.status).toBe("cancelling");
    });

    it("does not affect another user's job", async () => {
      const ownerId = await seedUser("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId: ownerId });

      await seedUser("other@example.com");
      await signInAs("other@example.com");

      const result = await jobsActions.cancelJobs([id]);
      expect(result).toEqual({ ok: true, affected: 0 });
      expect(queue.getJob(id)?.status).toBe("pending");
    });

    it("lets an admin cancel another user's job", async () => {
      const ownerId = await seedUser("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId: ownerId });

      await seedAdmin("admin@example.com");
      await signInAs("admin@example.com");

      const result = await jobsActions.cancelJobs([id]);
      expect(result).toEqual({ ok: true, affected: 1 });
      expect(queue.getJob(id)?.status).toBe("cancelled");
    });

    it("returns affected: 0 and touches nothing for an empty id list", async () => {
      await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      expect(await jobsActions.cancelJobs([])).toEqual({ ok: true, affected: 0 });
    });
  });

  describe("deleteJobs", () => {
    it("deletes a completed job, and cascades its log lines", async () => {
      const userId = await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId, maxAttempts: 1 });
      queue.claim();
      queue.appendLogLine(id, "stdout", "hello");
      queue.complete(id);

      const result = await jobsActions.deleteJobs([id]);
      expect(result).toEqual({ ok: true, deleted: 1, stopping: [] });
      expect(queue.getJob(id)).toBeNull();
      expect(queue.listJobLogs(id)).toEqual([]);
    });

    it("deletes a pending job outright, without requesting cancellation", async () => {
      const userId = await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId });

      const result = await jobsActions.deleteJobs([id]);
      expect(result).toEqual({ ok: true, deleted: 1, stopping: [] });
      expect(queue.getJob(id)).toBeNull();
    });

    it("requests cancellation on a running job instead of deleting it immediately", async () => {
      const userId = await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId });
      queue.claim();

      const result = await jobsActions.deleteJobs([id]);
      expect(result).toEqual({ ok: true, deleted: 0, stopping: [id] });
      expect(queue.getJob(id)?.status).toBe("cancelling");
    });

    it("does not delete another user's job", async () => {
      const ownerId = await seedUser("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId: ownerId });

      await seedUser("other@example.com");
      await signInAs("other@example.com");

      const result = await jobsActions.deleteJobs([id]);
      expect(result).toEqual({ ok: true, deleted: 0, stopping: [] });
      expect(queue.getJob(id)).not.toBeNull();
    });

    it("returns deleted: 0 and touches nothing for an empty id list", async () => {
      await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      expect(await jobsActions.deleteJobs([])).toEqual({ ok: true, deleted: 0, stopping: [] });
    });
  });

  describe("getJobsStatus", () => {
    it("reports the caller's own jobs' current status", async () => {
      const userId = await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId });

      expect(await jobsActions.getJobsStatus([id])).toEqual([{ id, status: "pending" }]);
    });

    it("omits a job owned by another user", async () => {
      const ownerId = await seedUser("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId: ownerId });

      await seedUser("other@example.com");
      await signInAs("other@example.com");

      expect(await jobsActions.getJobsStatus([id])).toEqual([]);
    });
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test -- src/lib/jobs/actions.test.ts`
Expected: FAIL — `jobsActions.cancelJobs is not a function` (and similarly for the other two).

- [ ] **Step 5: Implement `src/lib/jobs/result.ts`**

```ts
import { attemptIn } from "@/lib/attempt";

/**
 * The `jobs` binding of `attempt()` (see `src/lib/attempt.ts`) -- used by
 * `src/components/jobs/jobs-table.tsx` and `src/components/jobs/job-actions.tsx`
 * for the bulk/single cancel and delete actions.
 */
export const attempt = attemptIn("jobs", {
  sessionEnded: "sessionEnded",
  requestFailed: "requestFailed",
});
```

- [ ] **Step 6: Implement the three actions in `src/lib/jobs/actions.ts`**

Add these imports at the top (alongside the existing ones):

```ts
import { and, eq, inArray } from "drizzle-orm";

import { isAdminRole } from "@/lib/auth/roles";
import { requireUserFreshRole } from "@/lib/auth/session";
import { getDb, writeTransaction } from "@/lib/db/client";
import { jobs, runs } from "@/lib/db/schema";
import { requestCancel } from "@/lib/jobs/queue";
```

(`eq`/`runs` are already imported for `getRunStatus` — do not duplicate the import line, merge into the existing `import { eq } from "drizzle-orm";` and the existing `import { runs } from "@/lib/db/schema";` lines instead.)

Then append, after `getRunStatus`:

```ts
/** `ids` narrowed to the ones `userId` may act on -- every id, unfiltered,
 * for an admin. Re-checked here even though `/jobs` already filters a
 * non-admin's view to their own rows: a server action is reachable directly
 * with an arbitrary id list, and the list page's filter is a display
 * concern, not the authority boundary. */
function ownedJobIds(ids: number[], userId: string, admin: boolean): number[] {
  const ownership = admin ? undefined : eq(jobs.userId, userId);
  return getDb()
    .select({ id: jobs.id })
    .from(jobs)
    .where(ownership ? and(inArray(jobs.id, ids), ownership) : inArray(jobs.id, ids))
    .all()
    .map((row) => row.id);
}

/**
 * Requests cancellation for every owned id in `ids`. A `pending` job is
 * cancelled immediately; a `running` one only starts stopping (see
 * `requestCancel()` in `@/lib/jobs/queue`) -- `affected` counts either kind,
 * and the caller's toast reads accordingly ("cancellation requested", not
 * "cancelled", to stay honest about a still-running job).
 */
export async function cancelJobs(ids: number[]): Promise<{ ok: true; affected: number }> {
  if (ids.length === 0) return { ok: true, affected: 0 };

  const user = await requireUserFreshRole();
  const admin = isAdminRole(user.role);
  const ownedIds = ownedJobIds(ids, user.id, admin);

  let affected = 0;
  for (const id of ownedIds) {
    if (requestCancel(id) !== "unchanged") affected++;
  }

  return { ok: true, affected };
}

/**
 * Deletes every owned id in `ids` that is safe to delete right now
 * (`pending`, `completed`, `failed`, `cancelled` -- cascades to that job's
 * log lines). A `running` or `cancelling` job is not deleted: its row is
 * still being written to by the worker loop, and removing it out from under
 * that write would surface as a foreign-key-constraint throw inside the
 * handler's own `appendLogLine()`/`progress()` calls rather than a clean
 * stop. Such a job is asked to cancel instead (idempotent -- a no-op against
 * one already `cancelling`) and returned in `stopping`, for the caller to
 * poll (`@/lib/jobs/wait-for-jobs-terminal`) and delete again once it has
 * actually stopped.
 */
export async function deleteJobs(
  ids: number[],
): Promise<{ ok: true; deleted: number; stopping: number[] }> {
  if (ids.length === 0) return { ok: true, deleted: 0, stopping: [] };

  const user = await requireUserFreshRole();
  const admin = isAdminRole(user.role);
  const ownedIds = ownedJobIds(ids, user.id, admin);
  if (ownedIds.length === 0) return { ok: true, deleted: 0, stopping: [] };

  return writeTransaction((db) => {
    const rows = db
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(inArray(jobs.id, ownedIds))
      .all();

    const stopping: number[] = [];
    const deletable: number[] = [];
    for (const row of rows) {
      if (row.status === "running" || row.status === "cancelling") {
        stopping.push(row.id);
      } else {
        deletable.push(row.id);
      }
    }

    for (const id of stopping) {
      requestCancel(id);
    }

    const result =
      deletable.length > 0 ? db.delete(jobs).where(inArray(jobs.id, deletable)).run() : null;

    return { ok: true, deleted: result?.changes ?? 0, stopping };
  });
}

/** Ownership-scoped read used only to poll whether a `deleteJobs()` call's
 * `stopping` set has gone terminal (`@/lib/jobs/wait-for-jobs-terminal`). An
 * id the caller doesn't own, or that no longer exists, is simply absent from
 * the result. */
export async function getJobsStatus(ids: number[]): Promise<{ id: number; status: string }[]> {
  if (ids.length === 0) return [];

  const user = await requireUserFreshRole();
  const admin = isAdminRole(user.role);
  const ownedIds = ownedJobIds(ids, user.id, admin);
  if (ownedIds.length === 0) return [];

  return getDb().select({ id: jobs.id, status: jobs.status }).from(jobs).where(inArray(jobs.id, ownedIds)).all();
}
```

- [ ] **Step 7: Implement `src/lib/jobs/wait-for-jobs-terminal.ts`**

```ts
import { attemptCall } from "@/lib/attempt";

import { getJobsStatus } from "./actions";

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Poll a set of jobs until every one of them has reached a terminal status
 * (or no longer exists -- e.g. already deleted by another tab). Unbounded,
 * same as `waitForRun()` (`./wait-for-run.ts`): a job with no cooperative-
 * cancellation checkpoint (`src/lib/jobs/handlers/logo.ts`,
 * `src/lib/jobs/handlers/reload.ts`) only stops once it finishes on its own,
 * and there is no good shorter timeout to guess at. Returns `false` only on
 * a real failure -- the poll request itself never returned; if the caller
 * navigates away, this promise chain is simply abandoned.
 */
export async function waitForJobsTerminal(ids: number[]): Promise<boolean> {
  let remaining = ids;

  while (remaining.length > 0) {
    const attempted = await attemptCall(() => getJobsStatus(remaining), {
      label: "Polling jobs' status rejected instead of resolving",
    });
    if (attempted.status !== "returned") return false;

    const stillRunning = new Set(
      attempted.result.filter((row) => !TERMINAL_STATUSES.has(row.status)).map((row) => row.id),
    );
    remaining = remaining.filter((id) => stillRunning.has(id));

    if (remaining.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return true;
}
```

(No dedicated unit test for this file, matching the existing convention: its sibling `src/lib/jobs/wait-for-run.ts` — the pattern this mirrors — has no `.test.ts` of its own either. It is exercised end-to-end by the component tests in Tasks 6 and 7.)

- [ ] **Step 8: Update the now-inaccurate doc comment on `jobLogs`**

In `src/lib/db/schema/jobs.ts`, the `jobLogs` table's doc comment currently says:

```
 * Cascades with its job: nothing deletes `jobs` rows today (confirmed --
 * `retention` only touches `articles`/`article_tombstones`), so in practice this
 * persists exactly as long as the job row it describes. A future job-cleanup
 * feature gets its log cleaned up for free.
```

Change it to:

```
 * Cascades with its job (`onDelete: "cascade"` below): `deleteJobs()`
 * (`src/lib/jobs/actions.ts`) is what deletes `jobs` rows -- a job's log
 * lines are removed in the same statement, never separately.
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test -- src/lib/jobs/actions.test.ts`
Expected: PASS.

- [ ] **Step 10: Full verification and commit**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: all green.

```bash
git add src/lib/jobs/actions.ts src/lib/jobs/actions.test.ts src/lib/jobs/result.ts src/lib/jobs/wait-for-jobs-terminal.ts src/lib/db/schema/jobs.ts
git commit -m "feat(jobs): add cancelJobs/deleteJobs/getJobsStatus server actions"
```

---

## Task 6: `jobs-table.tsx` bulk action wiring

**Files:**
- Modify: `src/components/jobs/jobs-table.tsx`
- Test: `src/components/jobs/jobs-table.test.tsx`

**Interfaces:**
- Consumes (from Task 5): `cancelJobs`, `deleteJobs` from `@/lib/jobs/actions`; `attempt` from `@/lib/jobs/result`; `waitForJobsTerminal` from `@/lib/jobs/wait-for-jobs-terminal`. (from Task 4): `jobs.bulkCancel`, `jobs.bulkDelete`, `jobs.bulkDeleteTitle`, `jobs.bulkDeleteDescription`, `jobs.deleteConfirm`, `jobs.cancelRequested`, `jobs.cancelNone`, `jobs.deleted`.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/jobs/jobs-table.test.tsx` (keep the existing `job()` builder and the one existing test; add the mocks above the `describe` block and the new tests inside it):

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname, setRouter, setSearchParams } from "@/test/next-navigation";
import type { Job } from "@/lib/db/schema";

import { JobsTable } from "./jobs-table";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { cancelJobs, deleteJobs, getJobsStatus } = vi.hoisted(() => ({
  cancelJobs: vi.fn(),
  deleteJobs: vi.fn(),
  getJobsStatus: vi.fn(),
}));
vi.mock("@/lib/jobs/actions", () => ({ cancelJobs, deleteJobs, getJobsStatus }));

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
setRouter({ refresh });

const { toastError, toastInfo, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: toastError, info: toastInfo, success: toastSuccess },
}));

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    runId: null,
    userId: null,
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

function selectFirstRow() {
  fireEvent.click(screen.getAllByRole("checkbox", { name: "Select this row" })[0]!);
}

function dialog(): HTMLElement {
  const popup = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  if (!popup) throw new Error("no confirmation dialog is open");
  return popup;
}

beforeEach(() => {
  vi.clearAllMocks();
  setPathname("/jobs");
  setSearchParams("");
  cancelJobs.mockResolvedValue({ ok: true, affected: 1 });
  deleteJobs.mockResolvedValue({ ok: true, deleted: 1, stopping: [] });
});

describe("JobsTable", () => {
  it("links each row's kind to its detail page", () => {
    renderWithProviders(
      <JobsTable rows={[job({ id: 42, kind: "aggregate" })]} page={1} pageSize={50} total={1} />,
    );

    expect(screen.getByRole("link", { name: "aggregate" }).getAttribute("href")).toBe("/jobs/42");
  });

  it("cancels the selection and reports how many were affected", async () => {
    renderWithProviders(
      <JobsTable rows={[job({ id: 7, status: "pending" })]} page={1} pageSize={50} total={1} />,
    );
    selectFirstRow();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(cancelJobs).toHaveBeenCalledWith([7]));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Cancellation requested for 1 job"),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("reports nothing to cancel when none of the selection was affected", async () => {
    cancelJobs.mockResolvedValue({ ok: true, affected: 0 });
    renderWithProviders(
      <JobsTable rows={[job({ id: 7, status: "completed" })]} page={1} pageSize={50} total={1} />,
    );
    selectFirstRow();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith("Nothing to cancel — those jobs already finished."),
    );
  });

  it("deletes the selection immediately when nothing needs to stop first", async () => {
    renderWithProviders(
      <JobsTable rows={[job({ id: 9, status: "completed" })]} page={1} pageSize={50} total={1} />,
    );
    selectFirstRow();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteJobs).toHaveBeenCalledWith([9]));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("1 job deleted"));
    expect(getJobsStatus).not.toHaveBeenCalled();
  });

  it("waits for a running job to stop before it is actually deleted", async () => {
    deleteJobs
      .mockResolvedValueOnce({ ok: true, deleted: 0, stopping: [9] })
      .mockResolvedValueOnce({ ok: true, deleted: 1, stopping: [] });
    getJobsStatus.mockResolvedValue([{ id: 9, status: "cancelled" }]);

    renderWithProviders(
      <JobsTable rows={[job({ id: 9, status: "running" })]} page={1} pageSize={50} total={1} />,
    );
    selectFirstRow();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(getJobsStatus).toHaveBeenCalledWith([9]));
    await waitFor(() => expect(deleteJobs).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("1 job deleted"));
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npm test -- src/components/jobs/jobs-table.test.tsx`
Expected: FAIL — no "Cancel"/"Delete" buttons are rendered yet (no `<BulkActionBar>`).

- [ ] **Step 3: Implement**

Replace the full contents of `src/components/jobs/jobs-table.tsx` with:

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { BulkActionBar, type BulkAction } from "@/components/crud/bulk-action-bar";
import { DataTable, type Column } from "@/components/crud/data-table";
import { Pagination } from "@/components/crud/pagination";
import { Badge } from "@/components/ui/badge";
import { cancelJobs, deleteJobs } from "@/lib/jobs/actions";
import { attempt } from "@/lib/jobs/result";
import { waitForJobsTerminal } from "@/lib/jobs/wait-for-jobs-terminal";
import type { Job } from "@/lib/db/schema";

export function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return (
        <Badge
          variant="outline"
          className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-200"
        >
          {status}
        </Badge>
      );
    case "running":
      return (
        <Badge
          variant="outline"
          className="bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 border-blue-200"
        >
          {status}
        </Badge>
      );
    case "cancelling":
      return (
        <Badge
          variant="outline"
          className="bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 border-amber-200"
        >
          {status}
        </Badge>
      );
    case "cancelled":
      return (
        <Badge
          variant="outline"
          className="bg-slate-50 text-slate-600 dark:bg-slate-900 dark:text-slate-400 border-slate-200"
        >
          {status}
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">{status}</Badge>;
    case "pending":
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

export function JobsTable({
  rows,
  page,
  pageSize,
  total,
}: {
  rows: Job[];
  page: number;
  pageSize: number;
  total: number;
}) {
  const t = useTranslations("jobs");
  const router = useRouter();
  const [selected, setSelected] = useState<number[]>([]);

  const columns: Column<Job>[] = [
    {
      key: "kind",
      header: t("kind"),
      cell: (job) => (
        <Link href={`/jobs/${job.id}`} className="font-mono text-sm hover:underline">
          {job.kind}
        </Link>
      ),
    },
    {
      key: "status",
      header: t("status"),
      cell: (job) => <StatusBadge status={job.status} />,
    },
    {
      key: "attempts",
      header: t("attempts"),
      cell: (job) => (
        <span>
          {job.attempts} / {job.maxAttempts}
        </span>
      ),
    },
    {
      key: "progress",
      header: t("progress"),
      cell: (job) => <span>{job.progress}%</span>,
    },
    {
      key: "error",
      header: t("error"),
      cell: (job) => (
        <span className="text-xs text-destructive truncate max-w-xs block" title={job.error}>
          {job.error || "—"}
        </span>
      ),
    },
    {
      key: "createdAt",
      header: t("createdAt"),
      cell: (job) => (
        <span className="text-xs text-muted-foreground">
          {new Date(job.createdAt).toLocaleString()}
        </span>
      ),
    },
  ];

  async function cancelSelected(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => cancelJobs(selected));
    if (!result.ok) {
      toast.error(t(result.errorKey));
      return false;
    }

    setSelected([]);
    router.refresh();
    if (result.affected === 0) toast.info(t("cancelNone"));
    else toast.success(t("cancelRequested", { count: result.affected }));
    return true;
  }

  async function removeSelected(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => deleteJobs(selected));
    if (!result.ok) {
      toast.error(t(result.errorKey));
      return false;
    }

    let deleted = result.deleted;
    if (result.stopping.length > 0) {
      const stopped = await waitForJobsTerminal(result.stopping);
      if (!stopped) {
        toast.error(t("requestFailed"));
        return false;
      }
      const second = await attempt(() => deleteJobs(result.stopping));
      if (!second.ok) {
        toast.error(t(second.errorKey));
        return false;
      }
      deleted += second.deleted;
    }

    setSelected([]);
    router.refresh();
    toast.success(t("deleted", { count: deleted }));
    return true;
  }

  const count = selected.length;
  const actions: BulkAction[] = [
    {
      key: "cancel",
      label: t("bulkCancel"),
      destructive: false,
      run: cancelSelected,
    },
    {
      key: "delete",
      label: t("bulkDelete"),
      destructive: true,
      confirm: {
        title: t("bulkDeleteTitle", { count }),
        description: t("bulkDeleteDescription", { count }),
        confirmLabel: t("deleteConfirm"),
      },
      run: removeSelected,
    },
  ];

  return (
    <div className="space-y-4">
      <BulkActionBar count={count} actions={actions} onClear={() => setSelected([])} />
      <DataTable
        rows={rows}
        columns={columns}
        rowId={(job) => String(job.id)}
        selected={selected.map(String)}
        onSelectedChange={(ids) => setSelected(ids.map(Number))}
      />
      <Pagination page={page} pageSize={pageSize} total={total} />
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/components/jobs/jobs-table.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full verification and commit**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: all green.

```bash
git add src/components/jobs/jobs-table.tsx src/components/jobs/jobs-table.test.tsx
git commit -m "feat(jobs): wire bulk cancel/delete into the jobs list"
```

---

## Task 7: `JobActions` on the job detail page

**Files:**
- Create: `src/components/jobs/job-actions.tsx`
- Create: `src/components/jobs/job-actions.test.tsx`
- Modify: `src/app/(app)/jobs/[id]/page.tsx`

**Interfaces:**
- Consumes (from Task 5): `cancelJobs`, `deleteJobs` from `@/lib/jobs/actions`; `attempt` from `@/lib/jobs/result`; `waitForJobsTerminal` from `@/lib/jobs/wait-for-jobs-terminal`. (from Task 4): the same `jobs.*` keys Task 6 used.
- Produces: `JobActions({ job: { id: number; status: string } })` component from `@/components/jobs/job-actions`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/jobs/job-actions.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setRouter } from "@/test/next-navigation";

import { JobActions } from "./job-actions";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { cancelJobs, deleteJobs, getJobsStatus } = vi.hoisted(() => ({
  cancelJobs: vi.fn(),
  deleteJobs: vi.fn(),
  getJobsStatus: vi.fn(),
}));
vi.mock("@/lib/jobs/actions", () => ({ cancelJobs, deleteJobs, getJobsStatus }));

const { refresh, push } = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
setRouter({ refresh, push });

const { toastError, toastInfo, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: toastError, info: toastInfo, success: toastSuccess },
}));

function dialog(): HTMLElement {
  const popup = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  if (!popup) throw new Error("no confirmation dialog is open");
  return popup;
}

beforeEach(() => {
  vi.clearAllMocks();
  cancelJobs.mockResolvedValue({ ok: true, affected: 1 });
  deleteJobs.mockResolvedValue({ ok: true, deleted: 1, stopping: [] });
});

describe("<JobActions>", () => {
  it("shows Cancel for a still-active job", () => {
    renderWithProviders(<JobActions job={{ id: 1, status: "running" }} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("hides Cancel once the job is terminal", () => {
    renderWithProviders(<JobActions job={{ id: 1, status: "completed" }} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBe(null);
  });

  it("cancels the job and refreshes", async () => {
    renderWithProviders(<JobActions job={{ id: 5, status: "pending" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(cancelJobs).toHaveBeenCalledWith([5]));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Cancellation requested for 1 job"),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("deletes the job and navigates back to the list", async () => {
    renderWithProviders(<JobActions job={{ id: 5, status: "completed" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteJobs).toHaveBeenCalledWith([5]));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("1 job deleted"));
    expect(push).toHaveBeenCalledWith("/jobs");
  });

  it("waits for a running job to stop before deleting and navigating away", async () => {
    deleteJobs
      .mockResolvedValueOnce({ ok: true, deleted: 0, stopping: [5] })
      .mockResolvedValueOnce({ ok: true, deleted: 1, stopping: [] });
    getJobsStatus.mockResolvedValue([{ id: 5, status: "cancelled" }]);

    renderWithProviders(<JobActions job={{ id: 5, status: "running" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(getJobsStatus).toHaveBeenCalledWith([5]));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/jobs"));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/components/jobs/job-actions.test.tsx`
Expected: FAIL — `Cannot find module './job-actions'`.

- [ ] **Step 3: Implement `src/components/jobs/job-actions.tsx`**

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { ConfirmDestructive } from "@/components/crud/confirm-destructive";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cancelJobs, deleteJobs } from "@/lib/jobs/actions";
import { attempt } from "@/lib/jobs/result";
import { waitForJobsTerminal } from "@/lib/jobs/wait-for-jobs-terminal";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** The Cancel/Delete controls for one job's detail page. Takes only the two
 * columns it renders, never the whole `Job` row -- see the CLAUDE.md rule on
 * component props. */
export function JobActions({ job }: { job: { id: number; status: string } }) {
  const t = useTranslations("jobs");
  const router = useRouter();
  const [cancelling, startCancel] = useTransition();

  function cancelThisJob(): void {
    startCancel(async () => {
      const result = await attempt(() => cancelJobs([job.id]));
      if (!result.ok) {
        toast.error(t(result.errorKey));
        return;
      }

      router.refresh();
      if (result.affected === 0) toast.info(t("cancelNone"));
      else toast.success(t("cancelRequested", { count: result.affected }));
    });
  }

  async function deleteThisJob(): Promise<boolean> {
    const result = await attempt(() => deleteJobs([job.id]));
    if (!result.ok) {
      toast.error(t(result.errorKey));
      return false;
    }

    let deleted = result.deleted;
    if (result.stopping.length > 0) {
      const stopped = await waitForJobsTerminal(result.stopping);
      if (!stopped) {
        toast.error(t("requestFailed"));
        return false;
      }
      const second = await attempt(() => deleteJobs(result.stopping));
      if (!second.ok) {
        toast.error(t(second.errorKey));
        return false;
      }
      deleted += second.deleted;
    }

    toast.success(t("deleted", { count: deleted }));
    router.push("/jobs");
    return true;
  }

  return (
    <div className="flex gap-2">
      {!TERMINAL_STATUSES.has(job.status) && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={cancelThisJob}
          disabled={cancelling}
        >
          {cancelling && <Spinner className="mr-1" />}
          {t("bulkCancel")}
        </Button>
      )}
      <ConfirmDestructive
        trigger={
          <Button type="button" variant="destructive" size="sm">
            {t("bulkDelete")}
          </Button>
        }
        title={t("bulkDeleteTitle", { count: 1 })}
        description={t("bulkDeleteDescription", { count: 1 })}
        confirmLabel={t("deleteConfirm")}
        onConfirm={deleteThisJob}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/components/jobs/job-actions.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire `<JobActions>` into the detail page**

In `src/app/(app)/jobs/[id]/page.tsx`, add the import:

```tsx
import { JobActions } from "@/components/jobs/job-actions";
```

Then change:

```tsx
      <h1 className="text-2xl font-semibold">{t("detailTitle", { id: job.id })}</h1>
```

to:

```tsx
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("detailTitle", { id: job.id })}</h1>
        <JobActions job={{ id: job.id, status: job.status }} />
      </div>
```

- [ ] **Step 6: Full verification**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 7: Manual verification in a browser**

Run: `npm run dev`, sign in, go to `/jobs`. Select a pending job's row, confirm the bulk bar shows "Cancel" and "Delete"; click Cancel and confirm the row's status flips (after refresh) to `cancelled`, with a toast. Select a completed job and Delete it (confirm the dialog); confirm the row disappears and its `/jobs/[id]` page 404s if visited directly afterward. Open a job's detail page and confirm the same two buttons appear next to the title, with Cancel absent once the job is terminal.

- [ ] **Step 8: Commit**

```bash
git add src/components/jobs/job-actions.tsx src/components/jobs/job-actions.test.tsx "src/app/(app)/jobs/[id]/page.tsx"
git commit -m "feat(jobs): add cancel/delete actions to the job detail page"
```
