import { and, asc, count, desc, eq, gt, lte, sql } from "drizzle-orm";

import { publishUserEvent } from "../api/events";
import { getDb, writeTransaction } from "../db/client";
import { notifyJobFailure } from "../email/error-notifications";
import { articles, feeds, jobLogs, jobs, runs, users } from "../db/schema";
import type { Job, JobLog, Run } from "../db/schema";
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
  return writeTransaction((db) => {
    const now = new Date();
    const candidate = db
      .select({ id: jobs.id })
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

export function fail(id: number, error: string | Error): void {
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

    if (job.attempts >= job.maxAttempts) {
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
  writeTransaction((db) => {
    db.update(jobs).set({ progress: clamped }).where(eq(jobs.id, id)).run();
  });
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
 * Which user a job's completion/failure should notify, or null if none
 * applies. A job belonging to a run always notifies that run's owner; a
 * standalone `article.reload` job (phase 12's reload action, no run) notifies
 * the owner of the feed its article belongs to. Every other kind (feed.logo,
 * feed.update, feed.restore, retention) is internal maintenance the client
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

  const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) return;

  if (run.completedJobs + run.failedJobs >= run.totalJobs) {
    tx.update(runs)
      .set({ status: run.failedJobs > 0 ? "failed" : "completed", finishedAt: new Date() })
      .where(eq(runs.id, runId))
      .run();
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
        progress: status === "completed" ? 100 : job.progress,
      },
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
  } catch (err) {
    console.error(`[queue] failed to publish outcome for job ${job.id}:`, err);
  }
}

export function getJob(id: number): Job | null {
  return writeTransaction((db) => {
    return db.select().from(jobs).where(eq(jobs.id, id)).get() ?? null;
  });
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

export function listJobs(options: ListJobsOptions = {}): { jobs: JobWithOwner[]; total: number } {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  return writeTransaction((db) => {
    const conditions = [];
    if (options.kind) {
      conditions.push(eq(jobs.kind, options.kind));
    }
    if (options.status) {
      conditions.push(eq(jobs.status, options.status));
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
  });
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
