import { eq, inArray } from "drizzle-orm";

import { getDb, writeTransaction } from "@/lib/db/client";
import { userSettings, users } from "@/lib/db/schema";

import { ADMIN_ROLE, ADMIN_ROLES, createUserWithPassword } from "./server";

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
 * `./server`, where it is also what the `admin()` plugin is configured with, so
 * this cannot drift from the plugin's own notion of an admin.
 *
 * A plain read, no writeTransaction(): that helper is for writes.
 */
function adminExists(): boolean {
  return (
    getDb().select({ id: users.id }).from(users).where(inArray(users.role, ADMIN_ROLES)).get() !==
    undefined
  );
}

/**
 * Create the default administrator when the instance has none.
 *
 * Called once per server start from `src/instrumentation.ts` -- not per
 * request. Idempotent, and safe if a second caller races it.
 *
 * The account is created through `createUserWithPassword()` rather than by
 * inserting rows: that seam hashes on Better Auth's own scrypt path and writes
 * the `accounts` credential row, so the result is indistinguishable from a
 * signed-up user and can actually log in. The phase-3 seeder this replaces
 * inserted a bare `users` row with no credential at all, which could not.
 */
export async function ensureAdminExists(): Promise<void> {
  if (adminExists()) return;

  let admin;
  try {
    admin = await createUserWithPassword({
      email: DEFAULT_EMAIL,
      password: DEFAULT_PASSWORD,
      name: "Admin",
      firstName: "Admin",
      role: ADMIN_ROLE,
    });
  } catch (error) {
    /**
     * The check above is synchronous but the creation is not, so two callers
     * that both start before either finishes will both get past it. The
     * `users.email` unique index is the backstop that keeps the second one from
     * landing a duplicate -- and a failure there must stay a no-op, because
     * this runs inside instrumentation's `register()`, where a rejection stops
     * the server from starting at all.
     *
     * Narrowed by re-reading the database rather than by matching the driver's
     * error text: `SQLITE_CONSTRAINT_UNIQUE` arrives here wrapped by both the
     * Drizzle adapter and Better Auth, so the message is not ours to depend on.
     * If an admin exists now, somebody else created it and there is nothing
     * left to do; if none does, the failure was real and belongs to the caller.
     */
    if (adminExists()) return;
    throw error;
  }

  /**
   * `getSettings()` throws when this row is missing (there is deliberately no
   * insert-if-absent fallback), so without it the dashboard and /settings both
   * fail for a fresh instance. Better Auth owns the `users` and `accounts`
   * writes above -- the ratified exception in CLAUDE.md -- but this one is
   * application code, so it goes through `writeTransaction()`.
   *
   * The callback is synchronous, as that helper requires: everything awaited
   * (the account creation, and the hashing inside it) already happened above.
   */
  writeTransaction((tx) => {
    const existing = tx.select().from(userSettings).where(eq(userSettings.userId, admin.id)).get();
    if (!existing) {
      tx.insert(userSettings).values({ userId: admin.id }).run();
    }
  });

  console.warn(
    `Yana created the default administrator ${DEFAULT_EMAIL} with the password ` +
      `"${DEFAULT_PASSWORD}" because this instance had no admin account. Sign in ` +
      `and change it now -- until you do, anyone who can reach this server is an ` +
      `administrator.`,
  );
}
