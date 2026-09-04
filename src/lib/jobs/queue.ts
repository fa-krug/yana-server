import { and, asc, count, desc, eq, gt, lte, sql } from "drizzle-orm";

import { publishUserEvent } from "../api/events";
import { getDb, writeTransaction } from "../db/client";
import { notifyJobFailure } from "../email/error-notifications";
import { articles, feeds, jobLogs, jobs, runs, users } from "../db/schema";
import type { Job, JobLog, JobStatus, Run } from "../db/schema";
import { publishJobLog, publishJobTerminal } from "./log-bus";

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  userId?: string;
  priority?: number;
}

/**
 * `claim()`'s `ORDER BY priority DESC` tier for work a user is actively
 * waiting on -- currently `article.reload` only. Every other kind stays at
 * the column's default `0`.
 */
export const PRIORITY_IMMEDIATE = 10;

/**
 * Every job kind that runs `handleAggregateJob`
 * (`src/lib/jobs/handlers/aggregate.ts`). Both of them map to that one
 * function directly: `"feed.update"` used to go through a six-line
 * `handlers/update.ts` wrapper whose whole body was
 * `await handleAggregateJob(job)`, which is gone.
 *
 * **This is the definition, and `handlers/index.ts` now reads it rather than
 * restating its kinds as literals** -- so a kind added here is registered
 * there by construction, closing the drift the wrapper created (two distinct
 * function references made the registry's kind -> function mapping
 * un-introspectable, so both halves were hand-maintained and nothing kept
 * them agreed). Its other reader is `scheduler.ts`'s dedupe query.
 *
 * The alias kind itself is load-bearing beyond the handler and stays:
 * `claim()` below stamps `feeds.lastAggregationStartedAt` for every kind in
 * this list, and `/jobs` shows `feed.update` as its own user-visible kind
 * (a user-triggered update, as against the scheduler's `aggregate`).
 */
export const AGGREGATE_HANDLER_JOB_KINDS = ["aggregate", "feed.update"] as const;

/** Every `jobs.status` that has not yet reached a terminal outcome. */
export const NON_TERMINAL_JOB_STATUSES = ["pending", "running", "cancelling"] as const;

export function enqueue(
  kind: string,
  payload: Record<string, unknown> = {},
  options?: EnqueueOptions,
): number {
  return writeTransaction((db) => {
    const inserted = db
      .insert(jobs)
      .values({
        kind,
        payload,
        status: "pending",
        runAt: options?.runAt ?? new Date(),
        maxAttempts: options?.maxAttempts ?? 3,
        userId: options?.userId,
        priority: options?.priority ?? 0,
      })
      .returning({ id: jobs.id })
      .get();

    return inserted.id;
  });
}

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
    const now = new Date();
    const candidate = db
      .select({ id: jobs.id, kind: jobs.kind, payload: jobs.payload })
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), lte(jobs.runAt, now)))
      .orderBy(desc(jobs.priority), asc(jobs.runAt), asc(jobs.id))
      .limit(1)
      .get();

    if (!candidate) {
      return null;
    }

    const result = db
      .update(jobs)
      .set({
        status: "running",
        startedAt: now,
        attempts: sql`${jobs.attempts} + 1`,
        // Clear a previous attempt's error -- otherwise a job retrying after a failed attempt
        // shows "running" alongside a stale failure message, reading as a job stuck mid-error.
        error: "",
      })
      .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "pending")))
      .run();

    if (result.changes !== 1) {
      return null;
    }

    // The scheduler's own clock (see feeds.lastAggregationStartedAt's doc
    // comment) is stamped here, at claim -- not at completion in
    // handleAggregateJob. Claim time is what makes the scheduler's
    // non-terminal-status dedupe (AGGREGATE_HANDLER_JOB_KINDS,
    // NON_TERMINAL_JOB_STATUSES) actually work: a job stamped only on
    // completion would still read as "not yet aggregated" for its entire
    // run, so tick() would keep re-evaluating the feed as overdue by wall
    // clock alone and rely solely on the dedupe query to hold it off.
    // Stamping here means the feed genuinely looks "just started" the moment
    // a worker picks the job up.
    if (
      (AGGREGATE_HANDLER_JOB_KINDS as readonly string[]).includes(candidate.kind) &&
      typeof candidate.payload?.feedId === "number"
    ) {
      db.update(feeds)
        .set({ lastAggregationStartedAt: now })
        .where(eq(feeds.id, candidate.payload.feedId))
        .run();
    }

    return db.select().from(jobs).where(eq(jobs.id, candidate.id)).get() ?? null;
  });
}

export function complete(id: number): void {
  const job = writeTransaction((db) => {
    const current = db.select().from(jobs).where(eq(jobs.id, id)).get();

    db.update(jobs)
      .set({
        status: "completed",
        finishedAt: new Date(),
        progress: 100,
        // Clear a stale error from an earlier failed attempt -- neither claim() nor complete()
        // touched it before, so a job that failed once and then succeeded on retry kept showing
        // its old timeout/error message forever, reading as a completed job stuck in a bad state.
        error: "",
      })
      .where(eq(jobs.id, id))
      .run();

    if (current && current.runId !== null) {
      bumpRunCounters(db, current.runId, "completed");
    }

    return current;
  });

  if (job) {
    publishJobOutcome({ ...job, status: "completed", progress: 100 }, "completed");
    publishJobTerminal(id, "completed");
  }
}

/**
 * A job attempt failed.
 *
 * `options.permanent` skips the retry schedule and fails the job outright,
 * for a cause no retry can change. Its one caller is `worker.ts`'s
 * "no handler registered for this kind" branch: the registry is populated at
 * module load and never grows at runtime, so a missing handler is
 * deterministic -- retried, it burned all three attempts on two pointless
 * `claim()`/`fail()` round trips over an exponential back-off, and only then
 * showed the operator the error message it already had on the first one.
 */
export function fail(id: number, error: string | Error, options?: { permanent?: boolean }): void {
  const errMsg = typeof error === "string" ? error : error?.message || String(error);
  const now = new Date();

  const outcome = writeTransaction((db) => {
    const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) return null;

    // A running job that was asked to cancel, then threw a real error (a
    // network failure, a parse error) before its handler ever reached its own
    // isCancelRequested() checkpoint. Honor the cancellation instead of
    // retrying or failing it -- either would silently resume the very work
    // the user asked to stop. cancelled() does the actual transition, once
    // this transaction (which has made no writes yet) has committed.
    if (job.status === "cancelling") {
      return { job, outcome: "cancelling" as const };
    }

    if (options?.permanent || job.attempts >= job.maxAttempts) {
      db.update(jobs)
        .set({
          status: "failed",
          finishedAt: now,
          error: errMsg,
        })
        .where(eq(jobs.id, id))
        .run();

      if (job.runId !== null) {
        bumpRunCounters(db, job.runId, "failed");
      }

      return { job, outcome: "failed" as const };
    }

    const backoffMs = Math.pow(2, Math.max(0, job.attempts - 1)) * 60_000;
    const nextRunAt = new Date(now.getTime() + backoffMs);

    db.update(jobs)
      .set({
        status: "pending",
        startedAt: null,
        runAt: nextRunAt,
        error: errMsg,
        // A retrying job goes back to "pending" -- the state a job is in
        // before it has done any work -- so its progress must go back to 0
        // with it. Without this, a job that had already reported real
        // progress on this attempt (a reload that reached 100 right before
        // an AI-processing throw, say) polls as "pending" at its old
        // percentage through the whole backoff window, and a client
        // displaying that number verbatim watches it sit at a stale high
        // value and then fall backwards once the retry actually starts.
        progress: 0,
      })
      .where(eq(jobs.id, id))
      .run();

    return { job, outcome: "retry" as const };
  });

  if (outcome?.outcome === "cancelling") {
    cancelled(id);
    return;
  }

  if (outcome?.outcome === "failed") {
    publishJobOutcome({ ...outcome.job, status: "failed" }, "failed");
    publishJobTerminal(id, "failed");
    notifyJobFailure(outcome.job.userId ?? resolveJobUserId(outcome.job), {
      category: "job",
      message: errMsg,
      occurredAt: now,
      jobKind: outcome.job.kind,
    });
  }
}

export function progress(id: number, percent: number): void {
  const clamped = Math.min(100, Math.max(0, Math.floor(percent)));

  // Read first, outside any write transaction: the aggregate handler calls
  // this once per article, and 80 + floor(i/total*20) only takes twenty
  // distinct values across the whole loop -- so for a 200-article feed all
  // but twenty of those calls were a BEGIN IMMEDIATE that wrote the number
  // already sitting in the column. A stale read here is harmless: the worst
  // case is one redundant write, which is exactly what happened before.
  //
  // The full row comes back (not just `progress`) because resolveJobUserId()
  // needs its runId/kind/payload/userId below, and because this dedupe
  // doubles as the publish throttle: one event per distinct percentage, so a
  // 200-article job emits about twenty events rather than two hundred.
  const current = getDb().select().from(jobs).where(eq(jobs.id, id)).get();
  if (!current || current.progress === clamped) {
    return;
  }

  writeTransaction((db) => {
    db.update(jobs).set({ progress: clamped }).where(eq(jobs.id, id)).run();
  });

  // Best-effort, exactly like publishJobOutcome: a broken subscriber must not
  // turn a successful progress write into a failed job.
  try {
    const userId = resolveJobUserId(current);
    if (!userId) return;
    publishUserEvent(userId, {
      type: "job",
      payload: {
        jobId: id,
        runId: current.runId,
        kind: current.kind,
        // The row's actual status, not a hardcoded "running": in practice
        // this is always "running" (only a claimed job reaches a handler
        // that calls progress()), but the row is already in hand here, and
        // REST (GET /api/v1/jobs/:id) and SSE must describe the same row
        // identically rather than one of them asserting a status by
        // convention instead of reading it.
        status: current.status,
        progress: clamped,
      },
    });
  } catch (err) {
    console.error(`[queue] failed to publish progress for job ${id}:`, err);
  }
}

export type CancelOutcome = "cancelled" | "cancelling" | "unchanged";

/**
 * Ask a job to stop. A `pending` job is cancelled immediately -- it never
 * started, so there is nothing to interrupt. A `running` job is only asked:
 * it becomes `cancelling`, and stays that way until its handler notices
 * `isCancelRequested()` at one of its own checkpoints and worker.ts calls
 * `cancelled()`. A job that is already `cancelling` makes no further write
 * (idempotent), but still reports `"cancelling"` rather than `"unchanged"` --
 * it has not finished, so telling a caller otherwise would read as "nothing
 * to cancel" for a job that is actively stopping. Only a job that is already
 * terminal, or that does not exist, is truly `"unchanged"`.
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

  if (job.status === "cancelling") {
    return "cancelling";
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

/**
 * Enqueues N jobs of `kind` as one run, so a client has one thing to
 * poll/subscribe to instead of N job ids (phase 13's `POST /api/v1/aggregate`).
 * All jobs in a run get the same default `maxAttempts`/`runAt` -- there is no
 * per-job override here, by design.
 *
 * An empty `payloads` list is legal (e.g. a user with zero feeds triggering
 * an aggregate run) and is created already `"completed"`, with `finishedAt`
 * set immediately. `bumpRunCounters()` is the only other code that flips a
 * run out of `"running"`, and it only runs when a child job completes/fails
 * -- a run with no children would otherwise never leave `"running"`.
 */
export function enqueueRun(
  userId: string,
  kind: string,
  payloads: Record<string, unknown>[],
  priority = 0,
): number {
  return writeTransaction((db) => {
    const isEmpty = payloads.length === 0;
    const run = db
      .insert(runs)
      .values({
        userId,
        status: isEmpty ? "completed" : "running",
        totalJobs: payloads.length,
        finishedAt: isEmpty ? new Date() : null,
      })
      .returning({ id: runs.id })
      .get();

    if (!isEmpty) {
      db.insert(jobs)
        .values(payloads.map((payload) => ({ kind, payload, runId: run.id, userId, priority })))
        .run();
    }

    return run.id;
  });
}

export function getRun(id: number): Run | null {
  return getDb().select().from(runs).where(eq(runs.id, id)).get() ?? null;
}

/**
 * A run's completion as a whole percent. Computed here, once, rather than in
 * each client: `GET /api/v1/runs/:id` and the `run` SSE event must agree, and
 * the native client drives its progress display straight off this number.
 * A run with no jobs is 100, not 0 -- there is nothing left to wait for.
 */
export function runProgressPercent(
  totalJobs: number,
  completedJobs: number,
  failedJobs: number,
): number {
  if (totalJobs <= 0) return 100;
  return Math.round(((completedJobs + failedJobs) / totalJobs) * 100);
}

/**
 * Which user a job's completion/failure should notify, or null if none
 * applies. A job belonging to a run always notifies that run's owner; a
 * standalone `article.reload` job (phase 12's reload action, no run) notifies
 * the owner of the feed its article belongs to. Every other kind (feed.logo,
 * feed.update, retention) is internal maintenance the client
 * API never triggers and never needs to hear about.
 */
function resolveJobUserId(job: Job): string | null {
  if (job.runId !== null) {
    const run = getDb()
      .select({ userId: runs.userId })
      .from(runs)
      .where(eq(runs.id, job.runId))
      .get();
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

  return null;
}

/**
 * Marks `runId` terminal once `completedJobs + failedJobs >= totalJobs` --
 * the one rule that decides a run is done, shared by every caller that can
 * change either side of that inequality (`bumpRunCounters()` below, and
 * `decrementRunTotal()`, which changes `totalJobs` rather than the counters).
 * Guarded on `status === "running"` so calling this against an
 * already-terminal run is a no-op rather than re-stamping `finishedAt`.
 *
 * Returns the run's current row (after any transition this call made), or
 * `null` if it does not exist, so a caller outside the transaction can tell
 * whether *this* call is what flipped it and publish accordingly.
 */
function finalizeRunIfDone(tx: ReturnType<typeof getDb>, runId: number): Run | null {
  const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) return null;

  if (run.status === "running" && run.completedJobs + run.failedJobs >= run.totalJobs) {
    const status = run.failedJobs > 0 ? "failed" : "completed";
    const finishedAt = new Date();
    tx.update(runs).set({ status, finishedAt }).where(eq(runs.id, runId)).run();
    return { ...run, status, finishedAt };
  }

  return run;
}

/**
 * Bumps a run's completed/failed counter for one finished child job, then
 * marks the run terminal once every child has reported in. Called from
 * inside `complete()`/`fail()`'s `writeTransaction`, so the read-then-write
 * here is atomic with the caller's own job-row update.
 */
function bumpRunCounters(
  tx: ReturnType<typeof getDb>,
  runId: number,
  outcome: "completed" | "failed",
): void {
  if (outcome === "completed") {
    tx.update(runs)
      .set({ completedJobs: sql`${runs.completedJobs} + 1` })
      .where(eq(runs.id, runId))
      .run();
  } else {
    tx.update(runs)
      .set({ failedJobs: sql`${runs.failedJobs} + 1` })
      .where(eq(runs.id, runId))
      .run();
  }

  finalizeRunIfDone(tx, runId);
}

/**
 * Removes `count` pending jobs from `runId`'s total and re-evaluates
 * terminality through the same `finalizeRunIfDone()` rule `bumpRunCounters()`
 * uses -- so deleting a run's last outstanding pending job flips it terminal
 * right here, rather than leaving it to a completion event that will never
 * come now that the job is gone (`deleteJobs()`, `@/lib/jobs/actions`).
 *
 * Must be called from inside the same transaction as the delete that made
 * `count` of `runId`'s pending jobs disappear: `runs.totalJobs` and the
 * surviving `jobs` rows must never be observably out of sync with each
 * other. `count` covers only rows that were `pending` -- a deleted
 * `completed`/`failed`/`cancelled` row already contributed to
 * `completedJobs`/`failedJobs` and needs no adjustment here.
 *
 * A run whose `totalJobs` reaches 0 this way settles the same as
 * `enqueueRun()`'s empty-`payloads` path: `0 >= 0` is true and no job
 * failed, so it finalizes as `"completed"` rather than being left `"running"`
 * with nothing left that could ever finish it.
 *
 * Returns the run's row after the decrement (and any resulting terminal
 * transition) for the caller to inspect once its own transaction has
 * committed, mirroring how `complete()`/`fail()` only publish afterward.
 */
export function decrementRunTotal(
  tx: ReturnType<typeof getDb>,
  runId: number,
  count: number,
): Run | null {
  tx.update(runs)
    .set({ totalJobs: sql`${runs.totalJobs} - ${count}` })
    .where(eq(runs.id, runId))
    .run();

  return finalizeRunIfDone(tx, runId);
}

/**
 * Publishes the `run` event for `run`'s current counters, best-effort like
 * `publishJobOutcome()` below (never throws -- a broken subscriber must not
 * turn a caller's already-committed write into a reported failure). For a
 * caller that changed run state without a child job's own completed/failed
 * transition running through `publishJobOutcome()` -- today, `deleteJobs()`
 * flipping a run terminal by deleting its last pending job.
 */
export function publishRunUpdate(userId: string, run: Run): void {
  try {
    publishUserEvent(userId, {
      type: "run",
      payload: {
        runId: run.id,
        status: run.status,
        progress: runProgressPercent(run.totalJobs, run.completedJobs, run.failedJobs),
        totalJobs: run.totalJobs,
        completedJobs: run.completedJobs,
        failedJobs: run.failedJobs,
      },
    });
  } catch (err) {
    console.error(`[queue] failed to publish run update for run ${run.id}:`, err);
  }
}

/**
 * Publishes the `job` event for one finished job, and -- only when it
 * belongs to a run -- the `run` event for that run's now-updated counters.
 * Called after the `writeTransaction` in `complete()`/`fail()` has committed,
 * so a dropped/rolled-back write never gets an event published for it.
 *
 * Never throws: `EventEmitter.emit()` rethrows synchronously if a subscriber's
 * listener throws, and `complete()`/`fail()` call this *after* their own
 * transaction has already committed -- an escaping throw here would land in
 * the worker loop's `catch`, which would call `fail()` again on a job that
 * just successfully completed, double-counting its parent run's counters and
 * overwriting a "completed" status with "failed". `events.ts` documents
 * publishing as best-effort notification, never the source of truth, so a
 * broken listener degrades to "no live update," not "corrupted job state."
 */
function publishJobOutcome(job: Job, status: "completed" | "failed" | "cancelled"): void {
  try {
    const userId = resolveJobUserId(job);
    if (!userId) return;

    publishUserEvent(userId, {
      type: "job",
      payload: {
        jobId: job.id,
        runId: job.runId,
        kind: job.kind,
        status,
        // A completed job is 100 by definition. A failed or cancelled one
        // reports how far it actually got, so the client's last displayed
        // percentage does not jump to a number that never happened.
        progress: status === "completed" ? 100 : job.progress,
      },
    });

    if (job.runId !== null) {
      const run = getRun(job.runId);
      if (run) {
        publishRunUpdate(userId, run);
      }
    }
  } catch (err) {
    console.error(`[queue] failed to publish outcome for job ${job.id}:`, err);
  }
}

/**
 * A plain read, deliberately not wrapped in `writeTransaction()`. It used to
 * be: a pure SELECT under `BEGIN IMMEDIATE`, which asks for the exclusive
 * write lock and so contends with four worker loops and every
 * `progress()`/`appendLogLine()` write -- on every `/jobs` page load, for a
 * query that writes nothing. That is exactly the cost `claim()`'s read-only
 * pre-check above exists to remove. There is no read-then-write here to keep
 * atomic; a single statement is a consistent snapshot on its own.
 */
export function getJob(id: number): Job | null {
  return getDb().select().from(jobs).where(eq(jobs.id, id)).get() ?? null;
}

export interface ListJobsOptions {
  kind?: string;
  status?: string;
  userId?: string;
  limit?: number;
  offset?: number;
}

/**
 * A job row plus its owner's display fields, for the admin-only owner column
 * on `/jobs` -- `null` when the job has no owner (the `retention` kind, which
 * runs once per boot across every user -- see `schema/jobs.ts`) or when the
 * owning user has since been deleted (`jobs.userId` is `ON DELETE SET NULL`,
 * not cascade, so a removed user's jobs outlive them rather than vanishing).
 */
export interface JobWithOwner extends Job {
  ownerEmail: string | null;
  ownerFirstName: string | null;
  ownerLastName: string | null;
}

/**
 * Two plain reads, deliberately not wrapped in `writeTransaction()` -- see
 * `getJob()` above for why a SELECT must not take the write lock, which this
 * one made worse by running a LEFT JOIN and a COUNT(*) under it.
 *
 * The page and the count are therefore two separate snapshots, so a job
 * inserted between them can make `total` disagree with `jobs.length` by one.
 * That is what a paginated list already tolerates -- the count is stale the
 * moment it is rendered anyway, and a worker inserting jobs continuously
 * makes it stale again before the response is read -- and it is not worth
 * every reader blocking every writer to avoid.
 */
export function listJobs(options: ListJobsOptions = {}): { jobs: JobWithOwner[]; total: number } {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const db = getDb();
  const conditions = [];
  if (options.kind) {
    conditions.push(eq(jobs.kind, options.kind));
  }
  if (options.status) {
    // `options.status` comes from a URL filter param (parseListParams()), not
    // a caller who already knows it's one of JobStatus -- an unrecognized value
    // just matches no rows, same as before the column was typed.
    conditions.push(eq(jobs.status, options.status as JobStatus));
  }
  if (options.userId) {
    conditions.push(eq(jobs.userId, options.userId));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Explicit column list rather than `db.select()`: the two tables both have
  // an `id` column, which a wildcard select would collide on.
  const items = db
    .select({
      id: jobs.id,
      runId: jobs.runId,
      userId: jobs.userId,
      kind: jobs.kind,
      payload: jobs.payload,
      status: jobs.status,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
      priority: jobs.priority,
      runAt: jobs.runAt,
      startedAt: jobs.startedAt,
      finishedAt: jobs.finishedAt,
      progress: jobs.progress,
      error: jobs.error,
      createdAt: jobs.createdAt,
      ownerEmail: users.email,
      ownerFirstName: users.firstName,
      ownerLastName: users.lastName,
    })
    .from(jobs)
    .leftJoin(users, eq(jobs.userId, users.id))
    .where(whereClause)
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(limit)
    .offset(offset)
    .all();

  const countResult = db.select({ value: count() }).from(jobs).where(whereClause).get();

  return {
    jobs: items,
    total: countResult?.value ?? 0,
  };
}

export type JobLogStream = "stdout" | "stderr";

/**
 * Appends one log line to `jobId`'s log and publishes it on the job log bus for
 * any live SSE viewer. Never throws: a write failure (e.g. the database is busy)
 * is caught and reported to the real `console.error`, never allowed to fail the
 * job it's describing. Every caller -- `worker.ts`'s lifecycle markers and each
 * handler's own calls alike -- gets this safety for free, with nothing to
 * remember at the call site.
 *
 * The insert and the publish are deliberately two separate `try` blocks, not
 * one spanning both: by the time `publishJobLog()` runs, the write has already
 * committed, so a throwing subscriber (a closed SSE controller, say) must not
 * turn a successful write into a false "the write failed" signal -- a `null`
 * return -- for this function's caller. Catching it separately means the row
 * is still handed back, and it means a broken subscriber can never make this
 * function's *return value* lie about whether the log line was persisted.
 */
export function appendLogLine(jobId: number, stream: JobLogStream, line: string): JobLog | null {
  let row: JobLog;
  try {
    row = writeTransaction((db) => {
      return db.insert(jobLogs).values({ jobId, stream, line }).returning().get();
    });
  } catch (err) {
    console.error(`[queue] failed to append log line for job ${jobId}:`, err);
    return null;
  }

  try {
    publishJobLog(jobId, row);
  } catch (err) {
    console.error(`[queue] failed to publish log line for job ${jobId}:`, err);
  }

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
