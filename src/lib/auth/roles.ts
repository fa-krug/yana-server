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
 * **The column holds a comma-separated *list*, not a single role, and this
 * function has to read it the same way the plugin does.** Better Auth's
 * `hasPermission()` (`better-auth/dist/plugins/admin/has-permission.mjs`) does
 * `(role || defaultRole).split(",")` and grants if *any* part matches; its
 * `/admin/impersonate-user` handler does the same. Testing the whole string for
 * equality -- which this did until the phase-4 review -- makes the two
 * mechanisms disagree the moment anything writes a list: `"user,admin"` is an
 * administrator to every Better Auth endpoint and was a plain user to this
 * application, so the sidebar hid `/users` from someone the library still let
 * call `/admin/list-users`, and `adminExists()` reported "no admin" for an
 * instance that had one. That second half is what could brick a boot
 * permanently; see `./bootstrap`.
 *
 * Parts are **not** trimmed, deliberately: neither of the two library call
 * sites above trims either, so `"user, admin"` (with a space) is *not* an
 * administrator to Better Auth, and trimming here would make this application
 * the more permissive of the two. Agreeing exactly is the whole point --
 * `src/lib/auth/roles.test.ts` pins that agreement against the plugin's own
 * `/admin/has-permission` rather than against a restatement of the rule.
 *
 * Tolerates null/undefined because Better Auth types `role` as optional even
 * though the column is `NOT NULL` -- a session user that somehow arrives
 * without one is not an admin.
 */
export function isAdminRole(role: string | null | undefined): boolean {
  if (typeof role !== "string") return false;
  return role.split(",").some((part) => ADMIN_ROLES.includes(part));
}
