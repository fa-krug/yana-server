import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import type { User } from "@/lib/db/schema";

import { LOGIN_PATH } from "./next-path";
import { isAdminRole } from "./roles";
import { auth } from "./server";

/**
 * Where an unauthenticated request is sent. `src/proxy.ts` sends the same
 * requests to the same place *with* a `next` parameter -- it has the pathname
 * and this does not -- so the proxy's redirect is the one a user normally sees.
 * This one is the backstop for everything the matcher cannot cover: a server
 * action, and any request that carries a session cookie the proxy had to take
 * on trust but that turns out to be expired, revoked or forged.
 *
 * Imported from `./next-path` rather than declared twice: that module has to
 * know this path anyway, because a `?next=` pointing back at the login page is
 * an infinite redirect it must refuse.
 */

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
