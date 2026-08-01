import type { NamespaceKey } from "@/i18n/next-intl";
import { attemptIn, type ActionResult, type NoticeResult } from "@/lib/attempt";

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
 * `noticeKey` for an outcome that succeeded **with a caveat** -- quota
 * exhaustion, where the credential is valid and only today's budget is gone.
 *
 * The `integrations` instantiation of `NoticeResult` in `@/lib/attempt`, which
 * is where the shape is defined and where the reasoning behind it lives: why a
 * caveat is a success and not a failure, and why the two arms are a **union and
 * not an intersection**. Phase 7's AI page names its own instantiation the same
 * way, so the reporter in `@/components/section-kit` can serve both.
 *
 * Extending the result type rather than widening `errorKey`'s meaning follows
 * phase 5's precedent (`CreateUserResult`, `DeleteUsersResult` in
 * `src/lib/users/result.ts`): the failure arm's `ok` is the literal `false`, so
 * `if (result.ok)` still narrows back to this type and `noticeKey` survives
 * being wrapped in `attempt()`. `IntegrationsResult` still describes it (both
 * arms satisfy `ActionResult<"integrations">`), so `attempt()` wraps it
 * unchanged.
 */
export type SaveResult = NoticeResult<IntegrationsKey>;

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
