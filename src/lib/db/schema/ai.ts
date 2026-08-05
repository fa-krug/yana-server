import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users";

/**
 * One row per attempted AI call. `checkAndRecordAiUsage()`
 * (`src/lib/ai/usage.ts`) is the only reader and writer: it counts a user's
 * rows since the start of the current UTC day/month to enforce
 * `aiDefaultDailyLimit`/`aiDefaultMonthlyLimit`, and opportunistically
 * deletes rows older than the start of the current UTC month on every call
 * -- nothing needs a row older than that, since the daily window is a
 * subset of the monthly one, so no separate cleanup job exists.
 *
 * Usage is recorded for every attempted call, not only successful ones: the
 * limit bounds outbound requests to the provider, not successful
 * completions.
 */
export const aiRequests = sqliteTable(
  "ai_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("ai_requests_user_created_idx").on(table.userId, table.createdAt)],
);

export type AiRequest = typeof aiRequests.$inferSelect;
export type NewAiRequest = typeof aiRequests.$inferInsert;
