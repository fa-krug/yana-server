import { and, asc, count, desc, eq, lte, sql } from "drizzle-orm";

import { publishUserEvent } from "../api/events";
import { getDb, writeTransaction } from "../db/client";
import { articles, feeds, jobs, runs } from "../db/schema";
import type { Job, Run } from "../db/schema";

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
}

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
      .orderBy(asc(jobs.runAt), asc(jobs.id))
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
      })
      .where(eq(jobs.id, id))
      .run();

    if (current && current.runId !== null) {
      bumpRunCounters(db, current.runId, "completed");
    }

    return current;
  });

  if (job) publishJobOutcome({ ...job, status: "completed", progress: 100 }, "completed");
}

export function fail(id: number, error: string | Error): void {
  const errMsg = typeof error === "string" ? error : error?.message || String(error);
  const now = new Date();

  const outcome = writeTransaction((db) => {
    const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) return null;

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

      return { job, terminal: true as const };
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

    return { job, terminal: false as const };
  });

  if (outcome?.terminal) {
    publishJobOutcome({ ...outcome.job, status: "failed" }, "failed");
  }
}

export function progress(id: number, percent: number): void {
  const clamped = Math.min(100, Math.max(0, Math.floor(percent)));
  writeTransaction((db) => {
    db.update(jobs).set({ progress: clamped }).where(eq(jobs.id, id)).run();
  });
}

export function resetOrphaned(before: Date): number {
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
 */
export function enqueueRun(
  userId: string,
  kind: string,
  payloads: Record<string, unknown>[],
): number {
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
 */
function publishJobOutcome(job: Job, status: "completed" | "failed"): void {
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
}

export function getJob(id: number): Job | null {
  return writeTransaction((db) => {
    return db.select().from(jobs).where(eq(jobs.id, id)).get() ?? null;
  });
}

export interface ListJobsOptions {
  kind?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export function listJobs(options: ListJobsOptions = {}): { jobs: Job[]; total: number } {
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

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const items = db
      .select()
      .from(jobs)
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
