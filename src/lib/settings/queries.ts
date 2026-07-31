import { eq, inArray } from "drizzle-orm";
import { cache } from "react";

import { ADMIN_ROLES } from "@/lib/auth/server";
import { getDb } from "@/lib/db/client";
import { type UserSettings, userSettings, users } from "@/lib/db/schema";

/**
 * Per-process memo of the owner lookup. There is exactly one owner right now --
 * the bootstrap administrator -- so the answer cannot go stale within a process,
 * and it only needs resolving once rather than on every page render (locale
 * resolution in the root layout asks for it every time).
 *
 * Caches the *promise*, not the resolved id, so concurrent callers that land
 * before the first lookup settles all await that one in-flight attempt.
 * Cleared on rejection so a transient failure (the database briefly locked at
 * startup, or the admin bootstrap not finished yet) isn't cached for the life
 * of the process -- the next call gets a fresh attempt.
 */
// ==> TASK 3: DELETE THIS MEMO. It is per *process*, and a session id is not.
// Keeping it while `resolveOwnerId()` becomes a session read caches the first
// visitor's id and serves it to every other session -- every user would see,
// and overwrite, that one user's settings. The memo is only sound while a single
// hard-coded owner is the whole authorization model; it stops being sound the
// moment the answer depends on the request.
let ownerId: Promise<string> | undefined;

// INTERIM (Task 2 -> Task 3). Task 3 replaces this body with a session read and
// nothing else in the app changes -- the signature is the seam. "Nothing else"
// covers the *callers*: the memo above is part of this body and must go with it.
//
// There is exactly one account at this point: the administrator
// `ensureAdminExists()` creates at startup (src/lib/auth/bootstrap.ts, run from
// src/instrumentation.ts). Resolving it by role rather than by a hard-coded id
// is what lets the phase-3 seeder -- which owned the id "bootstrap" and wrote a
// user with no credentials -- be deleted outright. A read, never a write: this
// no longer seeds anything, so nothing here can create the account it looks
// for.
async function resolveOwnerId(): Promise<string> {
  const row = getDb()
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.role, ADMIN_ROLES))
    .orderBy(users.createdAt)
    .get();

  if (!row) {
    throw new Error(
      "currentUserId: no administrator exists. ensureAdminExists() runs at server " +
        "start from src/instrumentation.ts and creates one; this means it did not " +
        "run, or the database is not the one it wrote to.",
    );
  }
  return row.id;
}

/**
 * The phase 3/4 seam, deliberately one function.
 *
 * Until Task 3 lands session reads, everything is owned by the bootstrap
 * administrator. Task 3 replaces this body and nothing else in the app changes.
 */
export async function currentUserId(): Promise<string> {
  if (!ownerId) {
    ownerId = resolveOwnerId().catch((error: unknown) => {
      ownerId = undefined;
      throw error;
    });
  }
  return ownerId;
}

/**
 * Returns the current owner's settings row.
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
 * client.ts). currentUserId() writes nothing either, so a typical call here
 * does zero writes.
 *
 * No insert-if-absent fallback here: ensureAdminExists() creates the row
 * alongside the account it bootstraps -- see src/lib/auth/bootstrap.ts. If the
 * row is somehow still missing, that is a bug in the provisioning path worth
 * surfacing loudly rather than papering over with a second insert here.
 */
export const getSettings = cache(async (): Promise<UserSettings> => {
  const userId = await currentUserId();

  const row = getDb().select().from(userSettings).where(eq(userSettings.userId, userId)).get();
  if (!row) {
    throw new Error(`getSettings: no user_settings row for user "${userId}"`);
  }
  return row;
});
