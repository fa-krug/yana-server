import { asc, desc, sql } from "drizzle-orm";
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

/**
 * Durable work queue, replacing django-q2's ORM broker. Same idea: the database
 * is the broker, so there is no Redis to run.
 *
 * The claim protocol is a conditional UPDATE inside BEGIN IMMEDIATE -- see
 * phase 12. `progress` exists so long bulk actions can report to the toast
 * system rather than appearing hung.
 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Set when this job was enqueued as part of a run (phase 13's aggregate trigger). */
    runId: integer("run_id").references(() => runs.id, { onDelete: "set null" }),
    /**
     * The job's owning user, for restricting `/jobs`/`/jobs/[id]` to a user's
     * own jobs (admins see all -- see `isAdminRole()`). Nullable: `retention`
     * runs once per tick and processes every user internally, so it has no
     * single owner. `onDelete: "set null"`, not cascade -- matches `runId`'s
     * precedent of letting a job row outlive the thing that created it.
     */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** When the job becomes eligible. Retry backoff pushes this forward. */
    runAt: integer("run_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    startedAt: integer("started_at", { mode: "timestamp" }),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    /** 0-100, for progress reporting on bulk actions. */
    progress: integer("progress").notNull().default(0),
    error: text("error").notNull().default(""),
    /**
     * Higher claims first (see `claim()`'s `ORDER BY`). `0` is every
     * background kind (`aggregate`, `retention`, `feed.logo`, `feed.update`,
     * `feed.restore`) -- nobody is watching those run. `article.reload` is
     * enqueued from a user actively staring at a spinner for that one
     * article, so it is enqueued at `PRIORITY_IMMEDIATE` and jumps ahead of
     * whatever background work already sits in the queue, rather than
     * waiting its turn behind it in FIFO order.
     */
    priority: integer("priority").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    // Column directions mirror claim()'s ORDER BY exactly
    // (`desc(priority), asc(runAt), asc(id)`). SQLite can only satisfy an
    // ORDER BY from an index by walking it forwards or entirely backwards, so
    // an all-ascending index against a mixed-direction sort falls back to a
    // temp B-tree. `id` is included so the index covers the whole ordering.
    index("jobs_claim_idx").on(table.status, desc(table.priority), asc(table.runAt), asc(table.id)),
    index("jobs_kind_idx").on(table.kind),
    index("jobs_run_idx").on(table.runId),
    index("jobs_user_idx").on(table.userId),
    /**
     * No Django precedent -- this table is new -- but the same hazard as
     * `feeds.options`: a malformed JSON write that the database accepts turns
     * the row into poison, and every later read of it throws inside Drizzle's
     * `mapFromDriverValue` rather than at the write that caused it. There is no
     * reason for a new table to be less safe than a ported one.
     */
    check("jobs_payload_json", sql`json_valid("payload")`),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

/**
 * One row per log line for a job's run, appended via `appendLogLine()`
 * (`src/lib/jobs/queue.ts`) -- `src/lib/jobs/worker.ts`'s own lifecycle markers
 * (job started/completed, and a failed handler's stack trace) and, starting
 * with the next task in this plan, explicit calls each job handler makes at a
 * few meaningful points in its own execution. Console output is deliberately
 * *not* captured. `id` (globally auto-incrementing) doubles as the per-job
 * ordering/cursor key -- `WHERE job_id = ? AND id > ?` is a cheap indexed
 * range scan, so no separate per-job sequence column is needed.
 *
 * Cascades with its job (`onDelete: "cascade"` below): `deleteJobs()`
 * (`src/lib/jobs/actions.ts`) is what deletes `jobs` rows -- a job's log
 * lines are removed in the same statement, never separately.
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
