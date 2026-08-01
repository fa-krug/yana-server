import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { ADMIN_ROLE, ADMIN_ROLES } from "@/lib/auth/roles";
import { requireAdmin } from "@/lib/auth/session";
import type { ListParams } from "@/lib/crud/params";
import { getDb } from "@/lib/db/client";
import { articles, feeds, tags, type User, users } from "@/lib/db/schema";

/**
 * Reads for the admin-only users tab. Writes are in `./actions`.
 *
 * **Every exported query calls `requireAdmin()` first**, even though the pages
 * that consume them do too. It is one indexed session read against the same
 * local file, and it means the gate cannot be lost by a route being added
 * without it -- the same defence-in-depth `/account`'s queries get from
 * `currentUserRow()`. `requireAdmin()` answers 404 rather than 403, so a
 * non-admin never learns the route exists.
 */

/**
 * The role a user has when they are not an administrator.
 *
 * Mirrors `admin({ defaultRole: "user" })` in `@/lib/auth/server`, the SQL
 * default on `users.role`, and `createUserWithPassword()`'s own `?? "user"`.
 * It is not in `@/lib/auth/roles` because nothing *authorizes* on it: only
 * `isAdminRole()` decides anything, and this is just the value written when the
 * answer is "no". Pinned by `users.test.ts`, which asserts a user created
 * without a role comes back non-admin.
 */
export const STANDARD_ROLE = "user";

/**
 * The role filter's two URL values. `""` (or an unrecognised value) means no
 * filter at all -- Task 2's kit clears a filter by setting it to `""`.
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
 * The columns the list renders, and no more.
 *
 * A `User` also carries `emailVerified`, `updatedAt` and the three ban columns.
 * `<DataTable>` is a client component, so the row is serialized into the RSC
 * payload of every page that renders it -- CLAUDE.md's "a component gets the
 * columns it renders, never the row". `image` and the two name columns are here
 * because `<UserAvatar>` needs them; `role` because the admin badge does.
 */
export type UserListRow = Pick<
  User,
  "id" | "name" | "firstName" | "lastName" | "email" | "image" | "role" | "createdAt"
>;

const LIST_COLUMNS = {
  id: users.id,
  name: users.name,
  firstName: users.firstName,
  lastName: users.lastName,
  email: users.email,
  image: users.image,
  role: users.role,
  createdAt: users.createdAt,
};

/**
 * Which columns a `sort` may name. Anything else falls back to `createdAt`.
 *
 * A whitelist rather than a lookup by string: `sort` comes from the URL, and
 * handing an arbitrary string to the query builder is how an injection or a
 * crash gets in.
 */
const SORTABLE: Record<string, SQLiteColumn> = {
  name: users.name,
  email: users.email,
  role: users.role,
  createdAt: users.createdAt,
};

/** `%` and `_` are LIKE wildcards; a search term must not carry them as such. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function contains(column: SQLiteColumn, term: string): SQL {
  return sql`${column} LIKE ${`%${escapeLike(term)}%`} ESCAPE '\\'`;
}

/**
 * SQL that answers the same question `isAdminRole()` answers, for every value
 * the column can hold.
 *
 * **This is the one place the comma-list rule is expressed twice**, and it is
 * done this way because the alternative is worse: filtering in JavaScript makes
 * `LIMIT`/`OFFSET` and `COUNT(*)` impossible without loading the whole table,
 * which is what the list query exists to avoid. So the *semantics* are
 * reproduced exactly rather than approximated --
 * `instr(',' || role || ',', ',admin,')` is a byte-exact search for one whole
 * comma-delimited part, which is `role.split(",").includes("admin")` and
 * nothing looser:
 *
 * - `"user,admin"` matches, exactly as Better Auth's `hasPermission()` reads it;
 * - `"administrator"` does **not**, because the trailing comma is missing;
 * - `"user, admin"` does **not**, because the parts are not trimmed -- the
 *   library does not trim either, and agreeing exactly is the property;
 * - `instr()` is case-sensitive (unlike `LIKE`), so `"ADMIN"` does not match,
 *   which is again what `isAdminRole()` says.
 *
 * The roles come from `ADMIN_ROLES`, so there is no literal `"admin"` here to
 * drift from the plugin's configuration. `users.test.ts` seeds every one of the
 * values above and asserts the filter's output equals `isAdminRole()`'s over
 * the same rows -- if these two ever disagree, that test fails rather than the
 * sidebar quietly hiding `/users` from an administrator.
 */
const HAS_ADMIN_ROLE: SQL = sql`(${ADMIN_ROLES.map(
  (role) => sql`instr(',' || ${users.role} || ',', ${`,${role},`}) > 0`,
).reduce<SQL>((left, right) => sql`${left} OR ${right}`, sql`0`)})`;

const HAS_NO_ADMIN_ROLE: SQL = sql`NOT ${HAS_ADMIN_ROLE}`;

/**
 * Can this account actually administer the instance right now?
 *
 * The role is only half of it: Better Auth refuses to create a session for a
 * banned user (`session.create.before` in `plugins/admin/admin.mjs`), so an
 * instance whose only administrator is banned has none in the sense that
 * matters. An *expired* ban does count as unbanned, because that same hook
 * lifts it on the next sign-in rather than refusing. Identical to
 * `isUsableAdmin()` in `@/lib/auth/bootstrap`, which decides the same question
 * for the startup bootstrap -- the two must agree, or a delete this module
 * allows becomes an instance the next boot has to repair.
 *
 * A function, not a constant: `new Date()` in a module-level expression is
 * frozen at import, so a long-running server would go on comparing every ban
 * against the moment it booted.
 */
function isUsableAdmin(): SQL | undefined {
  return and(
    HAS_ADMIN_ROLE,
    or(eq(users.banned, false), and(isNotNull(users.banExpires), lt(users.banExpires, new Date()))),
  );
}

/**
 * How many administrators would still be able to sign in if `excludedIds` were
 * gone.
 *
 * Not gated: it is an internal helper for `./actions`, whose callers have
 * already passed `requireAdmin()`. It takes the database handle so a caller can
 * pass the transaction's -- and `deleteUsers()` does, because a count taken
 * *outside* the write transaction can be stale by the time the delete lands.
 */
export function countUsableAdmins(excludedIds: string[], db = getDb()): number {
  const usable = isUsableAdmin();
  const row = db
    .select({ value: count() })
    .from(users)
    .where(excludedIds.length ? and(usable, notInArray(users.id, excludedIds)) : usable)
    .get();

  return row?.value ?? 0;
}

/**
 * One page of users, plus the total the page was cut from.
 *
 * Both halves run in SQL: `LIMIT`/`OFFSET` for the page and a `COUNT(*)` over
 * the same `WHERE` for the total. Filtering or paging in JavaScript would mean
 * reading every row of a table this application never bounds.
 *
 * `users.id` is always the final `ORDER BY` term. Without a tie-breaker two
 * rows with the same `createdAt` (the bootstrap admin and a user created in the
 * same second) can come back in a different order on each page, which shows one
 * row twice and hides another.
 */
export async function listUsers(
  params: ListParams,
): Promise<{ rows: UserListRow[]; total: number }> {
  await requireAdmin();
  const db = getDb();

  const term = params.q.trim();
  const search = term
    ? or(
        contains(users.email, term),
        contains(users.name, term),
        contains(users.firstName, term),
        contains(users.lastName, term),
      )
    : undefined;

  const role = params.filters.role;
  const roleFilter =
    role === ROLE_FILTER_ADMIN
      ? HAS_ADMIN_ROLE
      : role === ROLE_FILTER_STANDARD
        ? HAS_NO_ADMIN_ROLE
        : undefined;

  const where = and(search, roleFilter);

  const column = SORTABLE[params.sort] ?? users.createdAt;
  const direction = params.dir === "desc" ? desc : asc;

  const rows = db
    .select(LIST_COLUMNS)
    .from(users)
    .where(where)
    .orderBy(direction(column), asc(users.id))
    .limit(params.pageSize)
    .offset((params.page - 1) * params.pageSize)
    .all();

  const total = db.select({ value: count() }).from(users).where(where).get()?.value ?? 0;

  return { rows, total };
}

/**
 * One user, whole.
 *
 * The full row rather than `UserListRow`: the caller is the edit page, a server
 * component, which picks the fields its form component receives. That is the
 * same rule the list query obeys from the other end -- the projection belongs
 * wherever the row crosses into a client component.
 */
export async function getUser(id: string): Promise<User | null> {
  await requireAdmin();
  return getDb().select().from(users).where(eq(users.id, id)).get() ?? null;
}

/**
 * What deleting these users would take with it.
 *
 * The read behind `userImpact()` in `./actions`, which is where the exported
 * entry point lives: the bulk-delete confirmation is built in a **client**
 * component from a selection that only exists in the browser, so the callable
 * form has to be a server action, and a `"use server"` module can export
 * nothing but async functions. Keeping the SQL here means `./actions` stays a
 * module of writes plus one delegation.
 *
 * **Articles are counted through a join, not a `WHERE`**: `articles` has no
 * `userId`. It references `feeds`, which references `users`, both with
 * `onDelete: "cascade"`, so a user's articles are owned transitively and the
 * cascade chains twice -- which is why the count has to as well.
 */
export function countUserImpact(ids: string[]): {
  feeds: number;
  tags: number;
  articles: number;
} {
  if (ids.length === 0) return { feeds: 0, tags: 0, articles: 0 };

  const db = getDb();

  const feedCount =
    db.select({ value: count() }).from(feeds).where(inArray(feeds.userId, ids)).get()?.value ?? 0;
  const tagCount =
    db.select({ value: count() }).from(tags).where(inArray(tags.userId, ids)).get()?.value ?? 0;
  const articleCount =
    db
      .select({ value: count() })
      .from(articles)
      .innerJoin(feeds, eq(articles.feedId, feeds.id))
      .where(inArray(feeds.userId, ids))
      .get()?.value ?? 0;

  return { feeds: feedCount, tags: tagCount, articles: articleCount };
}
