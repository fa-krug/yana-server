import type { NamespaceKey } from "@/i18n/next-intl";

/**
 * What every action in `./actions` returns.
 *
 * **Not part of `./actions`, deliberately** -- the same reason
 * `src/lib/account/result.ts` is a separate module: `./actions` carries the
 * `"use server"` directive, so every one of its exports has to be an async
 * function Next can expose as an endpoint. A type or a constant cannot live
 * there at all.
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

export type UsersResult = { ok: boolean; errorKey?: UsersKey };

/** `createUser` additionally reports the id it minted, for a redirect. */
export type CreateUserResult = UsersResult & { id?: string };

/** `deleteUsers` additionally reports how many rows actually went. */
export type DeleteUsersResult = UsersResult & { deleted: number };
