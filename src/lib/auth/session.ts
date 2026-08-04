import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { getDb } from "@/lib/db/client";
import { users, type User } from "@/lib/db/schema";

// LOGIN_PATH is where every `redirect()` below sends an unauthenticated
// request. `src/proxy.ts` sends the same requests to the same place *with* a
// `next` parameter -- it has the pathname and this does not -- so the proxy's
// redirect is the one a user normally sees. These are the backstop for
// everything the matcher cannot cover: a server action, and any request that
// carries a session cookie the proxy had to take on trust but that turns out to
// be expired, revoked or forged. It is imported rather than declared twice
// because `./next-path` has to know the path anyway, to refuse a `?next=` that
// points back here.
import { LOGIN_PATH } from "./next-path";
import { isAdminRole } from "./roles";
import { auth } from "./server";

/**
 * Better Auth's user object, as this app's `users` row.
 *
 * The cast is safe and is not merely convenient: the drizzle adapter selects
 * the row and Better Auth filters it through the field set it knows, which --
 * because `schema/users.ts` is shaped to the plugins' declared fields and the
 * two `additionalFields` -- is every column of the table. What the cast really
 * buys is that callers get the same `User` type the database layer uses, so a
 * consumer cannot start depending on a Better-Auth-shaped object that a plugin
 * change could reshape underneath it.
 */
function asUser(user: unknown): User {
  return user as User;
}

/**
 * The signed-in user, or null.
 *
 * **Served from the session cookie cache** (`session.cookieCache`, 5 minutes --
 * see `./server`), so this usually performs no database read at all, and the
 * `role` it reports can be up to that stale. That is the right trade for
 * *identity*: it is the read on every page render, and a stale identity is not
 * a privilege escalation -- the id, the email and the name of a signed-in user
 * do not change behind their back. Anything deciding *authority* must use
 * `requireAdmin()` instead, which does not trust this.
 *
 * `cache()`d per request for the same reason `getSettings()` is: the root
 * layout (locale, theme), the (app) layout (the admin flag) and any server
 * action all ask within one render. Outside a request scope -- Vitest -- React's
 * `cache()` is a plain passthrough, so tests still exercise every call.
 */
export const currentUser = cache(async (): Promise<User | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  return session ? asUser(session.user) : null;
});

/** The signed-in user, or a redirect to the login page. */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect(LOGIN_PATH);
  return user;
}

/**
 * Is this the control-flow error `redirect()` throws?
 *
 * For **one** caller shape, and it is a narrow one: the root layout resolves
 * the locale and the theme through `getSettings()`, so on a route that renders
 * without a session -- the login page, the only one there is -- `requireUser()`
 * throws in there. That throw must **not** propagate: a redirect to /login
 * issued while rendering /login is an infinite loop. It is also not an error
 * worth logging on every unauthenticated page view, which is what those two
 * catch blocks would otherwise do, at `console.error` with a stack. Protection
 * does not depend on any of this -- `src/app/(app)/layout.tsx` calls
 * `requireUser()` outside any catch, and that is the redirect a signed-out
 * visitor to a real page actually gets.
 *
 * Matched on the `digest` string because Next exports no predicate for it
 * (`unstable_rethrow` does the opposite of what is needed here). That is a
 * dependency on an implementation detail, so `src/lib/auth/session.test.ts`
 * pins it against what the installed Next's own `redirect()` throws rather than
 * against a hand-written error.
 */
export function isLoginRedirect(error: unknown): boolean {
  const digest: unknown = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

/**
 * The signed-in administrator, or a 404.
 *
 * **404 rather than 403**, deliberately: a 403 confirms the route exists, which
 * is information a non-admin has no reason to receive.
 *
 * **`disableCookieCache: true`, deliberately.** `session.cookieCache` serves
 * the whole user object -- `role` included -- out of a signed cookie for five
 * minutes without touching the database, so an admin demoted a moment ago would
 * keep administrative authority until that cookie expired. This is the one read
 * in the application that must be current, so it pays for a `sessions` +
 * `users` lookup (both indexed, both on the same local SQLite file) on every
 * call. The alternative -- keeping the cached session and re-reading only
 * `users.role` -- costs the same query and adds a second notion of what the
 * session is, so it buys nothing.
 *
 * Not `requireUser()` + a check: that would read the session twice, and the
 * first read is exactly the cached one this must not trust.
 */
export async function requireAdmin(): Promise<User> {
  const session = await auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  });

  if (!session) redirect(LOGIN_PATH);
  const user = asUser(session.user);
  // Same array the `admin()` plugin is configured with -- see ./roles.
  if (!isAdminRole(user.role)) notFound();
  return user;
}

/**
 * The signed-in user's **row**, read from `users` rather than from the session.
 *
 * `currentUser()` above answers out of a signed cookie for five minutes, and
 * within one request React's `cache()` freezes even that -- so after a server
 * action writes to `users`, the re-render that same action triggers still sees
 * the *old* values. That is not theoretical: the sidebar footer went on showing
 * "Admin" immediately after the account page saved "Ada Lovelace", and only a
 * full reload corrected it. Verified in a browser, not reasoned about.
 *
 * So anything that *displays* a user's own columns reads them here, and the
 * cached session is used only for the id to select by -- the one field that
 * cannot go stale. Authorisation still belongs to `requireUser()` /
 * `requireAdmin()`; this is a projection, not a gate, and it is called after
 * one of them.
 *
 * One indexed primary-key lookup on the same local SQLite file the request has
 * open, `cache()`d per request so the (app) layout's footer and the account
 * page's own read share it. The freshness argument depends on that memo being
 * *per request*: an action's write lands before the re-render begins, so the
 * re-render's first call is the one that reads it back.
 */
export const currentUserRow = cache(async (): Promise<User> => {
  const id = (await requireUser()).id;
  const row = getDb().select().from(users).where(eq(users.id, id)).get();
  if (!row) {
    // The session names a user with no `users` row. In production that is an
    // account deleted while its session was still live; in development it is
    // routine -- session.cookieCache verifies a signed cookie's signature
    // with no database read, so a database wiped or recreated (a fresh
    // migration, a branch switch) while the browser still holds an old
    // cookie passes that check and then fails here. Either way the session
    // is unusable, and the correct response is the same one `requireUser()`
    // gives an absent session: send the caller to sign in again. `console.error`
    // keeps this loud for the rarer production case instead of crashing the
    // render for both.
    console.error(
      `currentUserRow: no users row for the signed-in id "${id}" -- redirecting to login`,
    );
    redirect(LOGIN_PATH);
  }
  return row;
});

/**
 * Re-read the session from the database and rewrite the session cookie cache.
 *
 * **Call this from a server action after any direct write to `users`.**
 * `currentUser()` is served from a signed cookie for five minutes
 * (`session.cookieCache`), so a `UPDATE users SET first_name = ...` made
 * through `writeTransaction()` is *invisible* to every subsequent render until
 * that cookie expires: the account page saves, the toast says so, and the
 * sidebar keeps showing the old name for up to five minutes. Nothing throws,
 * which is what makes it worth a named function rather than a line somewhere.
 *
 * `disableCookieCache: true` is what forces the database read; the endpoint
 * then calls `setCookieCache()` on the way out
 * (`better-auth/dist/api/routes/session.mjs`), so the refreshed row is what the
 * next request sees. That rewrite only lands because `nextCookies()` is
 * registered -- see the plugin comment in `./server`. Outside a server action
 * (a Server Component render) the write is dropped and this degrades to a plain
 * read, which is correct: a component may not set cookies.
 *
 * Not `cache()`d, deliberately: the point is to *invalidate*, and a memo would
 * hand back the value the write just superseded.
 */
export async function refreshSession(): Promise<void> {
  await auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  });
}

/**
 * The phase 3/4 seam, now closed.
 *
 * Signature unchanged from phase 3 on purpose: every consumer written against
 * the interim body (which resolved the one bootstrap administrator) keeps
 * working, and now scopes its data to whoever is actually signed in.
 *
 * The per-process memo that used to sit in `src/lib/settings/queries.ts` went
 * with that body, and must not come back in any form: a session id depends on
 * the request, so caching one across requests would serve the first visitor's
 * identity -- and their settings, feeds and articles -- to everyone else. The
 * per-*request* `cache()` on `currentUser()` above is the only memo that is
 * sound here.
 */
export async function currentUserId(): Promise<string> {
  return (await requireUser()).id;
}
