import { eq } from "drizzle-orm";
import { cache } from "react";

import { ensureBootstrapUser } from "@/lib/db/bootstrap";
import { getDb } from "@/lib/db/client";
import { type UserSettings, userSettings } from "@/lib/db/schema";

/**
 * Per-process memo of the bootstrap seed, keyed on nothing (there is only
 * ever one seed): ensureBootstrapUser() is idempotent and its result cannot
 * go stale within a process, so it only needs to run once, not once per
 * request -- every call used to take the write lock (BEGIN IMMEDIATE) via
 * writeTransaction(), and once locale resolution runs it in the root layout,
 * that's every single page render.
 *
 * Caches the *promise*, not the resolved id, so concurrent callers that land
 * before the first seed settles all await that one in-flight attempt instead
 * of racing separate writeTransaction() calls against each other. Cleared on
 * rejection so a transient failure (e.g. the database briefly locked at
 * startup) isn't cached for the life of the process -- the next call gets a
 * fresh attempt.
 *
 * Deliberately not memoized inside ensureBootstrapUser() itself:
 * bootstrap.test.ts's "is idempotent: calling it twice does not throw or
 * duplicate rows" case exists to prove the underlying SQL tolerates running
 * twice. Memoizing there would make that assertion pass without ever
 * exercising the thing it claims to test. This memo stays in phase-3 code,
 * where the per-request-cost problem actually lives.
 */
let bootstrapSeed: Promise<string> | undefined;

/**
 * The phase 3/4 seam, deliberately one function.
 *
 * Until authentication exists, everything is owned by the bootstrap user. Phase 4
 * replaces this body with a session lookup and nothing else in the app changes.
 */
export async function currentUserId(): Promise<string> {
  if (!bootstrapSeed) {
    bootstrapSeed = ensureBootstrapUser().catch((error: unknown) => {
      bootstrapSeed = undefined;
      throw error;
    });
  }
  return bootstrapSeed;
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
 * client.ts). currentUserId() no longer takes the write lock on every call
 * either, now that its bootstrap seed is memoized above, so a typical call
 * here does zero writes, not "a SELECT wrapped in someone else's BEGIN
 * IMMEDIATE".
 *
 * No insert-if-absent fallback here: ensureBootstrapUser() (awaited inside
 * currentUserId()) already creates it as one of its two rows, inside its own
 * writeTransaction() -- see bootstrap.ts. If the row is somehow still
 * missing, that is a bug in the seeding path worth surfacing loudly rather
 * than papering over with a second insert here.
 */
export const getSettings = cache(async (): Promise<UserSettings> => {
  const userId = await currentUserId();

  const row = getDb().select().from(userSettings).where(eq(userSettings.userId, userId)).get();
  if (!row) {
    throw new Error(`getSettings: no user_settings row for user "${userId}"`);
  }
  return row;
});
