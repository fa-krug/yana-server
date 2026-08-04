import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * A single-use, short-lived CSRF token for the device-pairing flow.
 * Minted unauthenticated by GET /device/pair/start (nothing is known about
 * who this is for yet), then required and consumed by GET /device/pair.
 * See docs/superpowers/specs/2026-08-03-client-api-design.md §1.
 */
export const devicePairingStates = sqliteTable(
  "device_pairing_states",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    state: text("state").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp" }),
  },
  (table) => [uniqueIndex("device_pairing_states_state_unique").on(table.state)],
);

export type DevicePairingState = typeof devicePairingStates.$inferSelect;
export type NewDevicePairingState = typeof devicePairingStates.$inferInsert;
