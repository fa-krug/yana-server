"use server";

import fs from "node:fs/promises";

import { eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ADMIN_ROLES, isAdminRole } from "@/lib/auth/roles";
import { createUserWithPassword } from "@/lib/auth/server";
import { refreshSession, requireAdmin } from "@/lib/auth/session";
import { avatarFilePath } from "@/lib/avatar-storage";
import { getDb, writeTransaction } from "@/lib/db/client";
import { users, userSettings } from "@/lib/db/schema";

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, STANDARD_ROLE } from "./fields";
import { countUsableAdmins, countUserImpact } from "./queries";
import type { CreateUserResult, DeleteUsersResult, UsersKey, UsersResult } from "./result";

/**
 * Everything the admin-only users tab writes.
 *
 * Five rules hold across every action here.
 *
 * 1. **`requireAdmin()` first, and the acting id comes from it.** No action
 *    takes the caller's id as an argument; there is nothing to forge. It reads
 *    the session with `disableCookieCache: true`, so an administrator demoted a
 *    minute ago is not one here, and it answers 404 rather than 403.
 * 2. **The result carries a catalog `errorKey`**, never a zod, driver or Better
 *    Auth message -- see `./result`, and the same rule in
 *    `@/lib/account/actions` and `@/lib/settings/actions`.
 * 3. **Three refusals, and each of them is a lockout if it is wrong**: an
 *    administrator may not delete their own account, may not clear their own
 *    administrative role, and may not remove the last account that could still
 *    administer the instance. There is no self-registration, no mail transport
 *    and no CLI here, so the way back from any of the three would be editing
 *    SQLite by hand.
 * 4. **Every write goes through `writeTransaction()`** with a synchronous
 *    callback (CLAUDE.md), and the two checks that decide a refusal are made
 *    *inside* that transaction. Outside it they are advisory: two admins
 *    deleting each other at the same moment both read "one admin remains" and
 *    both proceed.
 * 5. **No `/admin/*` endpoint is used.** Every one of them is in `disabledPaths`
 *    in `@/lib/auth/server`, each for a reason written there -- `create-user`
 *    writes no `user_settings` row, `update-user` is an arbitrary-column write,
 *    `set-role` is what put a comma list in the column in the first place.
 *    Accounts are created through `createUserWithPassword()`, which is not
 *    routable, and everything else is a Drizzle write.
 *
 * A sixth rule belongs to the *callers*: none of these may be awaited bare from
 * a client component. See `attempt()` in `@/lib/account/result`.
 *
 * **Deliberately absent: setting another user's password.** The phase plan
 * declines it, and the reason still holds -- with no mail transport an admin
 * would be choosing a password they then have to convey out of band. A user
 * with no way in is repaired by deleting and recreating the account.
 */

/**
 * The role values a form may submit: every administrative role the plugin is
 * configured with, plus the standard one. Built from `ADMIN_ROLES` so there is
 * no second literal `"admin"` to drift from `@/lib/auth/roles`.
 *
 * An allow-list rather than a free string, even though only `isAdminRole()`
 * reads the column: a typo'd role is silently non-administrative, and "I set
 * them to admin and it did nothing" is a bug report nobody can reproduce.
 */
const ROLE_VALUES: string[] = [...ADMIN_ROLES, STANDARD_ROLE];

/**
 * The columns both forms write. `.trim()` before the length checks, so " " is
 * an empty name rather than a one-character one -- the two name columns are
 * `notNull` with `""` defaults and `displayNameFor()` reads `""` as "fall back
 * to the address".
 *
 * Every field is required, including on the edit form: a partial patch cannot
 * distinguish "clear the last name" from "leave it alone", and the form posts
 * all of them anyway.
 */
const identity = z.object({
  email: z.email().max(254),
  firstName: z.string().trim().max(150),
  lastName: z.string().trim().max(150),
  role: z.string().refine((role) => ROLE_VALUES.includes(role)),
});

const creation = identity.extend({
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

/**
 * A bulk selection. The cap is not paranoia about the operator: every id is a
 * bound parameter, and SQLite refuses a statement with more than 32766 of them,
 * so an unbounded list turns a crafted request into a driver error instead of a
 * refusal.
 */
const selection = z.array(z.string().min(1).max(255)).max(1000);

/**
 * Which field failed, as a catalog key. Anything unlisted falls through to
 * `undefined` and the caller shows the generic `users.saveFailed`, exactly as
 * the settings and account actions do.
 */
const FIELD_ERROR_KEYS: Record<string, UsersKey> = {
  email: "emailInvalid",
  firstName: "nameTooLong",
  lastName: "nameTooLong",
  role: "roleInvalid",
  password: "passwordTooShort",
};

function errorKeyFor(issues: z.core.$ZodIssue[]): UsersKey | undefined {
  const field = issues[0]?.path[0];
  return typeof field === "string" ? FIELD_ERROR_KEYS[field] : undefined;
}

/**
 * Is this the unique-index violation on `users.email`?
 *
 * Matched on better-sqlite3's `code` rather than on its message, which is
 * English prose from the driver and exactly the kind of string rule 2 forbids
 * returning; the column check keeps it from also swallowing a future unique
 * index on the same table. The twin of `isEmailTaken()` in
 * `@/lib/account/actions` -- duplicated rather than shared because that module
 * is `"use server"` and can export nothing but async functions.
 */
function isEmailTaken(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = (error as { message?: unknown } | null)?.message;
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" &&
    typeof message === "string" &&
    message.includes("users.email")
  );
}

function emailExists(email: string): boolean {
  return (
    getDb().select({ id: users.id }).from(users).where(eq(users.email, email)).get() !== undefined
  );
}

/**
 * Better Auth's display name, which is also what the browser's passkey chooser
 * shows. Written alongside the two columns for the same reason `/account` does
 * it: left at its creation value it goes stale in the OS credential UI, where
 * nothing in this application can correct it.
 */
function displayName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim();
}

/**
 * Remove the avatar files of users who no longer exist.
 *
 * **The cascade cannot reach the filesystem.** Deleting the row takes
 * `users.image` with it, but `src/app/media/avatars/[userId]/route.ts` serves
 * whatever is on disk and never reads that column -- the same asymmetry
 * `removeAvatar()` in `@/lib/account/actions` exists to close. Nothing can
 * fetch the leftover (the route compares the requested id against the caller's
 * session, and the deleted user has none), so this is orphaned storage rather
 * than an exposure -- but a media directory that only ever grows is a defect
 * with a slow fuse.
 *
 * Best effort, after the transaction has committed: better-sqlite3 is
 * synchronous and `writeTransaction()`'s callback may not await, and a failed
 * unlink must not undo a delete the operator has already been told about. Every
 * failure is logged with the id, which is all that is needed to clean up by
 * hand. Safe for ids that were never deleted, because an id the statement did
 * not match did not exist -- and `avatarFilePath()` refuses anything that is
 * not shaped like one of Better Auth's ids rather than building a path from it.
 */
async function discardAvatars(ids: string[]): Promise<void> {
  for (const id of ids) {
    const file = avatarFilePath(id);
    if (!file) continue;
    try {
      await fs.rm(file, { force: true });
    } catch (error) {
      console.error(`Failed to remove the avatar file of the deleted user "${id}"`, error);
    }
  }
}

/**
 * Create a user.
 *
 * **Through `createUserWithPassword()`, never `auth.api.signUpEmail`**:
 * `disableSignUp: true` makes that endpoint refuse everyone, by design. The
 * seam hashes with Better Auth's own scrypt and writes the `accounts`
 * credential row, so the result is indistinguishable from a signed-up user and
 * can actually sign in -- the phase-3 seeder that wrote a bare `users` row
 * could not, and no row-shape assertion catches that.
 *
 * **The `user_settings` row is this function's job.** Nothing else creates one
 * (`/admin/create-user` not writing it is one of the three reasons that
 * endpoint is closed), `getSettings()` throws when it is absent and is
 * deliberately not self-healing, so a user provisioned without one meets the
 * error boundary on `/settings` forever. It cannot be one transaction with the
 * account -- `createUserWithPassword()` awaits, and `writeTransaction()`'s
 * callback may not -- so a failure between the two is repaired by removing the
 * account rather than leaving one that half exists. The id is known here, so
 * that deletion is precise; contrast `completeDefaultAdmin()`, which has to
 * find its subject by address.
 */
export async function createUser(input: unknown): Promise<CreateUserResult> {
  await requireAdmin();
  const parsed = creation.safeParse(input);
  if (!parsed.success) return { ok: false, errorKey: errorKeyFor(parsed.error.issues) };
  const { email, password, firstName, lastName, role } = parsed.data;

  // Checked before creating rather than only in the catch below. `users.email`
  // is unique, so a taken address has nothing to create, and recovering from
  // the constraint instead would mean interpreting an error the Drizzle adapter
  // and Better Auth have both already wrapped (see `./bootstrap`'s note).
  if (emailExists(email)) return { ok: false, errorKey: "emailTaken" };

  let id: string;
  try {
    const user = await createUserWithPassword({
      email,
      password,
      name: displayName(firstName, lastName),
      firstName,
      lastName,
      role,
    });
    id = user.id;
  } catch (error) {
    console.error("Failed to create a user", error);
    return { ok: false };
  }

  try {
    writeTransaction((tx) => {
      tx.insert(userSettings).values({ userId: id }).run();
    });
  } catch (error) {
    console.error(`Failed to create the settings row for "${id}"; removing the account`, error);
    try {
      writeTransaction((tx) => {
        tx.delete(users).where(eq(users.id, id)).run();
      });
    } catch (cleanupError) {
      console.error(
        `Left a user with no user_settings row behind: "${id}" (${email}). Their ` +
          `/settings will throw until the row is created or the account is deleted.`,
        cleanupError,
      );
    }
    return { ok: false };
  }

  revalidatePath("/users", "layout");
  return { ok: true, id };
}

/**
 * Edit a user's address, name and role.
 *
 * **Not through Better Auth's `/update-user` or `/admin/update-user`**, both of
 * which are closed: the first takes an arbitrary `image`, the second an
 * arbitrary column. A direct write is the sanctioned path, and it is the only
 * one that keeps the two `additionalFields`, the address and the role in a
 * single transaction.
 *
 * Two refusals live here, and the second is the one that is easy to miss:
 * clearing your *own* administrative role locks you out of this very page, and
 * clearing the *last usable* administrator's locks everyone out. The self check
 * is first because it is the one an operator can hit by accident.
 */
export async function updateUser(id: string, input: unknown): Promise<UsersResult> {
  const actor = await requireAdmin();
  const parsed = identity.safeParse(input);
  if (!parsed.success) return { ok: false, errorKey: errorKeyFor(parsed.error.issues) };
  const { email, firstName, lastName, role } = parsed.data;

  const self = id === actor.id;
  if (self && !isAdminRole(role)) return { ok: false, errorKey: "demoteSelf" };

  let outcome: "ok" | "notFound" | "lastAdmin";
  try {
    outcome = writeTransaction((tx) => {
      const before = tx.select({ role: users.role }).from(users).where(eq(users.id, id)).get();
      if (!before) return "notFound";

      // Read inside the transaction: outside it, two administrators demoting
      // each other at the same moment both see one left and both proceed.
      const demotion = isAdminRole(before.role) && !isAdminRole(role);
      if (demotion && countUsableAdmins([], tx) > 0 && countUsableAdmins([id], tx) === 0) {
        return "lastAdmin";
      }

      tx.update(users)
        .set({ email, firstName, lastName, name: displayName(firstName, lastName), role })
        .where(eq(users.id, id))
        .run();
      return "ok";
    });
  } catch (error) {
    if (isEmailTaken(error)) return { ok: false, errorKey: "emailTaken" };
    console.error("Failed to update a user", error);
    return { ok: false };
  }

  if (outcome !== "ok") return { ok: false, errorKey: outcome };

  if (self) {
    // The same trap `/account` documents: `currentUser()` is served from a
    // five-minute signed cookie, so an administrator who edits their own row
    // here would otherwise see the old name in the sidebar -- and in the
    // passkey chooser -- until it expired. Only for their own row: refreshing
    // the session after editing somebody else would re-read a session that did
    // not change.
    await refreshSession();
    // Layout-wide, because the sidebar footer renders this user on every route.
    revalidatePath("/", "layout");
  } else {
    revalidatePath("/users", "layout");
  }
  return { ok: true };
}

/**
 * What deleting these users would take with it: feeds, tags and articles.
 *
 * A read, and it still lives in this `"use server"` module rather than in
 * `./queries`, because its caller is the bulk-delete confirmation in a
 * **client** component -- the selection exists only in the browser, so the
 * count has to be fetchable from there, and only an action is. The SQL is in
 * `countUserImpact()`; this is the gate and the endpoint.
 *
 * Zeros for an empty selection rather than a refusal: the confirmation copy is
 * the caller here, and it has nothing to tell the operator about a set it has
 * not built yet.
 */
export async function userImpact(
  ids: string[],
): Promise<{ feeds: number; tags: number; articles: number }> {
  await requireAdmin();

  const parsed = selection.safeParse(ids);
  if (!parsed.success) {
    console.error("Refused a malformed user selection", parsed.error.issues);
    return { feeds: 0, tags: 0, articles: 0 };
  }

  return countUserImpact([...new Set(parsed.data)]);
}

/**
 * Delete users, with their feeds, tags, articles and settings.
 *
 * The refusals are checked **before anything is deleted**, and in this order:
 * the acting administrator is in the set, then the set would empty the instance
 * of administrators who can still sign in. Nothing is deleted partially -- one
 * refused id refuses the whole call, because a bulk delete that removed four of
 * five rows and then reported a failure would leave the operator guessing.
 *
 * The cascade does the rest, and it is real only because `foreign_keys = ON` is
 * in `applyPragmas()`: `feeds`, `tags` and `user_settings` reference `users`,
 * and `articles` references `feeds`, so the chain runs twice to reach an
 * article. Without the PRAGMA every one of those rows would be orphaned
 * silently.
 */
export async function deleteUsers(ids: string[]): Promise<DeleteUsersResult> {
  const actor = await requireAdmin();

  const parsed = selection.safeParse(ids);
  if (!parsed.success) {
    console.error("Refused a malformed user selection", parsed.error.issues);
    return { ok: false, deleted: 0 };
  }

  const selected = [...new Set(parsed.data)];
  if (selected.length === 0) return { ok: false, errorKey: "noneSelected", deleted: 0 };
  if (selected.includes(actor.id)) return { ok: false, errorKey: "deleteSelf", deleted: 0 };

  let outcome: { refused: UsersKey } | { deleted: number };
  try {
    outcome = writeTransaction((tx) => {
      /**
       * "Would this leave nobody able to administer the instance?"
       *
       * Both counts are taken here rather than one, because an instance that
       * *already* has no usable administrator must not have an ordinary
       * deletion refused with a message about the last admin -- the deletion is
       * not what broke it, and refusing would remove the only way to clean up.
       *
       * With the self-check above already passed, the acting administrator is
       * never in `selected`, so this can only fire when they do not count
       * themselves: banned (Better Auth refuses a banned user a new session but
       * leaves an issued one working), or removed by another process between
       * `requireAdmin()` and this transaction. That is precisely why the count
       * is in here and not above.
       */
      if (countUsableAdmins([], tx) > 0 && countUsableAdmins(selected, tx) === 0) {
        return { refused: "lastAdmin" as const };
      }
      return { deleted: tx.delete(users).where(inArray(users.id, selected)).run().changes };
    });
  } catch (error) {
    console.error("Failed to delete users", error);
    return { ok: false, deleted: 0 };
  }

  if ("refused" in outcome) return { ok: false, errorKey: outcome.refused, deleted: 0 };

  await discardAvatars(selected);
  revalidatePath("/users", "layout");
  return { ok: true, deleted: outcome.deleted };
}
