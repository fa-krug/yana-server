import type { NamespaceKey } from "@/i18n/next-intl";

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
    console.error("An account request failed before it produced a result", error);
    return { ok: false, errorKey: "requestFailed" };
  }
}
