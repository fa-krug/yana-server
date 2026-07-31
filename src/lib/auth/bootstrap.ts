import { and, eq } from "drizzle-orm";

import { getDb, writeTransaction } from "@/lib/db/client";
import { accounts, passkeys, userSettings, users } from "@/lib/db/schema";

import { ADMIN_ROLE, isAdminRole } from "./roles";
import { createUserWithPassword, linkPasswordCredential } from "./server";

/**
 * The account a fresh instance boots with. Both values are printed by the
 * startup warning below -- they are a first-login credential, not a secret, and
 * that warning is the only thing prompting a rotation, since nothing in the app
 * forces one.
 */
const DEFAULT_EMAIL = "admin@admin.com";
const DEFAULT_PASSWORD = "admin";

/**
 * Is this row an administrator who could actually administer the instance?
 *
 * Two halves, and both were bugs the phase-4 whole-branch review found.
 *
 * **The role is read through `isAdminRole()`**, never with SQL equality. The
 * `admin()` plugin treats `users.role` as a comma-separated *list*, so
 * `"user,admin"` -- which its own `/admin/set-role` would happily write -- is
 * an administrator to every Better Auth endpoint. An `inArray(users.role,
 * ADMIN_ROLES)` test says otherwise, and the disagreement is not cosmetic: this
 * function decides whether to *create* `admin@admin.com`, the address a `users`
 * row already holds, so a false answer is a `users_email_unique` violation at
 * startup and a server that never boots again.
 *
 * **A banned admin does not count.** The plugin refuses to create a session for
 * one (`plugins/admin/admin.mjs`, the `session.create.before` hook), so an
 * instance whose only administrator is banned has no administrator in the only
 * sense that matters. An *expired* ban does count as unbanned, because that
 * same hook lifts it on the next sign-in rather than refusing.
 *
 * Plain reads throughout this module, no writeTransaction(): that helper is for
 * writes.
 */
function isUsableAdmin(row: { role: string; banned: boolean; banExpires: Date | null }): boolean {
  if (!isAdminRole(row.role)) return false;
  if (!row.banned) return true;
  return row.banExpires !== null && row.banExpires.getTime() < Date.now();
}

/**
 * Is there any usable administrator at all?
 *
 * Keyed on the *role*, never on `DEFAULT_EMAIL`. An operator who renames or
 * deletes the default account has made a decision, and an email-keyed check
 * would undo it on the next restart -- handing back an account with a published
 * password that the operator believes is gone. `ADMIN_ROLES` comes from
 * `./roles`, which is also what the `admin()` plugin is configured with in
 * `./server`, so this cannot drift from the plugin's own notion of an admin.
 *
 * The role test happens in JavaScript rather than in the `WHERE` clause because
 * comma-list membership is what `isAdminRole()` implements and duplicating it
 * as SQL is exactly the drift this module is written to avoid. The cost is a
 * scan of `users`, once per server start, on a table a self-hosted instance
 * measures in tens of rows.
 */
function adminExists(): boolean {
  return getDb()
    .select({ role: users.role, banned: users.banned, banExpires: users.banExpires })
    .from(users)
    .all()
    .some(isUsableAdmin);
}

/** The default account's row, whatever role it currently holds. */
function findDefaultAdmin():
  { id: string; role: string; banned: boolean; banExpires: Date | null } | undefined {
  return getDb()
    .select({
      id: users.id,
      role: users.role,
      banned: users.banned,
      banExpires: users.banExpires,
    })
    .from(users)
    .where(eq(users.email, DEFAULT_EMAIL))
    .get();
}

/** The default account, but only while it is still a usable administrator. */
function findDefaultAdminId(): string | undefined {
  const row = findDefaultAdmin();
  return row && isUsableAdmin(row) ? row.id : undefined;
}

function hasPasswordCredential(userId: string): boolean {
  return (
    getDb()
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
      .get() !== undefined
  );
}

function hasPasskey(userId: string): boolean {
  return (
    getDb().select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, userId)).get() !==
    undefined
  );
}

function hasSettings(userId: string): boolean {
  return (
    getDb()
      .select({ id: userSettings.id })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .get() !== undefined
  );
}

/**
 * Finish provisioning the default admin if an earlier attempt did not.
 *
 * Creating it is **three** writes -- the user, its credential, its settings row
 * -- and nothing makes them one unit: `createUserWithPassword()` awaits between
 * the first two, and `writeTransaction()`'s callback cannot await at all. A
 * crash, a disk error or a failure in between leaves a partial account that
 * `adminExists()` happily counts, so without this pass every later boot would
 * early-return past the damage: an "admin" that cannot sign in, or one whose
 * missing `user_settings` row makes `getSettings()` throw on every page.
 * Permanently, with nothing able to repair it.
 *
 * Scoped to `DEFAULT_EMAIL` on purpose. This completes **the account this module
 * creates**, never somebody else's: handing a published password to an
 * administrator phase 5 created, or one an operator renamed, would be a hole
 * rather than a repair. Same reason it skips a user who has a passkey -- that is
 * a deliberate passwordless account, not an interrupted one.
 *
 * The narrow consequence, worth knowing before deleting a row by hand: an admin
 * still sitting at `admin@admin.com` with neither a credential nor a passkey
 * gets the default password back on the next boot. Renaming the account -- the
 * same action that stops it being recreated at all -- makes this pass ignore it
 * forever.
 *
 * This is *not* a relaxation of "no insert-if-absent": that rule governs the
 * read path, where `getSettings()` still throws loudly rather than papering over
 * a provisioning bug. This is the provisioning path checking its own work.
 */
async function completeDefaultAdmin(): Promise<void> {
  const adminId = findDefaultAdminId();
  if (!adminId) return;

  /**
   * The veto: an account with a passkey is passwordless *on purpose*.
   *
   * **Constraint on any future auth provider.** "Can this account sign in" is
   * decided here by looking at exactly two things -- a `credential` row in
   * `accounts`, and the `passkeys` table. A phase that adds a social provider
   * makes that incomplete: an admin at this address whose only login is OAuth
   * reads as "no way to sign in", and this pass would mint the published
   * password back for them. Whoever adds a provider must widen this check to
   * include it (a non-`credential` `accounts` row is the natural test).
   */
  if (!hasPasswordCredential(adminId) && !hasPasskey(adminId)) {
    await linkPasswordCredential({ userId: adminId, password: DEFAULT_PASSWORD });
    console.warn(
      `Yana restored the sign-in credential for ${DEFAULT_EMAIL} (password ` +
        `"${DEFAULT_PASSWORD}"): the account existed with no way to sign in at all, ` +
        `which means an earlier bootstrap was interrupted. Change it now.`,
    );
  }

  if (!hasSettings(adminId)) {
    try {
      writeTransaction((tx) => {
        tx.insert(userSettings).values({ userId: adminId }).run();
      });
    } catch (error) {
      /**
       * `user_settings_user_unique` is the backstop for a second *process*
       * bootstrapping the same file concurrently -- the in-flight memo on
       * `ensureAdminExists()` collapses concurrent callers within one process,
       * but it cannot see across processes. Losing that race means the row
       * exists, which is all this function promised; anything else is real.
       */
      if (!hasSettings(adminId)) throw error;
    }
  }
}

/**
 * The single run in flight, so concurrent callers share one rather than racing
 * each other. Cleared when it settles -- this is **not** a permanent memo: two
 * sequential calls must each do their work, or "is idempotent" and the repair
 * cases below would pass without ever exercising the SQL they claim to test
 * (the mistake phase 3's seeder comment warned about).
 *
 * What it prevents is narrower and real: `hasPasswordCredential()` reads `false`
 * while the other caller is still inside scrypt -- a deliberately slow function,
 * so the window is wide -- and both link a credential. Two `credential` rows for
 * one user is not just duplicated password material; it also disarms Better
 * Auth's "cannot unlink your last account" guard
 * (`better-auth/dist/api/routes/account.mjs`), so an admin who changes their
 * password and then unlinks would delete the *new* row and be left signing in
 * with the published default again.
 */
let inFlight: Promise<void> | undefined;

/**
 * Ensure this instance has a usable administrator.
 *
 * Called once per server start from `src/instrumentation.ts` -- not per
 * request. Idempotent, and safe if a second caller races it.
 *
 * The account is created through `createUserWithPassword()` rather than by
 * inserting rows: that seam hashes on Better Auth's own scrypt path and writes
 * the `accounts` credential row, so the result is indistinguishable from a
 * signed-up user and can actually log in. The phase-3 seeder this replaces
 * inserted a bare `users` row with no credential at all, which could not.
 *
 * On a normal boot this is reads only -- an admin exists, and either it is not
 * the default address or it is already complete.
 */
export function ensureAdminExists(): Promise<void> {
  inFlight ??= runEnsureAdminExists().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

/**
 * Give the default account its administrator role back.
 *
 * **Reached only when the instance has no usable administrator at all** and a
 * `users` row already holds `DEFAULT_EMAIL`. Creating one is then impossible --
 * `users.email` is uniquely indexed -- so the choice is between repairing that
 * row and throwing out of `register()`, which `src/instrumentation.ts` turns
 * into `process.exit(1)`. **A server that cannot boot is the worse outcome**,
 * and it is worse in a way this application has no answer to: there is no
 * self-registration, no mail transport and no CLI, so recovery would mean
 * editing SQLite by hand. That is the same reasoning the last-passkey guard in
 * `@/lib/account/actions` is built on.
 *
 * Restores three things, all narrowly: the role (a typo, a demotion, or a
 * comma-list `/admin/set-role` wrote), and the ban columns, because a banned
 * sole administrator can no more sign in than a demoted one -- the plugin
 * refuses to create their session. It does **not** touch the password: that is
 * `completeDefaultAdmin()`'s job and only when the account has no way to sign
 * in at all, so an operator who knows this account's password keeps it.
 *
 * Two honest consequences, both loudly warned about rather than hidden:
 *
 * - If `admin@admin.com` is an *ordinary* user phase 5 created, and the real
 *   administrator was then deleted, this promotes them. Whoever holds that
 *   address becomes the administrator of an instance that had none. The
 *   alternative was refusing to boot, and the address is this application's
 *   documented default admin, not an arbitrary one.
 * - It does not fire while any other usable administrator exists, so an
 *   operator who deliberately demoted or banned this account and promoted
 *   somebody else keeps that arrangement across every restart.
 */
function restoreDefaultAdminRole(id: string): void {
  writeTransaction((tx) => {
    tx.update(users)
      .set({ role: ADMIN_ROLE, banned: false, banReason: null, banExpires: null })
      .where(eq(users.id, id))
      .run();
  });

  console.warn(
    `Yana restored the administrator role on ${DEFAULT_EMAIL}: this instance had no ` +
      `usable admin account, and that address was already taken so a new one could not ` +
      `be created. If that was not intended, promote the account you want and demote ` +
      `this one.`,
  );
}

async function runEnsureAdminExists(): Promise<void> {
  if (!adminExists()) {
    /**
     * The row is checked *before* creating, not only in the catch below.
     * `users.email` is unique, so if `DEFAULT_EMAIL` is taken there is nothing
     * to create -- attempting it and recovering from the constraint would work
     * too, but it makes the ordinary repair path run through an exception and
     * leaves a wrapped driver error to interpret.
     */
    const existing = findDefaultAdmin();
    if (existing) {
      restoreDefaultAdminRole(existing.id);
    } else {
      try {
        await createUserWithPassword({
          email: DEFAULT_EMAIL,
          password: DEFAULT_PASSWORD,
          name: "Admin",
          firstName: "Admin",
          role: ADMIN_ROLE,
        });

        console.warn(
          `Yana created the default administrator ${DEFAULT_EMAIL} with the password ` +
            `"${DEFAULT_PASSWORD}" because this instance had no admin account. Sign in ` +
            `and change it now -- until you do, anyone who can reach this server is an ` +
            `administrator.`,
        );
      } catch (error) {
        /**
         * Three different failures land here, and only the last is fatal.
         *
         * A genuine race: the check above is synchronous and the creation is
         * not, so two callers -- or two *processes*, which the in-flight memo
         * cannot see -- can both pass it. The loser fails on
         * `users_email_unique` having written nothing, and must not take the
         * server down; this runs inside instrumentation's `register()`, where a
         * rejection stops the server from starting at all.
         *
         * Our own creation half-succeeded (the user landed, `linkAccount`
         * threw). `adminExists()` cannot tell that apart from the race -- it
         * sees our own row and reports success -- which is why it is
         * deliberately not the last word: `completeDefaultAdmin()` below still
         * runs and has to make the postcondition true.
         *
         * And the one that made this a `catch` rather than a rethrow: a
         * `DEFAULT_EMAIL` row that appeared between the check and the write,
         * holding no admin role. Repair it, for exactly the reasons on
         * `restoreDefaultAdminRole()`.
         *
         * Narrowed by re-reading the database rather than by matching the
         * driver's error text: `SQLITE_CONSTRAINT_UNIQUE` arrives here wrapped
         * by both the Drizzle adapter and Better Auth, so the message is not
         * ours to depend on.
         */
        if (!adminExists()) {
          const raced = findDefaultAdmin();
          if (!raced) throw error;
          restoreDefaultAdminRole(raced.id);
        }
      }
    }
  }

  await completeDefaultAdmin();
}
