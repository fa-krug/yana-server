import { unstable_rethrow } from "next/navigation";

import type { NamespaceKey } from "@/i18n/next-intl";
import { LOGIN_PATH } from "@/lib/auth/next-path";
import { replaceLocation } from "@/lib/browser-location";

/**
 * What every action in `./actions` returns, and the one way to call one.
 *
 * **Not part of `./actions`, deliberately**: that module is `"use server"`, so
 * every export of it has to be an async function Next will expose as an
 * endpoint. `attempt()` runs in the browser and must not be one.
 */

/**
 * `errorKey` is a key under the `account` catalog namespace -- never a zod, a
 * driver or a Better Auth message. Typed at its source so a key neither catalog
 * defines fails `npm run typecheck` (see `src/i18n/next-intl.d.ts`).
 */
export type AccountKey = NamespaceKey<"account">;

export type AccountResult = { ok: boolean; errorKey?: AccountKey };

/**
 * Call a server action and turn a *rejection* into an ordinary failed result.
 *
 * **Without this, one failed request kills the whole page.** A Server Action
 * that never returns -- Next refusing an over-sized body, a dropped connection,
 * the container restarting mid-request -- rejects the promise the call site
 * awaits, and an unhandled rejection inside a `useTransition` scope escalates
 * to the nearest error boundary. On `/account` that is the (app) group's
 * `error.tsx`, so the entire page becomes "Something went wrong" and the user
 * has lost whatever they had typed. Reproduced live with an over-sized upload:
 * `Error: Body exceeded 2304kb limit … handled by the <ErrorBoundaryHandler>`.
 *
 * This is the same failure phase 4 already fixed once on the sign-in path (see
 * `attempt()` in `src/components/auth/login-form.tsx`, which exists because
 * `@better-fetch/fetch` leaves its own `fetch` unwrapped). Same shape, same
 * remedy: one catalog key, and the caller keeps its form.
 *
 * The thrown reason is logged rather than shown. It is a framework or platform
 * error -- untranslated, and nothing a user can act on -- and the browser has
 * already logged the failed request anyway.
 *
 * `requestFailed` is deliberately distinct from `saveFailed`: "the server said
 * no" and "the server never answered" want different advice, and only the
 * second is worth retrying unchanged.
 */
export async function attempt(call: () => Promise<AccountResult>): Promise<AccountResult> {
  try {
    return await call();
  } catch (error) {
    /**
     * **Next's own control flow comes through here as a rejection, on purpose.**
     * The action reducer rejects the promise with the redirect error rather
     * than resolving (`server-action-reducer.js`), so a `redirect()`,
     * `notFound()` or `forbidden()` called *inside* an action would otherwise
     * be swallowed by this catch and reported to the user as "the server did
     * not answer" while the navigation happened anyway. `unstable_rethrow`
     * re-throws exactly those and returns for everything else; it is the
     * documented way to keep a `catch` from eating them.
     *
     * It does **not** cover the signed-out case below: that is a genuine
     * failure to parse an RSC payload, not one of Next's control-flow errors.
     */
    unstable_rethrow(error);

    console.error("An account request failed before it produced a result", error);

    /**
     * **Is this a failed request, or a session that ended?**
     *
     * They arrive identically. `src/proxy.ts` answers a cookie-less action POST
     * with a `307 -> /login`, the browser follows it, the client gets HTML
     * where an RSC payload should be, and the reducer throws -- so without this
     * the user sat on a signed-out `/account` being told to check their
     * connection, with Save re-toasting forever and no hint that a reload was
     * the way out. Before `attempt()` existed this at least reached `error.tsx`,
     * whose "Try again" navigated to /login; the fix that stopped the page
     * dying took the escape hatch with it. Reachable in ordinary use now that
     * there is a sign-out button in every window.
     *
     * Asking the server is the honest test. Sniffing the thrown error's message
     * would pin a framework string that changes between patch releases, and the
     * response body is long gone by the time this runs. `/api/auth/get-session`
     * is public in the proxy (it has to be -- signing in goes through the same
     * prefix), so it answers rather than redirecting, and it answers `null`
     * when there is no session.
     *
     * If the probe itself fails, the server really is unreachable and
     * `requestFailed` was right after all.
     */
    if ((await hasSession()) === false) {
      // A full document navigation, like sign-in and sign-out: the root layout
      // owns the locale and the theme, and the user's identity has just
      // changed. `next` so they come back to the page they were on.
      replaceLocation(`${LOGIN_PATH}?next=${encodeURIComponent(window.location.pathname)}`);
      return { ok: false, errorKey: "sessionEnded" };
    }

    return { ok: false, errorKey: "requestFailed" };
  }
}

/**
 * Does the browser still have a valid session? `null` when the question could
 * not be answered at all, which is not the same as "no".
 */
async function hasSession(): Promise<boolean | null> {
  try {
    const response = await fetch(new URL("/api/auth/get-session", window.location.origin), {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    // Better Auth answers `null` (a JSON body, status 200) for no session.
    return (await response.json()) !== null;
  } catch {
    return null;
  }
}
