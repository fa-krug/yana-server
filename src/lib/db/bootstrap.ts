import { eq } from "drizzle-orm";

import { writeTransaction } from "./client";
import { userSettings, users } from "./schema";

/**
 * The pre-auth owner.
 *
 * Phase 3 needs somewhere to persist settings before authentication exists
 * (phase 4). Rather than reorder the phases, every query is scoped to this
 * constant, and phase 4 swaps the source of the id from here to the session.
 * No UI changes at that point -- only where the id comes from.
 */
export const BOOTSTRAP_USER_ID: string = "bootstrap";

/**
 * Idempotent seed for the pre-auth owner: both existence checks and both
 * inserts run inside a single writeTransaction(), so a concurrent startup
 * cannot observe (or create) a half-seeded state -- either both rows exist
 * afterward or neither does.
 *
 * The callback passed to writeTransaction() must stay synchronous
 * (better-sqlite3 has no async driver; see client.ts), so this function is
 * `async` only to keep the declared `Promise<string>` signature later
 * phases depend on -- there is nothing to await inside it.
 */
export async function ensureBootstrapUser(): Promise<string> {
  writeTransaction((tx) => {
    const existingUser = tx.select().from(users).where(eq(users.id, BOOTSTRAP_USER_ID)).get();
    if (!existingUser) {
      tx.insert(users)
        .values({
          id: BOOTSTRAP_USER_ID,
          email: "admin@admin.com",
          name: "Admin",
          firstName: "Admin",
          lastName: "",
          role: "admin",
        })
        .run();
    }

    const existingSettings = tx
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, BOOTSTRAP_USER_ID))
      .get();
    if (!existingSettings) {
      tx.insert(userSettings).values({ userId: BOOTSTRAP_USER_ID }).run();
    }
  });

  return BOOTSTRAP_USER_ID;
}
