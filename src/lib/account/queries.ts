import { and, eq, isNotNull } from "drizzle-orm";
import { headers } from "next/headers";

import { auth } from "@/lib/auth/server";
import { currentUserRow } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { accounts, type User } from "@/lib/db/schema";

/**
 * Reads for `/account`. Writes are in `./actions`.
 *
 * **`requireUser()` is not enough on this page, and that is the one subtlety
 * here.** It is served from the five-minute session cookie cache (see
 * `currentUser()`), so it can report a `firstName`, an `email` or an `image`
 * that a write from this very page has already replaced -- and the account page
 * is the one screen whose whole job is showing those columns back to their
 * owner. `currentUserRow()` is the shared read that fixes it; the (app) layout
 * uses the same one for the sidebar footer, and React's per-request `cache()`
 * means the two share a single SELECT.
 *
 * (`refreshSession()` in `@/lib/auth/session` is still needed, for a different
 * horizon: it keeps the *cookie* honest for the next request, so nothing else
 * reading `currentUser()` -- phases 5-13 -- inherits a five-minute-stale name.)
 */

/** A passkey as the account page lists it. Never the public key or the counter. */
export type PasskeySummary = {
  id: string;
  name: string | null;
  createdAt: Date;
};

export type AccountOverview = {
  user: User;
  passkeys: PasskeySummary[];
  /**
   * Does this account have an email+password credential?
   *
   * Drives two things on the page: whether the password card offers a change,
   * and whether the *last* passkey may be deleted. Deleting it without a
   * password leaves an account with no way back in at all -- there is no
   * self-registration and no mail transport, so recovery would mean editing
   * SQLite by hand.
   */
  hasPassword: boolean;
};

/**
 * Everything `/account` renders, in one place.
 *
 * Not `cache()`d: it is read exactly once per render, by the page's single data
 * region, and a memo would only make a post-write re-render return the value
 * the write replaced.
 */
export async function getAccountOverview(): Promise<AccountOverview> {
  const user = await currentUserRow();

  return {
    user,
    passkeys: await listPasskeys(),
    hasPassword: hasPasswordCredential(user.id),
  };
}

/**
 * The caller's passkeys, newest first.
 *
 * Through `auth.api.listPasskeys` rather than a `SELECT`, because the endpoint
 * scopes to the session itself (`sessionMiddleware`) -- one fewer place where a
 * missing `WHERE user_id = ?` would list somebody else's authenticators. The
 * projection down to `PasskeySummary` is deliberate: `publicKey`, `counter` and
 * `credentialID` have no business crossing into a client component.
 */
async function listPasskeys(): Promise<PasskeySummary[]> {
  const registered = await auth.api.listPasskeys({ headers: await headers() });

  return registered
    .map((passkey) => ({
      id: passkey.id,
      name: passkey.name ?? null,
      createdAt: passkey.createdAt,
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Is there a usable email+password credential for this user?
 *
 * `password IS NOT NULL` as well as the provider id: Better Auth writes an
 * `accounts` row for every provider it links, and only the credential provider
 * fills `password`. A row with a null hash is not a way to sign in, so counting
 * it would let the last-passkey guard wave through an account that then locks
 * its owner out. Mirrors the same test `changePassword` makes before it accepts
 * a current password (`api/routes/update-user.mjs`).
 *
 * Exported so the delete guard in `./actions` and the page render agree by
 * construction rather than by two similar queries.
 */
export function hasPasswordCredential(userId: string): boolean {
  const credential = getDb()
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.providerId, "credential"),
        isNotNull(accounts.password),
      ),
    )
    .get();

  return credential !== undefined;
}
