import type { NamespaceKey } from "@/i18n/next-intl";
import { attemptIn, type ActionResult } from "@/lib/attempt";

/**
 * What every action in `./actions` returns, and the one way to call one.
 *
 * **Not part of `./actions`, deliberately** -- the same reason
 * `src/lib/account/result.ts` is a separate module: `./actions` carries the
 * `"use server"` directive, so every one of its exports has to be an async
 * function Next can expose as an endpoint. A type or a constant cannot live
 * there at all, and `attempt()` runs in the browser.
 *
 * `errorKey` is a key under the `users` catalog namespace -- never a zod, a
 * driver or a Better Auth message. Typed at its *source* so a key neither
 * catalog defines fails `npm run typecheck` (see `src/i18n/next-intl.d.ts`);
 * casting at the `t()` call site would defeat the whole augmentation. This is
 * CLAUDE.md's rule, and the plan for this phase contradicted it by specifying
 * `error?: string` with English prose -- an English validator message rendered
 * into a German UI is exactly what the convention exists to prevent.
 */
export type UsersKey = NamespaceKey<"users">;

export type UsersResult = ActionResult<"users">;

/** `createUser` additionally reports the id it minted, for a redirect. */
export type CreateUserResult = UsersResult & { id?: string };

/** `deleteUsers` additionally reports how many rows actually went. */
export type DeleteUsersResult = UsersResult & { deleted: number };

/**
 * Call a users action and turn a rejection into an ordinary failed result --
 * never `await` one bare from a client component.
 *
 * The account binding's twin, and the reason `attempt()` is
 * namespace-parameterized at all: the body is shared (`@/lib/attempt`, where
 * the reasoning behind every branch is written), while `errorKey` stays checked
 * against the `users` catalog rather than widened to `string`.
 *
 * **It keeps the caller's own result type.** `attempt(() => createUser(...))`
 * still resolves something carrying `id`, and `attempt(() => deleteUsers(...))`
 * something carrying `deleted`, because the failure arm's `ok` is the literal
 * `false` -- so `if (result.ok)` narrows back to what the action returned.
 */
export const attempt = attemptIn("users", {
  sessionEnded: "sessionEnded",
  requestFailed: "requestFailed",
});
