/**
 * The authorization model, in one dependency-free module.
 *
 * `role` -- not a boolean -- is what decides who may administer this instance
 * (see the comment on `users.role` in `src/lib/db/schema/users.ts`). The array
 * below is fed *into* the `admin()` plugin in `./server` rather than written
 * twice: anything asking "is this user an admin" (`ensureAdminExists()`, the
 * sidebar's admin-only items, `requireAdmin()`, every later authorization
 * check) has to agree with the plugin's own `adminRoles`, and a second literal
 * `"admin"` somewhere else is exactly how those drift. The array is
 * deliberately mutable-typed -- `admin()` takes `string[]`, and an `as const`
 * tuple would need a spread at the call site, which is another copy.
 *
 * **This module imports nothing, and it must stay that way.** It is the one
 * piece of the auth stack that non-server code may read: the jsdom component
 * tests and any future client component get the real predicate instead of a
 * reimplementation, and importing it can never reach `better-sqlite3` (which
 * `./server` does, transitively, and which is unavailable in the edge runtime
 * and expensive in a DOM test).
 */
export const ADMIN_ROLE = "admin";
export const ADMIN_ROLES: string[] = [ADMIN_ROLE];

/**
 * Does this `users.role` value carry administrative authority?
 *
 * Tolerates null/undefined because Better Auth types `role` as optional even
 * though the column is `NOT NULL` -- a session user that somehow arrives
 * without one is not an admin.
 */
export function isAdminRole(role: string | null | undefined): boolean {
  return typeof role === "string" && ADMIN_ROLES.includes(role);
}
