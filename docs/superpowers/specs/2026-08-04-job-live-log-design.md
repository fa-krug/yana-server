# Background Job Live Log

**Date:** 2026-08-04
**Status:** Implemented

## Goal

Let a user open a background job from `/jobs` and see what it's actually doing: a curated log of
its meaningful lifecycle events and outcomes (and, on failure, the full error stack) both as
persisted history and as a live tail while the job is still running.

**Revision (2026-08-05):** the original approach captured every `console.*` call a handler made,
verbatim, via an `AsyncLocalStorage`-scoped patch. Reconsidered after implementation: a verbatim
capture logs everything a handler happens to print, which is noise, not signal — none of the six
handlers called `console.*` at all before this feature, so "capture everything" really meant
"capture nothing but lifecycle markers, until someone adds a stray `console.log` later with no
editorial control over what it says." The revised approach drops the capture mechanism entirely
and instead has each handler call `appendLogLine()` directly, a small number of times, at points a
human would actually want to see: what was fetched, what changed, what was skipped and why. The
storage table, the pub/sub, the SSE route and the UI are all unaffected — only the *source* of log
lines changes, from "whatever console.* prints" to "what the handler explicitly says."

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

## Capture: explicit calls, not console interception

Handlers call `appendLogLine(job.id, "stdout" | "stderr", line)` (`src/lib/jobs/queue.ts`) directly,
at a small, fixed number of points chosen per handler — never a blanket capture of arbitrary output.
`appendLogLine()` itself never throws: a write failure (e.g. the database is busy) is caught inside
it and reported to the real `console.error`, never allowed to fail the job it's describing or
propagate to the caller — logging is best-effort, same philosophy `queue.ts`'s
`publishJobOutcome()` already documents for event publishing. This also means every caller —
`worker.ts`'s lifecycle markers and each handler's own calls alike — gets that safety for free,
with no per-call-site try/catch to remember.

The worker (`src/lib/jobs/worker.ts`) appends three lifecycle markers around every handler
invocation, unconditionally:

- claim → `"job started (attempt N/M)"` (stdout)
- success → `"job completed"` (stdout)
- failure → the error's full `message` **and stack trace**, one line per row (stderr) — strictly more
  than today's single-line `jobs.error`, which is left as-is for the table view's tooltip

Each handler adds a handful more, chosen to answer "what did this job actually do":

- `aggregate` (and `feed.update`, which just calls it) — how many articles were fetched, and a
  created/updated split once they're upserted; an early skip (feed missing or disabled) is logged
  too, since silence there previously meant a job "did nothing" with no way to tell why.
- `feed.logo` — whether a logo source was configured, whether one was found, and where it came from
  when stored.
- `feed.restore` — how many existing articles were removed (tombstoned) before the re-aggregation
  that follows logs its own lines.
- `article.reload` — whether the article was found and had stored content to re-parse, and
  confirmation once it's done.
- `retention` — per user, how many expired articles were removed; then how many old tombstones were
  pruned globally.

Every one of these calls happens **outside** any `writeTransaction()` block: `appendLogLine()`
publishes to the live SSE viewers as soon as it's called, and a line published from inside a
still-open transaction could describe a delete the transaction then rolls back. Where a handler
needs a count from inside a transaction (e.g. `retention`'s per-user delete count), the transaction
callback returns the count and the handler logs it after the transaction has returned — not before.

There is no `AsyncLocalStorage`, no console patching, and therefore no risk of an unrelated
concurrent request's logging being misattributed to a job (the reason the original design gave for
choosing `AsyncLocalStorage` over a global patch): a handler never touches global `console` state at
all, so there's nothing shared to cross-attribute.

## No cap on log size

A single handler now logs a small, fixed number of lines per run (not one per item it processes), so
there is no realistic path to unbounded growth, and no cap is applied.

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
| `src/lib/jobs/log-bus.ts` (new) | jobId-keyed publish/subscribe (log lines + terminal transitions) |
| `src/lib/jobs/queue.ts` | `appendLogLine()` (never throws), `listJobLogs()` |
| `src/lib/jobs/worker.ts` | append lifecycle markers and the failure stack trace around every handler call |
| `src/lib/jobs/handlers/aggregate.ts`, `logo.ts`, `restore.ts`, `reload.ts`, `retention.ts` | a handful of `appendLogLine()` calls each, per the list above |
| `src/app/api/jobs/[id]/log-stream/route.ts` (new) | SSE route, session-authenticated |
| `src/app/(app)/jobs/[id]/page.tsx` (new) | job detail page |
| `src/components/jobs/job-log-viewer.tsx` (new) | live log panel |
| `src/components/jobs/jobs-table.tsx` | link rows to detail page |
| `messages/en.json`, `messages/de.json` | job detail page strings (labels, empty-log state, stream-ended state) |

## Testing

- Real-database `.test.ts` for `queue.ts`'s `appendLogLine()` (never throws, even when the
  underlying write fails) and `listJobLogs()`.
- `worker.test.ts` (extend): lifecycle markers are appended around a handler call; a throwing
  handler's stack trace lands as stderr lines.
- Each handler's own `.test.ts` (extend): the specific `appendLogLine()` calls that handler adds are
  asserted against a real job row's log, for both its logged branches (found/not-found, skipped/not).
- Route test for `/api/jobs/[id]/log-stream` (extend the existing `/api/v1/jobs/events` route test's
  approach): auth-gated, backfill-then-live ordering, immediate close for an already-terminal job, and
  a stream that closes with an `end` event when the job it's tailing finishes mid-connection.
- `job-log-viewer.test.tsx` (new): no existing precedent in this repo for testing an `EventSource`-driven
  component — a minimal stub `EventSource` is written for this test rather than reused from elsewhere.

## Out of scope

- A generic logging API handlers can call with arbitrary messages — the calls this feature adds are
  fixed, one per meaningful event, not a facility for future handlers to log freely.
- Log search or filtering within a job's log.
- Any change to `jobs.error` or the jobs list table's existing columns.
- Retention/cleanup policy for `jobs`/`job_logs` beyond the existing cascade — no job-deletion feature
  exists today, so none is added here.
