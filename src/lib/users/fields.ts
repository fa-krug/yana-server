import { ADMIN_ROLE } from "@/lib/auth/roles";

/**
 * The values both user forms are built from, in one module a **client**
 * component may import.
 *
 * **This module reaches nothing but `@/lib/auth/roles`, and it must stay that
 * way.** It is the `@/lib/avatar` to `./queries`'s `@/lib/avatar-storage`: the
 * role select's `items` list and the password field's `minLength` are built in
 * a client component, and every one of these constants used to live beside
 * `getDb()` and `requireAdmin()` -- so importing one dragged `better-sqlite3`
 * into the browser bundle. The failure is an opaque bundler error rather than
 * the stated rule, which is why the `no-restricted-imports` group in
 * `eslint.config.mjs` now covers this shape too, not just avatar-storage: a
 * second pattern (added by this phase's fix wave) matches any feature's
 * `queries` module one directory under `lib`, restricted the same way from
 * `src/components/**`, with `allowTypeImports` on for both patterns -- a value
 * import from either is a lint error, an `import type` for a row projection is
 * not.
 *
 * `@/lib/auth/roles` is the one dependency allowed here, and it is the same
 * exception CLAUDE.md already grants it: it imports nothing, and it is the
 * single source for what an administrative role is. Spelling `"admin"` again
 * to avoid the import would be the drift bug that module exists to prevent.
 *
 * The numbers are here for the same reason `AVATAR_MAX_*` are in
 * `@/lib/avatar`: so the page can **state** them. `users.passwordTooShort`
 * interpolates `{min}`, and a form that cannot read the minimum either
 * hard-codes a second copy of it or shows a message with the placeholder in it.
 * `./actions` still applies them -- a caller cannot forget what it never had to
 * remember.
 */

/**
 * The role a user has when they are not an administrator.
 *
 * Mirrors `admin({ defaultRole: "user" })` in `@/lib/auth/server`, the SQL
 * default on `users.role`, and `createUserWithPassword()`'s own `?? "user"`.
 * It is deliberately not in `@/lib/auth/roles`, because nothing *authorizes* on
 * it: only `isAdminRole()` decides anything, and this is just the value written
 * when the answer is "no". Pinned by `users.test.ts`, which asserts a user
 * created with it comes back non-admin.
 */
export const STANDARD_ROLE = "user";

/**
 * The role filter's two URL values. `""` -- or anything unrecognised -- means no
 * filter at all, which is how Task 2's kit clears one.
 *
 * `admin` is spelled from `ADMIN_ROLE` so the URL token and the role cannot
 * drift apart. `standard` deliberately is **not** `STANDARD_ROLE`: it selects
 * the *absence of administrative authority*, not one particular role string, so
 * a hypothetical `"editor"` or `"user,viewer"` is standard too. The two halves
 * partition the table exactly -- `users.test.ts` asserts that against
 * `isAdminRole()` itself rather than against a restatement of the rule.
 */
export const ROLE_FILTER_ADMIN = ADMIN_ROLE;
export const ROLE_FILTER_STANDARD = "standard";

/**
 * Better Auth's own password bounds, restated so a rejection is a translated
 * sentence rather than an English `PASSWORD_TOO_SHORT` from the library. `8` is
 * `minPasswordLength`'s default (`context/create-context.mjs`), the same pair
 * and the same reasoning as `@/lib/account/actions`; a change to the
 * `emailAndPassword` config has to change this line too, and `users.test.ts`
 * proves the account this creates can actually sign in, which is what would
 * fail if the library's minimum moved above it.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
