import type { NamespaceKey } from "@/i18n/next-intl";
import { attemptIn, type ActionResult, type NoticeResult } from "@/lib/attempt";

/**
 * What every action in `./actions` returns, and the one way to call one.
 *
 * The fourth binding of its kind, after `account`, `users` and `integrations`,
 * and `src/lib/integrations/result.ts` is its direct sibling -- read that one
 * for the reasoning; only what differs is written here.
 *
 * **Not part of `./actions`, deliberately.** That module carries `"use server"`,
 * so every one of its exports has to be an async function Next can expose as an
 * endpoint: a type or a constant cannot live there at all, and `attempt()` runs
 * in the browser.
 *
 * **`errorKey` is a key under the `ai` namespace and nothing else** -- never a
 * zod message, never a driver error, and above all never a `ProbeResult.detail`.
 * The phase-7 plan's stated interface was `{ ok: boolean; error?: string }` with
 * a test asserting `result.error` matched `/monthly/i`; that was superseded,
 * because an English validator string rendered into a German toast is precisely
 * what this convention exists to prevent. A probe's `detail` is worse still: it
 * is prose built for a server log, and an AI provider's error body can echo back
 * the very key that was just submitted. The map from a probe's `cause` to a
 * catalog key lives server-side in `./actions`; only the key crosses the wire.
 */
export type AiKey = NamespaceKey<"ai">;

export type AiResult = ActionResult<"ai">;

/**
 * What a save or a test reports: the usual `{ ok, errorKey }` plus an optional
 * `noticeKey` for an outcome that succeeded **with a caveat**.
 *
 * The caveat is a rate limit from a provider that validates the credential
 * before it accounts for quota -- Anthropic and Gemini, but *not* OpenAI, whose
 * base URL is an operator setting so a gateway can shed load before reading the
 * `Authorization` header. That difference is `quotaMeansVerified` in
 * `./providers`, read from there rather than restated in the descriptor.
 *
 * The `ai` instantiation of `NoticeResult` in `@/lib/attempt`, which is where
 * the shape and the reasoning behind it live. Named the same way
 * `IntegrationsResult`'s `SaveResult` is, so the reporter in
 * `@/components/section-kit` serves both pages unchanged.
 */
export type AiSaveResult = NoticeResult<AiKey>;

/**
 * Call an AI action and turn a rejection into an ordinary failed result --
 * never `await` one bare from a client component.
 *
 * The account, users and integrations bindings' twin; the body is shared
 * (`@/lib/attempt`, where the reasoning behind every branch is written) while
 * `errorKey` stays checked against the `ai` catalog rather than widened to
 * `string`.
 */
export const attempt = attemptIn("ai", {
  sessionEnded: "sessionEnded",
  requestFailed: "requestFailed",
});
