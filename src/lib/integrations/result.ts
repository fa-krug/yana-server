import type { NamespaceKey } from "@/i18n/next-intl";
import { attemptIn, type ActionResult } from "@/lib/attempt";

/**
 * What every action in `./actions` returns, and the one way to call one.
 *
 * **Not part of `./actions`, deliberately** -- the same reason
 * `src/lib/users/result.ts` and `src/lib/account/result.ts` are separate
 * modules: `./actions` carries the `"use server"` directive, so every one of its
 * exports has to be an async function Next can expose as an endpoint. A type or
 * a constant cannot live there at all, and `attempt()` runs in the browser.
 *
 * `errorKey` is a key under the `integrations` catalog namespace -- never a zod
 * message, a driver error, and above all **never a `ProbeResult.detail`**. That
 * `detail` is English prose built for a server log, and a provider's own
 * message can echo back the very credential the caller just submitted; the map
 * from a probe's `cause` to a key lives server-side in `./actions` and only the
 * key crosses the wire.
 */
export type IntegrationsKey = NamespaceKey<"integrations">;

export type IntegrationsResult = ActionResult<"integrations">;

/**
 * What a save or a test reports: the usual `{ ok, errorKey }` plus an optional
 * `noticeKey` for an outcome that succeeded **with a caveat**.
 *
 * The caveat that made this necessary is quota exhaustion. A quota answer means
 * the credential is valid and only today's budget is gone, so the probe counts
 * as a pass and the integration is switched on -- and reporting `{ ok: false }`
 * over a row that was written and enabled would send an operator back to re-save
 * something that already worked. So the result is `ok: true` and the section
 * renders `noticeKey` with `toast.warning(...)` instead of `toast.success(...)`.
 *
 * Extending the result type rather than widening `errorKey`'s meaning follows
 * phase 5's precedent (`CreateUserResult`, `DeleteUsersResult` in
 * `src/lib/users/result.ts`): the failure arm's `ok` is the literal `false`, so
 * `if (result.ok)` still narrows back to this type and `noticeKey` survives
 * being wrapped in `attempt()`.
 *
 * **A union of the two arms, not an intersection, and that is the point.** As
 * `IntegrationsResult & { noticeKey?: … }` this type let both keys sit on either
 * arm: `{ ok: false, noticeKey }` and `{ ok: true, errorKey }` typechecked, and
 * `useReportOutcome()` reads `errorKey` only when `ok` is false and `noticeKey`
 * only when it is true -- so either mistake compiled and then silently reported
 * the *wrong outcome with no message at all*, which is the failure mode a typed
 * key is supposed to make impossible. Written as a union, each is a compile
 * error at the `return`. `IntegrationsResult` still describes it (both arms
 * satisfy `ActionResult<"integrations">`), so `attempt()` wraps it unchanged.
 */
export type SaveResult =
  { ok: true; noticeKey?: IntegrationsKey } | { ok: false; errorKey?: IntegrationsKey };

/**
 * Call an integrations action and turn a rejection into an ordinary failed
 * result -- never `await` one bare from a client component.
 *
 * The account and users bindings' twin; the body is shared (`@/lib/attempt`,
 * where the reasoning behind every branch is written) while `errorKey` stays
 * checked against the `integrations` catalog rather than widened to `string`.
 */
export const attempt = attemptIn("integrations", {
  sessionEnded: "sessionEnded",
  requestFailed: "requestFailed",
});
