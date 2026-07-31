import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    // The claim query's index: pending jobs whose runAt has passed, oldest first.
    index("jobs_claim_idx").on(table.status, table.runAt),
    index("jobs_kind_idx").on(table.kind),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
