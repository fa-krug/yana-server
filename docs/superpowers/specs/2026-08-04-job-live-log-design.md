# Background Job Live Log

**Date:** 2026-08-04
**Status:** Implemented

## Goal

Let a user open a background job from `/jobs` and see what it's actually doing: its raw captured
output (console output and, on failure, the full error stack) both as persisted history and as a
live tail while the job is still running.

## Why

`jobs` (`src/lib/db/schema/jobs.ts`) has no log of any kind. `error` holds only the last error
*message* (overwritten on every retry attempt), and the jobs list (`src/app/(app)/jobs/page.tsx`,
`src/components/jobs/jobs-table.tsx`) shows that one truncated line with a tooltip and nothing else
— there is no detail view. Diagnosing a failed `aggregate` or `feed.restore` job today means reading
server-side console output directly, which isn't available to anyone without shell access to the
container.

## Approach

**Persisted per-job log table, `AsyncLocalStorage`-scoped console capture in the worker, and SSE
push to a new job detail page** — reusing the SSE convention phase 13 already established for
`/api/v1/jobs/events`, but as a separate, session-authenticated endpoint for the web UI.

Rejected alternative: append to a single growing `jobs.log` TEXT column, viewed via client-side
polling. Simpler (no new table, no pub/sub, no SSE route), but a TEXT column is rewritten in full on
every append — real cost given log size is deliberately uncapped (see below) — and polling is a
worse fit for "live" than push when the codebase already has one SSE pattern to extend consistently
rather than introduce a second, different live-update mechanism.

Also rejected: keeping captured output in memory only (no table), published solely over a bus.
Cheaper, but a log that vanishes on process restart, or that never existed for a job that finished
before the viewer opened the page, does not satisfy "open them and see" for a job that already ran.

## Capture: why `AsyncLocalStorage`, not a monkey-patch around the `await`

The worker (`src/lib/jobs/worker.ts`) runs jobs strictly one-at-a-time in its own loop, but the
process also serves HTTP requests concurrently — this is one Node process for both (per this
repo's "one process" design). Patching `console.log` globally only for the duration of
`await handler(job)` would still be live during that `await`'s microtask gaps, and any unrelated
concurrent request logging in that window would incorrectly get attributed to the job's log.

Instead, a single module-level `AsyncLocalStorage<{ jobId: number }>` is established once
(`src/lib/jobs/log-capture.ts`), and `console.log`/`info`/`warn`/`error` are patched once at import to
**tee**: always call through to the original console method first — so an operator tailing container
logs loses nothing, whether or not a job happens to be running — then check the current store and,
when set, additionally persist the line into that job's log. That persist-and-publish step runs with
the `AsyncLocalStorage` store exited (`als.exit()`), so anything it triggers — including a future log
bus subscriber that happens to log something itself — falls through to the plain tee path instead of
recursing back into capture. The worker wraps each handler invocation:

```ts
await runWithLogCapture(job.id, () => withTimeout(handler(job), timeoutMs));
```

`AsyncLocalStorage` propagates correctly through that handler's own async call graph regardless of
what else is happening concurrently elsewhere in the process, which a time-boxed global patch cannot
guarantee.

Lifecycle markers are appended automatically, so the log reads coherently even though none of the six
existing handlers (`aggregate`, `feed.logo`, `feed.update`, `feed.restore`, `article.reload`,
`retention`) call `console.*` today:

- claim → `"job started (attempt N/M)"` (stdout)
- success → `"job completed"` (stdout)
- failure → the error's full `message` **and stack trace**, one line per row (stderr) — strictly more
  than today's single-line `jobs.error`, which is left as-is for the table view's tooltip

A log-write failure (e.g. the database is busy) is caught and `console.error`'d to the real stderr,
never allowed to fail the job it's trying to describe — logging is best-effort, same philosophy
`queue.ts`'s `publishJobOutcome()` already documents for event publishing.

## No cap on log size

A single misbehaving handler could in principle log unboundedly, but no cap is applied — the six
existing handlers are bounded (a handful of lines per feed/article), and adding a cap now would mean
designing truncation semantics (keep first N? last N? both ends?) for a problem that doesn't exist
yet. Revisit if a real handler turns out to be chatty.

## Schema

New table, `src/lib/db/schema/jobs.ts`:

```ts
export const jobLogs = sqliteTable(
  "job_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    stream: text("stream").notNull(), // "stdout" | "stderr"
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
```

`id` (globally auto-incrementing) doubles as the per-job ordering/cursor key — `WHERE jobId = ? AND
id > ?` is a cheap indexed range scan, so no separate per-job sequence column is needed. The FK
cascade means a job's log disappears if its row is ever deleted; today nothing deletes `jobs` rows
(confirmed — `retention` only touches `articles`/`articleTombstones`), so in practice logs persist
indefinitely, same as the job rows they describe. If a future job-cleanup feature is added, the log
cleans up with it for free.

## Live delivery

Two small in-process, **jobId-keyed** pub/sub channels in `src/lib/jobs/log-bus.ts` — deliberately not
the existing per-user bus in `src/lib/api/events.ts`, since jobs aren't uniformly user-owned
(`retention`, `feed.logo`, etc. have no resolvable owner) and `/jobs` today is visible to any
signed-in user, not just a job's owner (`listJobs()`/`getJob()` apply no ownership filter, and the
page's only gate is `requireUser()`). One channel carries log lines
(`publishJobLog`/`subscribeJobLog`, as originally designed); a second, distinctly-namespaced channel
carries a job's terminal transition (`publishJobTerminal`/`subscribeJobTerminal`), so the route below
can close a still-open stream the moment the job it's tailing finishes, not only when the job was
already finished at connect time. Both are documented as best-effort/non-durable, same as `events.ts`.

New route, `src/app/api/jobs/[id]/log-stream/route.ts`: session-authenticated via `requireUser()`
(not the Bearer-auth `/api/v1` style — this is for the web UI only), same `ReadableStream` /
`event:`/`data:` framing / ping-keepalive / abort-safe-cleanup shape as
`src/app/api/v1/jobs/events/route.ts`. Takes `?after=<id>` and does, simpler than originally planned
here:

1. Send persisted lines with `id > after`, ordered (`listJobLogs()`).
2. Check the job's status — read once at the top of `GET()` (for the 404 check) and reused here
   rather than re-queried. Already terminal (`completed`/`failed`) → send `end` and close; nothing
   further will ever arrive, so there's no reason to hold the connection open.
3. Otherwise, subscribe to both channels: `subscribeJobLog()` forwards new lines as they're
   published, and `subscribeJobTerminal()` sends `end` and closes the stream the moment the job
   finishes, wherever that lands relative to the connection's lifetime.

No buffer-then-drain step, and no "subscribe before backfill" ordering — both were part of the
original design and turned out to be unneeded complexity once written against the real code.
`listJobLogs()` and the terminal-status check are both synchronous, and nothing awaits between
reading the job row at the top of `GET()` and reaching either step inside `start()`, so there is no
gap in this single-threaded process for a line — or a terminal transition — to be published and
missed by every path that's supposed to catch it.

## UI

- `src/app/(app)/jobs/[id]/page.tsx` (new): job metadata (kind, status badge, attempts/maxAttempts,
  progress, timestamps — the same fields `jobs-table.tsx` renders per row) plus the initial log lines
  via a new `listJobLogs(jobId, afterId?)` query.
- `src/components/jobs/job-log-viewer.tsx` (new, client component): renders the initial lines, opens
  an `EventSource` at `/api/jobs/[id]/log-stream?after=<last id>`, appends incoming lines, auto-scrolls,
  and styles `stderr` lines distinctly from `stdout`.
- `src/components/jobs/jobs-table.tsx`: each row links to `/jobs/[id]` (same pattern as
  `users-table.tsx` linking to `/users/[id]`).

No new access restriction — this matches today's `/jobs`, gated only on being signed in.

## Touch points

| File | Change |
|---|---|
| `src/lib/db/schema/jobs.ts` | add `jobLogs` table |
| `src/lib/jobs/log-capture.ts` (new) | `AsyncLocalStorage`, patched console methods, `runWithLogCapture()` |
| `src/lib/jobs/log-bus.ts` (new) | jobId-keyed publish/subscribe |
| `src/lib/jobs/queue.ts` | `appendLogLine()`, `listJobLogs()` |
| `src/lib/jobs/worker.ts` | wrap handler invocation in `runWithLogCapture()`; append failure stack trace |
| `src/app/api/jobs/[id]/log-stream/route.ts` (new) | SSE route, session-authenticated |
| `src/app/(app)/jobs/[id]/page.tsx` (new) | job detail page |
| `src/components/jobs/job-log-viewer.tsx` (new) | live log panel |
| `src/components/jobs/jobs-table.tsx` | link rows to detail page |
| `messages/en.json`, `messages/de.json` | job detail page strings (labels, empty-log state, stream-ended state) |

## Testing

- Real-database `.test.ts` for `log-capture.ts` (concurrent unrelated `console.log` calls outside the
  `AsyncLocalStorage` context are not captured; calls inside are, attributed to the right `jobId` even
  when two contexts are active — simulated directly, not via the worker's real one-at-a-time loop) and
  for `queue.ts`'s new `appendLogLine()`/`listJobLogs()`.
- `worker.test.ts` (extend): a fake handler that calls `console.log` produces `job_logs` rows tied to
  its job id; a throwing handler's stack trace lands as stderr lines.
- Route test for `/api/jobs/[id]/log-stream` (extend the existing `/api/v1/jobs/events` route test's
  approach): auth-gated, backfill-then-live ordering, immediate close for an already-terminal job.
- `job-log-viewer.test.tsx` (new): no existing precedent in this repo for testing an `EventSource`-driven
  component — a minimal stub `EventSource` is written for this test rather than reused from elsewhere.

## Out of scope

- Structured/leveled logging, or asking handlers to emit anything beyond what they already do —
  capture is verbatim, not a new logging API for handlers to adopt.
- Log search or filtering within a job's log.
- Any change to `jobs.error` or the jobs list table's existing columns.
- Retention/cleanup policy for `jobs`/`job_logs` beyond the existing cascade — no job-deletion feature
  exists today, so none is added here.
