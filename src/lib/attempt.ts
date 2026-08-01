import type { Messages } from "next-intl";
import { unstable_rethrow } from "next/navigation";

import type { NamespaceKey } from "@/i18n/next-intl";
import { LOGIN_PATH } from "@/lib/auth/next-path";
import { replaceLocation } from "@/lib/browser-location";

/**
 * **Never `await` a server action bare from a client component.** This module
 * is the one way to call one, and it is shared rather than copied: phase 5
 * alone would otherwise have six near-copies of the same safety-critical block
 * (`/account`'s three sections, `/users`'s three, and the CRUD kit's two
 * backstops).
 *
 * It imports nothing that cannot reach the browser -- the same rule
 * `src/lib/avatar.ts`, `src/lib/auth/roles.ts` and `src/lib/users/fields.ts`
 * follow, and here it is load-bearing rather than tidy: every consumer is a
 * `"use client"` component.
 *
 * Two layers, because the callers genuinely differ:
 *
 * - {@link attemptCall} owns "call it, catch, re-throw Next's control flow,
 *   log, and decide whether the session ended". It knows no catalog at all, so
 *   the CRUD kit -- generic components with no namespace of their own -- can
 *   use it.
 * - {@link attemptIn} binds that to one catalog namespace and turns the
 *   outcome into the `{ ok, errorKey }` every server action here returns.
 *
 * Where a comment below says "the caller", it now covers all of them.
 */

/**
 * What came back from something that might never return.
 *
 * A discriminated union rather than `Result | null`, because "it rejected" and
 * "it rejected *and* the session is gone" want different answers from the
 * caller, and a caller that returns its own nullable result could not tell
 * either of them from a value.
 */
export type Attempted<Result> =
  { status: "returned"; result: Result } | { status: "rejected"; sessionEnded: boolean };

export type AttemptOptions = {
  /**
   * What the console gets when the call rejects. The thrown reason is logged
   * rather than shown: it is a framework or platform error -- untranslated, and
   * nothing a user can act on -- and the browser has already logged the failed
   * request anyway.
   */
  label: string;
  /**
   * **`"skip"` is for `/login` and nowhere else.** A caller with no session is
   * *supposed* to be on the sign-in page, so probing there would point it at
   * itself. Everywhere else the probe is what tells a session that ended apart
   * from a request that failed, so the default asks.
   */
  sessionProbe?: "ask" | "skip";
};

/**
 * Call something that might never return, and turn a *rejection* into a value.
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
 * The sign-in path had the same failure for its own reason -- and it is why
 * this is generic over `Result` rather than over `{ ok, errorKey }`.
 * `@better-fetch/fetch` converts *HTTP* failures into `{ data, error }` but
 * leaves its own `await fetch(...)` unwrapped, so a network-level failure
 * rejects: unhandled, that left the form on "Signing in" forever with no
 * message and no way back except a reload. Same shape, same remedy, a
 * different result type.
 */
export async function attemptCall<Result>(
  call: () => Promise<Result>,
  { label, sessionProbe = "ask" }: AttemptOptions,
): Promise<Attempted<Result>> {
  try {
    return { status: "returned", result: await call() };
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

    console.error(label, error);

    /**
     * **Is this a failed request, or a session that ended?**
     *
     * They arrive identically. `src/proxy.ts` answers a cookie-less action POST
     * with a `307 -> /login`, the browser follows it, the client gets HTML
     * where an RSC payload should be, and the reducer throws -- so without this
     * the user sat on a signed-out `/account` being told to check their
     * connection, with Save re-toasting forever and no hint that a reload was
     * the way out. Before this function existed that at least reached
     * `error.tsx`, whose "Try again" navigated to /login; the fix that stopped
     * the page dying took the escape hatch with it. Reachable in ordinary use
     * now that there is a sign-out button in every window.
     *
     * Asking the server is the honest test. Sniffing the thrown error's message
     * would pin a framework string that changes between patch releases, and the
     * response body is long gone by the time this runs. `/api/auth/get-session`
     * is public in the proxy (it has to be -- signing in goes through the same
     * prefix), so it answers rather than redirecting, and it answers `null`
     * when there is no session.
     *
     * If the probe itself fails, the server really is unreachable and a plain
     * failed request was right after all.
     */
    if (sessionProbe === "ask" && (await hasSession()) === false) {
      // A full document navigation, like sign-in and sign-out: the root layout
      // owns the locale and the theme, and the user's identity has just
      // changed. `next` so they come back to the page they were on.
      replaceLocation(`${LOGIN_PATH}?next=${encodeURIComponent(window.location.pathname)}`);
      return { status: "rejected", sessionEnded: true };
    }

    return { status: "rejected", sessionEnded: false };
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

/**
 * What a server action in `Namespace` resolves to.
 *
 * `errorKey` is a key under that catalog namespace -- never a zod, a driver or
 * a Better Auth message. Typed at its *source* so a key neither
 * `messages/en.json` nor `messages/de.json` defines fails `npm run typecheck`
 * (see `src/i18n/next-intl.d.ts`); casting at the `t()` call site would defeat
 * the whole augmentation.
 */
export type ActionResult<Namespace extends keyof Messages> = {
  ok: boolean;
  errorKey?: NamespaceKey<Namespace>;
};

/**
 * What {@link attemptIn}'s `attempt` produces when the action never returned.
 *
 * `ok` is the literal `false`, not `boolean`, and that is what makes
 * `if (result.ok)` narrow the union back to the caller's own result type --
 * so an action that also reports an `id` or a `deleted` count does not lose it
 * by being wrapped.
 */
export type ActionFailure<Namespace extends keyof Messages> = {
  ok: false;
  errorKey: NamespaceKey<Namespace>;
};

/**
 * An action result that can also succeed **with a caveat**.
 *
 * The caveat that made this necessary is provider quota exhaustion. A quota
 * answer means the credential is valid and only today's budget is gone, so the
 * probe counts as a pass and the integration is switched on -- and reporting
 * `{ ok: false }` over a row that was written and enabled would send an operator
 * back to re-save something that already worked. So the result is `ok: true` and
 * the card renders `noticeKey` with `toast.warning(...)` instead of
 * `toast.success(...)`.
 *
 * **A union of the two arms, not an intersection, and that is the point.** As
 * `ActionResult<…> & { noticeKey?: … }` this type let both keys sit on either
 * arm: `{ ok: false, noticeKey }` and `{ ok: true, errorKey }` typechecked, and
 * the reporter reads `errorKey` only when `ok` is false and `noticeKey` only when
 * it is true -- so either mistake compiled and then silently reported the *wrong
 * outcome with no message at all*, which is the failure mode a typed key is
 * supposed to make impossible. Written as a union, each is a compile error at the
 * `return`. Both arms still satisfy {@link ActionResult}, so {@link attemptIn}'s
 * `attempt` wraps it unchanged, and the failure arm's optional `errorKey` is what
 * {@link ActionFailure} fills in when the action never answered.
 *
 * **Parameterised over the key type, not the namespace**, unlike its two
 * neighbours above. It is the argument type of a reporter that has to *render*
 * the key it is handed, and `useTranslations(namespace)` with a generic
 * `Namespace` yields a `t` TypeScript cannot prove accepts
 * `NamespaceKey<Namespace>` -- see the header of `@/components/section-kit`,
 * where that reporter lives. A feature names the instantiation once:
 * `type SaveResult = NoticeResult<IntegrationsKey>`.
 */
export type NoticeResult<Key extends string> =
  { ok: true; noticeKey?: Key } | { ok: false; errorKey?: Key };

/**
 * Bind {@link attemptCall} to one catalog namespace. One binding per feature:
 *
 * ```ts
 * // src/lib/account/result.ts
 * export const attempt = attemptIn("account", {
 *   sessionEnded: "sessionEnded",
 *   requestFailed: "requestFailed",
 * });
 * ```
 *
 * A factory rather than `attempt("account", () => …)` at every call site: the
 * feature module stays the import point, so a namespace cannot be mistyped once
 * per call, and the components keep the spelling they already had.
 *
 * **The two keys are spelled out rather than derived from the namespace**, even
 * though every namespace that has adopted this defines exactly those two names.
 * TypeScript cannot prove `"sessionEnded"` is a member of
 * `NamespaceKey<Namespace>` while `Namespace` is still a type *parameter*, so
 * deriving them would need a cast inside this function -- and a cast is
 * precisely the thing this convention exists to avoid. Supplied at a binding
 * site, where `Namespace` is a literal, the compiler checks them against the
 * real catalogs for free.
 *
 * `requestFailed` is deliberately distinct from a namespace's `saveFailed`:
 * "the server said no" and "the server never answered" want different advice,
 * and only the second is worth retrying unchanged.
 */
export function attemptIn<Namespace extends keyof Messages>(
  namespace: Namespace,
  keys: {
    /** Reported after the browser has already been sent to `/login`. */
    sessionEnded: NamespaceKey<Namespace>;
    /** Reported when the action never answered and the session is still good. */
    requestFailed: NamespaceKey<Namespace>;
  },
) {
  return async function attempt<Result extends ActionResult<Namespace>>(
    call: () => Promise<Result>,
  ): Promise<Result | ActionFailure<Namespace>> {
    const attempted = await attemptCall(call, {
      // The namespace, so a console line says which feature's action died
      // without every binding having to invent a sentence.
      label: `A server action failed before it produced a result [${String(namespace)}]`,
    });
    if (attempted.status === "returned") return attempted.result;
    return {
      ok: false,
      errorKey: attempted.sessionEnded ? keys.sessionEnded : keys.requestFailed,
    };
  };
}
