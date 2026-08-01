import { eq } from "drizzle-orm";
import { cache } from "react";

import { currentUserId } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { type UserSettings, userSettings } from "@/lib/db/schema";

/**
 * Re-exported, not reimplemented: `src/lib/auth/session.ts` owns the seam now,
 * and this is where phase 3 put it. Every phase-3 consumer -- the root layout's
 * locale and theme reads, the settings actions -- imports it from here and did
 * not have to change when it became session-backed.
 *
 * There is deliberately no memo left in this module. The one that used to live
 * here cached a single id per *process*, which was sound only while a
 * hard-coded owner was the whole authorization model; keeping it now would hand
 * the first visitor's identity to every other session.
 */
export { currentUserId };

/**
 * Returns the signed-in user's settings row.
 *
 * Wrapped in React's cache() so the root layout's locale lookup and a page's
 * data regions -- both asking for the same row within one render -- share a
 * single SELECT instead of issuing it repeatedly. Outside a request/render
 * scope (Vitest, for instance) cache() is a plain passthrough -- see
 * `exports.cache` in react/cjs/react.development.js, which just calls the
 * wrapped function directly with no dispatcher to memoize against -- so
 * every test call still hits the real database.
 *
 * A plain read, no writeTransaction(): that helper is for writes (see
 * client.ts). currentUserId() reads the session and writes nothing of ours --
 * the one write that can happen behind it is Better Auth sliding a session's
 * expiry once `session.updateAge` has elapsed, which goes through its own
 * adapter.
 *
 * No insert-if-absent fallback here: an account is provisioned with its
 * settings row -- ensureAdminExists() does it for the bootstrap administrator
 * (src/lib/auth/bootstrap.ts) and phase 5's user creation must do the same. If
 * the row is missing, that is a bug in the provisioning path worth surfacing
 * loudly rather than papering over with a second insert on the read path.
 */
export const getSettings = cache(async (): Promise<UserSettings> => {
  const userId = await currentUserId();

  const row = getDb().select().from(userSettings).where(eq(userSettings.userId, userId)).get();
  if (!row) {
    throw new Error(`getSettings: no user_settings row for user "${userId}"`);
  }
  return row;
});
