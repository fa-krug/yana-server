import type { NamespaceKey } from "@/i18n/next-intl";
import { attemptIn, type ActionResult } from "@/lib/attempt";

/**
 * What every action in `./actions` returns, and the one way to call one.
 *
 * **Not part of `./actions`, deliberately**: that module is `"use server"`, so
 * every export of it has to be an async function Next will expose as an
 * endpoint. `attempt()` runs in the browser and must not be one.
 *
 * The body of `attempt()` lives in `@/lib/attempt` and is shared with every
 * other feature's actions and with the CRUD kit -- the reasoning that produced
 * each of its branches is written there. This module is the account binding:
 * the namespace, and the two keys it reports with.
 */

/**
 * `errorKey` is a key under the `account` catalog namespace -- never a zod, a
 * driver or a Better Auth message. Typed at its source so a key neither catalog
 * defines fails `npm run typecheck` (see `src/i18n/next-intl.d.ts`).
 */
export type AccountKey = NamespaceKey<"account">;

export type AccountResult = ActionResult<"account">;

/**
 * Call a server action and turn a rejection into an ordinary failed result --
 * never `await` one bare from a client component.
 *
 * `sessionEnded` after the browser has been sent to `/login`, `requestFailed`
 * when the server simply never answered. See `@/lib/attempt` for why each of
 * those exists; every one of them was a live failure on this page.
 */
export const attempt = attemptIn("account", {
  sessionEnded: "sessionEnded",
  requestFailed: "requestFailed",
});
