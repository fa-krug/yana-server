import { eq } from "drizzle-orm";

import { BOOTSTRAP_USER_ID, ensureBootstrapUser } from "@/lib/db/bootstrap";
import { getDb } from "@/lib/db/client";
import { type UserSettings, userSettings } from "@/lib/db/schema";

/**
 * The phase 3/4 seam, deliberately one function.
 *
 * Until authentication exists, everything is owned by the bootstrap user. Phase 4
 * replaces this body with a session lookup and nothing else in the app changes.
 */
export async function currentUserId(): Promise<string> {
  await ensureBootstrapUser();
  return BOOTSTRAP_USER_ID;
}

/**
 * Returns the current owner's settings row.
 *
 * No insert-if-absent fallback here: ensureBootstrapUser() (awaited inside
 * currentUserId()) already creates it as one of its two rows, inside its own
 * writeTransaction() -- see bootstrap.ts. If the row is somehow still
 * missing, that is a bug in the seeding path worth surfacing loudly rather
 * than papering over with a second insert here.
 */
export async function getSettings(): Promise<UserSettings> {
  const userId = await currentUserId();

  // A plain read: writeTransaction() is for writes (see client.ts), and
  // wrapping a SELECT in BEGIN IMMEDIATE would only add needless write-lock
  // contention.
  const row = getDb().select().from(userSettings).where(eq(userSettings.userId, userId)).get();
  if (!row) {
    throw new Error(`getSettings: no user_settings row for user "${userId}"`);
  }
  return row;
}
