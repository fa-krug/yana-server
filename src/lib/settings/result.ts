import type { NamespaceKey } from "@/i18n/next-intl";
import { attemptIn, type ActionResult } from "@/lib/attempt";

/**
 * What every action in `./actions` returns, and the one way to call one.
 *
 * The fifth binding of its kind, after `account`, `users`, `integrations` and
 * `ai` -- and the last one to be written, because `/settings` predates
 * `attempt()` entirely. Phase 3 shipped both of its sections calling their
 * actions bare, which CLAUDE.md calls a defect on sight; this module is what
 * they call through instead.
 *
 * **Not part of `./actions`, deliberately.** That module carries `"use server"`,
 * so every one of its exports has to be an async function Next can expose as an
 * endpoint: a type or a constant cannot live there at all, and `attempt()` runs
 * in the browser. `./actions` imports the two types below back with
 * `import type`, which is erased -- no browser-side module reaches the server
 * graph.
 */

/**
 * `errorKey` is a key under the `settings` catalog namespace (e.g.
 * "library.retentionRange") -- never zod's own message, never a driver error.
 * Typed at its *source* so a key neither `messages/en.json` nor
 * `messages/de.json` defines fails `npm run typecheck` (see
 * `src/i18n/next-intl.d.ts`); casting at the `t()` call site would defeat the
 * whole augmentation.
 */
export type SettingsKey = NamespaceKey<"settings">;

export type SettingsResult = ActionResult<"settings">;

/**
 * Call a settings action and turn a rejection into an ordinary failed result --
 * never `await` one bare from a client component.
 *
 * Both failures this buys were live on this page. A save that never *returns*
 * -- a dropped connection, the container restarting mid-request -- rejects
 * inside the section's `useTransition` scope, and an unhandled rejection there
 * escalates to the (app) group's `error.tsx`: the whole page becomes "Something
 * went wrong", taking the half-edited retention and interval fields with it.
 * And a session that ended is indistinguishable from that at the call site --
 * `src/proxy.ts` answers a cookie-less action POST with a `307 -> /login`, so
 * the client parses HTML where an RSC payload should be -- which left Save
 * re-toasting "could not save" forever on a signed-out page. `attempt()` probes
 * the server and sends that browser to `/login`.
 *
 * The body is shared (`@/lib/attempt`, where the reasoning behind every branch
 * is written); this module only supplies the namespace and its two keys, so
 * `errorKey` stays checked against the `settings` catalog rather than widened
 * to `string`.
 */
export const attempt = attemptIn("settings", {
  sessionEnded: "sessionEnded",
  requestFailed: "requestFailed",
});
