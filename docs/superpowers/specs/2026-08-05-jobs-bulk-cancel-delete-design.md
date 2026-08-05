# Jobs bulk cancel & delete — design

## Problem

`/jobs` ("Aufgaben") is read-only today. `jobs-table.tsx` already wires row
selection into `<DataTable>` but renders no `<BulkActionBar>`, so ticking
checkboxes has no visible effect. `/jobs/[id]` has no buttons at all. There is
no `cancelJob`/`deleteJob` anywhere in the codebase, and the `jobs.status`
column has no `"cancelled"` value.

This adds bulk Cancel and bulk Delete to the jobs list, and the same two
actions (single-job) to the job detail page.

Two decisions made up front (see chat): a **"running"** job must be really
interruptible, not just marked cancelled while it keeps executing; and
**Delete always succeeds** — deleting a running job cancels it, waits for it
to actually stop, then deletes the row.

## Non-goals

- No status filter dropdown on `/jobs` (the list page already omits one even
  though `listJobs()` supports it — out of scope here).
- No cancellation support for `feed.logo`/`article.reload` mid-execution —
  see "Handlers with no checkpoint" below.
- No change to the `/api/v1` mobile surface or its SSE event shapes beyond
  widening `status: string` fields to also carry `"cancelled"`/`"cancelling"`
  (already untyped strings on the wire, so no consumer contract changes).

## 1. Job status model

`jobs.status` (`src/lib/db/schema/jobs.ts`) is `text(...).notNull().default("pending")`
with no CHECK constraint — the four values in use today (`pending`, `running`,
`completed`, `failed`) are an app-level convention, not a DB-enforced enum. No
migration is needed to add two more:

- **`cancelled`** — terminal. Reached either instantly (a `pending` job that
  never started) or after a running job's handler notices a cancellation
  request at its next checkpoint.
- **`cancelling`** — non-terminal, running-job-specific. A cancellation has
  been requested but the handler hasn't noticed yet (or the handler has no
  checkpoint to notice at, and will run to natural completion instead).

Full lifecycle:

```
pending ──────────────► cancelled          (requestCancel while still pending)
pending → running ────► completed | failed  (today's paths, unchanged)
pending → running → cancelling → cancelled  (requestCancel while running,
                                              handler honors it at a checkpoint)
pending → running → cancelling → completed | failed
                                              (handler has no checkpoint, or
                                               finishes before its next one —
                                               the cancel request is simply
                                               too late; not an error)
```

## 2. Cooperative cancellation

`worker.ts` runs a single in-process loop, one job at a time, with no existing
abort mechanism (`withTimeout()` only stops *waiting* on a handler's promise,
it doesn't kill it). There is no `AbortSignal` threaded into `JobHandler`
(`(job: Job) => Promise<void>`), and adding one would touch every handler and
`index.ts` for no benefit — the handlers that actually loop over many items
already round-trip to the database once per item (`progress()`), so a second
cheap read at the same point is the lowest-friction mechanism, not a new one.

### `src/lib/jobs/queue.ts` additions

```ts
export type CancelOutcome = "cancelled" | "cancelling" | "unchanged";

export function requestCancel(id: number): CancelOutcome {
  return writeTransaction((db) => {
    const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) return "unchanged";

    if (job.status === "pending") {
      db.update(jobs)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(eq(jobs.id, id))
        .run();
      if (job.runId !== null) bumpRunCounters(db, job.runId, "failed");
      return "cancelled";
    }

    if (job.status === "running") {
      const result = db
        .update(jobs)
        .set({ status: "cancelling" })
        .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
        .run();
      return result.changes === 1 ? "cancelling" : "unchanged";
    }

    return "unchanged"; // already cancelling, or already terminal
  });
}

export function isCancelRequested(id: number): boolean {
  const row = getDb().select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id)).get();
  return row?.status === "cancelling";
}

/** The terminal transition a handler's cancellation lands on. Mirrors
 * `complete()`/`fail()`: sets `finishedAt`, bumps the parent run's counters
 * (into the same bucket `fail()` uses — a cancelled job is not a success for
 * a run's bookkeeping, and `waitForRun()`'s poll only recognizes a run as
 * terminal once `completedJobs + failedJobs >= totalJobs`), and publishes a
 * terminal event so any open SSE viewer (web log tail, mobile events) closes
 * out instead of hanging. */
export function cancelled(id: number): void {
  const job = writeTransaction((db) => {
    const current = db.select().from(jobs).where(eq(jobs.id, id)).get();
    db.update(jobs)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(jobs.id, id))
      .run();
    if (current && current.runId !== null) bumpRunCounters(db, current.runId, "failed");
    return current;
  });

  if (job) {
    publishJobOutcome({ ...job, status: "cancelled" }, "cancelled");
    publishJobTerminal(id, "cancelled");
  }
}
```

`publishJobOutcome`'s `status` parameter and `log-bus.ts`'s
`publishJobTerminal`/`subscribeJobTerminal` types widen from
`"completed" | "failed"` to `"completed" | "failed" | "cancelled"`. The `/api/v1`
event payload (`src/lib/api/events.ts`) already types `status` as a bare
`string`, so no change needed there.

### `src/lib/jobs/errors.ts` (new)

```ts
/** Thrown by a handler that notices `isCancelRequested()` at one of its
 * checkpoints. `worker.ts` catches this specifically and calls `cancelled()`
 * instead of `fail()` — no retry, no stderr spam from a stack trace that
 * isn't a bug. */
export class JobCancelledError extends Error {
  constructor() {
    super("job cancelled");
    this.name = "JobCancelledError";
  }
}
```

### `worker.ts` catch block

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

### Checkpoints in handlers

- **`aggregate.ts`** (covers `aggregate`, `feed.update`, `feed.restore` — 3 of
  6 kinds via delegation): inside the per-article `for` loop, right after the
  existing `progress(job.id, ...)` call — `if (isCancelRequested(job.id)) throw new JobCancelledError();`.
- **`retention.ts`**: inside the per-user `for` loop, same pattern.
- **Handlers with no checkpoint** (`logo.ts`, `reload.ts`): a handful of
  sequential awaited calls with no natural mid-execution point. A `cancelling`
  request against one of these has no effect until the handler finishes on its
  own and hits `complete()`/`fail()` normally — documented as a known
  limitation in both files, not worked around. Any handler that later grows a
  loop should add the same checkpoint.

### Boot recovery — `resetOrphaned()`

Today it only resets orphaned `running` rows back to `pending`. If the process
dies while a job is `cancelling`, resuming it as a fresh `pending` attempt on
the next boot would silently ignore that a human asked it to stop. Extend it:

```ts
export function resetOrphaned(before: Date): number {
  const orphanedCancelling = getDb()
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "cancelling"), lte(jobs.startedAt, before)))
    .all();
  for (const { id } of orphanedCancelling) cancelled(id);

  return writeTransaction((db) => {
    const result = db
      .update(jobs)
      .set({ status: "pending", startedAt: null })
      .where(and(eq(jobs.status, "running"), lte(jobs.startedAt, before)))
      .run();
    return result.changes;
  });
}
```

## 3. Server actions

New file content in `src/lib/jobs/actions.ts` (alongside the existing
`getRunStatus`), plus a new `src/lib/jobs/result.ts` binding the same way
`src/lib/feeds/result.ts` does:

```ts
export const attempt = attemptIn("jobs", { sessionEnded: "sessionEnded", requestFailed: "requestFailed" });
```

- **`cancelJobs(ids: number[]): Promise<{ ok: true; affected: number }>`** —
  ownership-scoped (`jobs.userId = currentUserId()`, or unrestricted for an
  admin — mirrors `requireUserFreshRole()`'s split already used by the pages;
  the action itself checks `isAdminRole()` off `requireUserFreshRole()`, the
  same fresh-role read the pages use, since this is an authority decision).
  Calls `requestCancel(id)` for each id the caller may act on; `affected` is
  how many returned something other than `"unchanged"`.
- **`deleteJobs(ids: number[]): Promise<{ ok: true; deleted: number; stopping: number[] }>`** —
  same ownership scoping. For each id: if current status is `running` or
  `cancelling`, calls `requestCancel(id)` (idempotent) and adds it to
  `stopping` rather than deleting it; every other status (`pending`,
  `completed`, `failed`, `cancelled`) is deleted immediately (cascades to
  `job_logs`). Runs inside one `writeTransaction`.
- **`getJobsStatus(ids: number[]): Promise<{ id: number; status: string }[]>`** —
  ownership-scoped read, used only to poll the `stopping` set from
  `deleteJobs` until it's empty. Ids the caller doesn't own, or that no longer
  exist, are simply absent from the result (treated as "already gone" by the
  poll below — see error handling).

## 4. Client-side delete-with-wait flow

New `src/lib/jobs/wait-for-jobs-terminal.ts`, same shape as `wait-for-run.ts`:

```ts
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export async function waitForJobsTerminal(ids: number[]): Promise<boolean> {
  let remaining = new Set(ids);
  for (;;) {
    const attempted = await attemptCall(() => getJobsStatus([...remaining]), { label: "..." });
    if (attempted.status !== "returned") return false;

    for (const row of attempted.result) {
      if (TERMINAL.has(row.status)) remaining.delete(row.id);
    }
    // an id absent from the result is already gone (deleted) — also done.
    remaining = new Set([...remaining].filter((id) => attempted.result.some((r) => r.id === id)));

    if (remaining.size === 0) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
```

Table/detail-page delete handler:

```ts
async function removeSelected(): Promise<boolean> {
  const result = await attempt(() => deleteJobs(selected));
  if (!result.ok) { toast.error(t("requestFailed")); return false; }

  let deleted = result.deleted;
  if (result.stopping.length > 0) {
    await waitForJobsTerminal(result.stopping);
    const second = await attempt(() => deleteJobs(result.stopping));
    if (second.ok) deleted += second.deleted;
  }

  toast.success(t("bulkDeleted", { count: deleted }));
  setSelected([]);
  router.refresh();
  return true;
}
```

This mirrors `feeds-table.tsx`'s "clear selection only after the outcome is
known" rule and `waitForRun()`'s "poll is unbounded on purpose" philosophy —
a job with no checkpoint (see above) could in the worst case take as long as
its own work does to finish naturally; there's no good shorter timeout to
pick, and giving up would either leave the row undeleted with no explanation
or force a second manual click.

## 5. UI

- **`jobs-table.tsx`**: import `BulkActionBar`; two `BulkAction`s exactly like
  `feeds-table.tsx`'s pattern — `"cancel"` (non-destructive,
  `attempt(() => cancelJobs(selected))`, toast + `router.refresh()`) and
  `"delete"` (destructive, `<ConfirmDestructive>`, the flow above).
- **`StatusBadge`** (`jobs-table.tsx`): add `cancelling` (same blue-ish
  "in progress" family as `running`, maybe amber to distinguish) and
  `cancelled` (a muted/secondary badge, distinct from `failed`'s red).
- **`jobs/[id]/page.tsx`**: stays a server component; renders a new client
  component `<JobActions job={{ id, status }} />` (new file
  `src/components/jobs/job-actions.tsx`) next to the existing header. Cancel
  button hidden once `status` is terminal; Delete always shown. Cancel calls
  `cancelJobs([job.id])` then `router.refresh()`. Delete runs the same
  wait-loop as the bulk case, then `router.push("/jobs")` once actually
  deleted (the detail page for a deleted job would otherwise 404 on refresh).

## 6. i18n (`messages/en.json` / `messages/de.json`, `jobs` namespace)

New keys, following the `feeds` namespace's existing shapes: `bulkCancel`,
`bulkDelete`, `bulkDeleteTitle` (ICU plural), `bulkDeleteDescription`,
`deleteConfirm`, `cancelled` (result toast, ICU plural), `cancelNone` (0
affected), `deleted` (result toast, ICU plural), `sessionEnded`,
`requestFailed`, plus `cancel`/`delete` labels for the detail-page buttons and
`cancelling`/`cancelled` status labels for `StatusBadge`. Both catalogs must
define the identical key set (enforced by `src/i18n/messages.test.ts`).

## 7. Testing

- **`queue.test.ts`**: `requestCancel()`'s three branches (pending→cancelled,
  running→cancelling, already-terminal→unchanged, including the run-counter
  bump); `cancelled()`'s terminal transition + run-counter bump + terminal
  event; `resetOrphaned()`'s new orphaned-`cancelling`→`cancelled` branch
  alongside its existing running→pending one.
- **`worker.test.ts`**: a handler throwing `JobCancelledError` results in
  `status: "cancelled"`, not a retry, and does not increment `attempts`
  toward `maxAttempts`'s retry path.
- **`handlers.test.ts`**: `aggregate.ts` and `retention.ts` stop partway
  through their loop when `isCancelRequested()` is true (mock `queue.ts`'s
  export), leaving partial work committed (already-processed items stay
  written — cancellation is not a rollback).
- **`actions.test.ts`** (new, `src/lib/jobs/`): ownership scoping for all
  three new actions (a non-admin cannot affect another user's job; an admin
  can); `deleteJobs`'s split between immediate deletion and
  `requestCancel`-then-`stopping`.
- **jsdom**: `jobs-table.test.tsx` for the bulk bar wiring (mirrors an
  existing `feeds-table.test.tsx` if one exists, else the direct pattern from
  `feeds-table.tsx`); `job-actions.test.tsx` for the detail-page buttons
  (Cancel hidden once terminal, Delete present always).

## Open questions resolved during brainstorming

- **Cancel semantics**: real cooperative interruption via checkpoints, not a
  status-only flip that ignores the still-running handler.
- **Delete scope**: unrestricted — a running job is cancelled, waited on, then
  deleted, rather than requiring a separate manual cancel-then-delete step.
