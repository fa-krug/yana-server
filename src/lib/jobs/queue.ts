import { and, asc, count, desc, eq, lte, sql } from "drizzle-orm";

import { writeTransaction } from "../db/client";
import { jobs } from "../db/schema";
import type { Job } from "../db/schema";

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
  writeTransaction((db) => {
    db.update(jobs)
      .set({
        status: "completed",
        finishedAt: new Date(),
        progress: 100,
      })
      .where(eq(jobs.id, id))
      .run();
  });
}

export function fail(id: number, error: string | Error): void {
  const errMsg = typeof error === "string" ? error : error?.message || String(error);
  const now = new Date();

  writeTransaction((db) => {
    const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) return;

    if (job.attempts >= job.maxAttempts) {
      db.update(jobs)
        .set({
          status: "failed",
          finishedAt: now,
          error: errMsg,
        })
        .where(eq(jobs.id, id))
        .run();
    } else {
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
    }
  });
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
