import { and, eq, inArray } from "drizzle-orm";

import { getDb, writeTransaction } from "@/lib/db/client";
import { accounts, passkeys, userSettings, users } from "@/lib/db/schema";

import { ADMIN_ROLE, ADMIN_ROLES } from "./roles";
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
 * Is there any administrator at all?
 *
 * Keyed on the *role*, never on `DEFAULT_EMAIL`. An operator who renames or
 * deletes the default account has made a decision, and an email-keyed check
 * would undo it on the next restart -- handing back an account with a published
 * password that the operator believes is gone. `ADMIN_ROLES` comes from
 * `./roles`, which is also what the `admin()` plugin is configured with in
 * `./server`, so this cannot drift from the plugin's own notion of an admin.
 *
 * Plain reads throughout this module, no writeTransaction(): that helper is for
 * writes.
 */
function adminExists(): boolean {
  return (
    getDb().select({ id: users.id }).from(users).where(inArray(users.role, ADMIN_ROLES)).get() !==
    undefined
  );
}

/** The default account, but only while it still holds an admin role. */
function findDefaultAdminId(): string | undefined {
  return getDb()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, DEFAULT_EMAIL), inArray(users.role, ADMIN_ROLES)))
    .get()?.id;
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

async function runEnsureAdminExists(): Promise<void> {
  if (!adminExists()) {
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
       * Two different failures land here.
       *
       * The one this guard is for: a genuine race. The check above is
       * synchronous and the creation is not, so two callers can both pass it.
       * The loser fails on the `users_email_unique` index having written
       * nothing, and must not take the server down -- this runs inside
       * instrumentation's `register()`, where a rejection stops the server from
       * starting at all.
       *
       * The other: our own creation half-succeeded (the user landed,
       * `linkAccount` threw). `adminExists()` cannot tell those apart -- it
       * would see our own useless row and report success -- which is why it is
       * deliberately not the last word. Either way `completeDefaultAdmin()`
       * below still runs and has to make the postcondition true; only if no
       * admin exists at all was the failure total, and then it is the caller's.
       *
       * Narrowed by re-reading the database rather than by matching the driver's
       * error text: `SQLITE_CONSTRAINT_UNIQUE` arrives here wrapped by both the
       * Drizzle adapter and Better Auth, so the message is not ours to depend
       * on.
       */
      if (!adminExists()) throw error;
    }
  }

  await completeDefaultAdmin();
}
