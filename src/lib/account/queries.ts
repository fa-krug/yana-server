import { and, desc, eq, gt, isNotNull } from "drizzle-orm";
import { headers } from "next/headers";

import { auth } from "@/lib/auth/server";
import { currentUserRow } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { accounts, sessions, type User } from "@/lib/db/schema";

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
  devices: DeviceSummary[];
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
    devices: await listDevices(user.id),
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

/** A paired device session as the account page lists it. Never the token's siblings. */
export type DeviceSummary = {
  token: string;
  deviceName: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * This user's device sessions -- ordinary `sessions` rows with `deviceName`
 * set, as opposed to the browser's own session, which has none.
 *
 * **A direct query, not `auth.api.listSessions()`.** That endpoint is gated by
 * Better Auth's `freshSessionMiddleware`, which requires the *caller's own*
 * session to have been created within `sessionConfig.freshAge` -- 24 hours by
 * default, and `src/lib/auth/server.ts` does not override it. Session refresh
 * only ever rewrites `expiresAt`/`updatedAt` (see `/get-session` in
 * `better-auth/dist/api/routes/session.mjs`), never `createdAt`, so a browser
 * session that is genuinely still valid -- up to `expiresIn` = 30 days,
 * silently refreshed every `updateAge` -- still fails that check the moment it
 * is more than a day past its original sign-in. Calling the gated endpoint
 * here would 403 this whole card (and, wired into `getAccountOverview()`,
 * the whole page) for nearly every real visitor. `removeDevice()` in
 * `./actions` has no such problem: `revokeSession` is gated by
 * `sensitiveSessionMiddleware`, which checks for *a* valid session, not a
 * fresh one, so it keeps going through the Better Auth endpoint -- getting its
 * ownership check for free, the way `src/lib/api/auth.ts`'s
 * `requireApiUser()` already prefers a direct query over hidden plugin
 * behaviour for the same class of reason.
 *
 * Only still-live sessions are listed (`expiresAt > now`): Better Auth never
 * proactively deletes an expired row, and offering a dead session as a
 * "device" to revoke would be confusing busywork with no effect.
 */
export async function listDevices(userId: string): Promise<DeviceSummary[]> {
  const rows = getDb()
    .select({
      token: sessions.token,
      deviceName: sessions.deviceName,
      createdAt: sessions.createdAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNotNull(sessions.deviceName),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(sessions.createdAt))
    .all();

  // isNotNull() narrows the WHERE clause, not Drizzle's inferred select type,
  // so deviceName is still `string | null` here -- narrow it for real so
  // DeviceSummary's field can stay non-nullable for its one consumer, the UI.
  return rows
    .filter((row): row is typeof row & { deviceName: string } => row.deviceName !== null)
    .map((row) => ({ ...row, deviceName: row.deviceName }));
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
