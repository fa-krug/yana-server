import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

/**
 * Real-database test, no driver mocks -- CLAUDE.md's convention, and the same
 * harness src/lib/auth/server.test.ts uses: each test points DATABASE_PATH at
 * its own temp file, migrates it through the same applyMigrations() the server
 * runs at startup (via applyMigrationsAt), and vi.resetModules() plus dynamic imports
 * give every test a clean module-level connection singleton.
 *
 * The assertion that carries the weight is the sign-in one. The phase-3 seeder
 * this bootstrap retires inserted a `users` row with no `accounts` row at all,
 * so the "admin" it created could never log in -- and every row-shape
 * assertion in its test file passed anyway. Only Better Auth's own scrypt
 * verify, reached through the real sign-in path, can tell the two apart.
 */
describe("ensureAdminExists", () => {
  let dbPath: string;
  let bootstrap: typeof import("./bootstrap");
  let auth: typeof import("./server").auth;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let warned: MockInstance<typeof console.warn>;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  /** Read the file back through raw SQL, not Drizzle -- see server.test.ts. */
  function all<T>(sql: string, ...params: unknown[]): T[] {
    const connection = new Database(dbPath);
    try {
      return connection.prepare(sql).all(...(params as [])) as T[];
    } finally {
      connection.close();
    }
  }

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-admin-bootstrap-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    // Set before the import: Better Auth reads it while building its context.
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";
    bootstrap = await import("./bootstrap");
    ({ auth } = await import("./server"));
    client = await import("@/lib/db/client");
    // Same module epoch as `client`, so these are the table objects the
    // connection getDb() opened is bound to -- see settings.test.ts.
    schema = await import("@/lib/db/schema");
    // The bootstrap announces the default password on stdout by design; silence
    // it here so the suite's output stays readable, and assert on it below.
    warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warned.mockRestore();
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("creates the default admin when none exists", async () => {
    await bootstrap.ensureAdminExists();

    const admins = all<{ email: string; role: string; first_name: string }>(
      "SELECT email, role, first_name FROM users WHERE role = 'admin'",
    );

    expect(admins).toHaveLength(1);
    expect(admins[0]).toMatchObject({
      email: "admin@admin.com",
      // Not the plugin's defaultRole of "user": a bootstrap that lands a
      // non-admin leaves the instance with nobody who can administer it.
      role: "admin",
      first_name: "Admin",
    });
    // The credentials are announced, with the instruction to change them. An
    // unannounced default password is a default password nobody rotates.
    expect(warned).toHaveBeenCalledWith(expect.stringContaining("admin@admin.com"));
  });

  it("creates an admin that can actually sign in", async () => {
    // The retired seeder's bug, made visible: it wrote a users row and no
    // credential, so this call would answer 401 while every row assertion
    // above still passed. Only Better Auth's own scrypt verify proves the
    // account went through the same hashing path a real sign-in checks.
    await bootstrap.ensureAdminExists();

    const response = await auth.api.signInEmail({
      body: { email: "admin@admin.com", password: "admin" },
      asResponse: true,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie") ?? "").not.toBe("");

    // And the stored secret is a hash, not the plaintext -- cheap, and it
    // would catch a future "simplification" that stored the password as-is
    // while sign-in kept working.
    const [account] = all<{ password: string }>("SELECT password FROM accounts");
    expect(account.password).not.toBe("admin");
  });

  it("creates the user_settings row the app needs to render at all", async () => {
    // getSettings() throws when this row is absent, by design (no
    // insert-if-absent fallback), so without it every route fails on a fresh
    // instance -- and nothing else creates it.
    await bootstrap.ensureAdminExists();

    const settings = all<{ user_id: string; language: string }>(
      "SELECT s.user_id, s.language FROM user_settings s " +
        "JOIN users u ON u.id = s.user_id WHERE u.email = 'admin@admin.com'",
    );

    expect(settings).toHaveLength(1);
    expect(settings[0].language).toBe("en");
  });

  it("is idempotent", async () => {
    await bootstrap.ensureAdminExists();
    const before = all<unknown>("SELECT id FROM users").length;

    await bootstrap.ensureAdminExists();

    expect(all<unknown>("SELECT id FROM users")).toHaveLength(before);
    expect(all<unknown>("SELECT id FROM accounts")).toHaveLength(1);
    expect(all<unknown>("SELECT id FROM user_settings")).toHaveLength(1);
  });

  it("repairs an admin that was left with no way to sign in", async () => {
    // The half-written creation, reproduced through Better Auth itself rather
    // than through our own code path: `createUserWithPassword()` is two awaited
    // writes, and this is what the database looks like when the second one does
    // not happen -- which is also, exactly, the retired seeder's shape. Without
    // a repair pass, `adminExists()` counts this row and every later boot
    // early-returns past it, forever.
    const ctx = await auth.$context;
    await ctx.internalAdapter.createUser({
      email: "admin@admin.com",
      name: "Admin",
      firstName: "Admin",
      lastName: "",
      role: "admin",
      emailVerified: false,
    });
    expect(all<unknown>("SELECT id FROM accounts")).toHaveLength(0);

    await bootstrap.ensureAdminExists();

    const response = await auth.api.signInEmail({
      body: { email: "admin@admin.com", password: "admin" },
      asResponse: true,
    });
    expect(response.status).toBe(200);
    // Repaired, not duplicated: still one user, and the settings row the
    // interrupted run never got to write is there too.
    expect(all<unknown>("SELECT id FROM users")).toHaveLength(1);
    expect(all<unknown>("SELECT id FROM accounts")).toHaveLength(1);
    expect(all<unknown>("SELECT id FROM user_settings")).toHaveLength(1);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining("restored the sign-in credential"));
  });

  it("repairs a missing user_settings row on the default admin", async () => {
    // The other interruption point: account complete, settings row never
    // written. getSettings() throws by design, so /` and /settings would 500 on
    // every request until this is repaired -- and nothing else repairs it.
    await bootstrap.ensureAdminExists();
    client.writeTransaction((tx) => {
      tx.delete(schema.userSettings).run();
    });

    await bootstrap.ensureAdminExists();

    expect(all<unknown>("SELECT id FROM user_settings")).toHaveLength(1);
    // And it did not also mint a second credential while it was in there.
    expect(all<unknown>("SELECT id FROM accounts")).toHaveLength(1);
  });

  it("does not hand the default password to a passkey-only admin", async () => {
    // An operator who removed the password credential on purpose, keeping a
    // passkey, has a passwordless account -- not an interrupted one. Restoring
    // "admin" there would be a hole, not a repair.
    await bootstrap.ensureAdminExists();
    const [admin] = all<{ id: string }>("SELECT id FROM users");
    client.writeTransaction((tx) => {
      tx.delete(schema.accounts).run();
      tx.insert(schema.passkeys)
        .values({
          id: "passkey-1",
          userId: admin.id,
          publicKey: "public-key",
          credentialID: "credential-id",
          deviceType: "singleDevice",
        })
        .run();
    });

    await bootstrap.ensureAdminExists();

    expect(all<unknown>("SELECT id FROM accounts")).toHaveLength(0);
  });

  it("creates nothing when some other admin already exists", async () => {
    // A deployment whose admin was renamed must not get admin@admin.com back.
    client.writeTransaction((tx) => {
      tx.insert(schema.users)
        .values({ id: "someone", email: "real@admin.tld", role: "admin" })
        .run();
    });

    await bootstrap.ensureAdminExists();

    expect(all<{ email: string }>("SELECT email FROM users")).toEqual([
      { email: "real@admin.tld" },
    ]);
  });

  it("does not resurrect the default admin after it has been renamed", async () => {
    // The check is keyed on "an admin exists", not on the address, so the one
    // operator action that would otherwise loop forever -- rename the default,
    // restart, get it back -- does nothing on the second boot.
    await bootstrap.ensureAdminExists();
    client.writeTransaction((tx) => {
      tx.update(schema.users)
        .set({ email: "operator@example.com" })
        .where(eq(schema.users.email, "admin@admin.com"))
        .run();
    });

    await bootstrap.ensureAdminExists();

    expect(all<{ email: string }>("SELECT email FROM users")).toEqual([
      { email: "operator@example.com" },
    ]);
  });

  /**
   * **The bricking sequence, end to end.**
   *
   * Reproduced live by the phase-4 whole-branch review before any of it was
   * fixed: `POST /api/auth/admin/set-role {"role":["user","admin"]}` answered
   * 200 and wrote the literal `"user,admin"`. The plugin reads that as a list
   * and still treated the account as an administrator; `adminExists()` tested
   * the whole string for equality and did not -- so the next restart tried to
   * create `admin@admin.com`, hit `users_email_unique`, rethrew out of
   * `register()` and `process.exit(1)`. The server never booted again, and
   * there is no in-app recovery from that: no self-registration, no mail
   * transport, no CLI.
   *
   * Three defences close it and each is asserted separately below, because any
   * one of them alone still leaves a broken instance:
   * `disabledPaths` (`./server`) removes the cheapest trigger, `isAdminRole()`
   * (`./roles`) makes the two notions of "admin" agree, and the repair here
   * means *any* other route to the same state -- a typo, a case change, a
   * phase-5 write -- costs a warning instead of the instance.
   */
  it("boots through the role list the admin plugin can write", async () => {
    await bootstrap.ensureAdminExists();
    // Exactly what /admin/set-role stored, verified live at 200.
    client.writeTransaction((tx) => {
      tx.update(schema.users)
        .set({ role: "user,admin" })
        .where(eq(schema.users.email, "admin@admin.com"))
        .run();
    });

    await expect(bootstrap.ensureAdminExists()).resolves.toBeUndefined();

    // No second account was attempted, and the role was left exactly as the
    // operator's tooling wrote it -- this is already an administrator.
    expect(all<{ role: string }>("SELECT role FROM users")).toEqual([{ role: "user,admin" }]);
  });

  it("repairs the role instead of refusing to boot when the address is taken", async () => {
    // The general case: *any* write that leaves admin@admin.com without an
    // administrative role reaches this, not just /admin/set-role. Before the
    // fix this threw SQLITE_CONSTRAINT_UNIQUE out of register().
    await bootstrap.ensureAdminExists();
    client.writeTransaction((tx) => {
      tx.update(schema.users)
        .set({ role: "user" })
        .where(eq(schema.users.email, "admin@admin.com"))
        .run();
    });

    await expect(bootstrap.ensureAdminExists()).resolves.toBeUndefined();

    expect(all<{ email: string; role: string }>("SELECT email, role FROM users")).toEqual([
      { email: "admin@admin.com", role: "admin" },
    ]);
    // Repaired, not duplicated, and not re-credentialed: the account could
    // already sign in, so its password is untouched.
    expect(all<unknown>("SELECT id FROM accounts")).toHaveLength(1);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining("restored the administrator role"));
  });

  it("does not restore the role while another admin is still usable", async () => {
    // The operator's deliberate arrangement -- demote the default, promote
    // somebody else -- must survive every restart. This is what keeps the
    // repair above from being a standing privilege grant.
    await bootstrap.ensureAdminExists();
    client.writeTransaction((tx) => {
      tx.update(schema.users)
        .set({ role: "user" })
        .where(eq(schema.users.email, "admin@admin.com"))
        .run();
      tx.insert(schema.users)
        .values({ id: "someone", email: "real@admin.tld", role: "admin" })
        .run();
    });

    await bootstrap.ensureAdminExists();

    expect(all<{ role: string }>("SELECT role FROM users WHERE email = 'admin@admin.com'")).toEqual(
      [{ role: "user" }],
    );
  });

  it("treats a banned sole admin as no admin, and unbans the default", async () => {
    // The plugin refuses to create a session for a banned user
    // (plugins/admin/admin.mjs, session.create.before), so an instance whose
    // only administrator is banned has none in the only sense that matters --
    // and adminExists() counting them left it with no way back in.
    await bootstrap.ensureAdminExists();
    client.writeTransaction((tx) => {
      tx.update(schema.users)
        .set({ banned: true, banReason: "locked out", banExpires: null })
        .where(eq(schema.users.email, "admin@admin.com"))
        .run();
    });

    await bootstrap.ensureAdminExists();

    expect(
      all<{ banned: number; ban_reason: string | null }>("SELECT banned, ban_reason FROM users"),
    ).toEqual([{ banned: 0, ban_reason: null }]);
  });

  /**
   * **Lifting a ban has to be disclosed, and the reason has to survive.**
   *
   * The repair clears `banned`, `ban_reason` and `ban_expires`, which reverses
   * a deliberate lockout -- a different act from correcting a role, with a
   * different remedy. A message naming only the role left the operator with no
   * line saying their lockout was gone, and destroyed `ban_reason`, the only
   * record of *why*, writing it nowhere. So the warning says the ban was
   * lifted, quotes the reason read *before* the overwrite, and adds re-banning
   * to the remediation advice.
   */
  it("discloses a lifted ban, quoting the reason it is about to destroy", async () => {
    await bootstrap.ensureAdminExists();
    client.writeTransaction((tx) => {
      tx.update(schema.users)
        .set({ banned: true, banReason: "shared credentials with a contractor" })
        .where(eq(schema.users.email, "admin@admin.com"))
        .run();
    });
    warned.mockClear();

    await bootstrap.ensureAdminExists();

    const message = warned.mock.calls.map(([first]) => String(first)).join("\n");
    expect(message).toContain("LIFTED THE BAN");
    // The reason, carried into the log because the column is now NULL. This is
    // the assertion the column check above cannot make: it can only see that
    // the reason is gone, not that it was preserved anywhere.
    expect(message).toContain("shared credentials with a contractor");
    expect(all<{ ban_reason: string | null }>("SELECT ban_reason FROM users")).toEqual([
      { ban_reason: null },
    ]);
    // And the remedy for a reversed lockout is not the remedy for a wrong role.
    expect(message).toContain("ban it again");
  });

  it("does not mention bans when it only fixed a role", async () => {
    // A warning that talks about bans on every repair is one a reader learns to
    // skim -- and skimming it is exactly what must not happen the time it
    // matters. This is the control for the test above.
    await bootstrap.ensureAdminExists();
    client.writeTransaction((tx) => {
      tx.update(schema.users)
        .set({ role: "user" })
        .where(eq(schema.users.email, "admin@admin.com"))
        .run();
    });
    warned.mockClear();

    await bootstrap.ensureAdminExists();

    const message = warned.mock.calls.map(([first]) => String(first)).join("\n");
    expect(message).toContain("restored the administrator role");
    expect(message).not.toMatch(/ban/i);
  });

  it("still discloses a lift when no reason was ever recorded", async () => {
    // `ban_reason` is nullable and the plugin's banUser leaves it unset when the
    // caller gives none. "none given" is a statement; an empty pair of quotes
    // reads as a truncated log line.
    await bootstrap.ensureAdminExists();
    client.writeTransaction((tx) => {
      tx.update(schema.users)
        .set({ banned: true, banReason: null })
        .where(eq(schema.users.email, "admin@admin.com"))
        .run();
    });
    warned.mockClear();

    await bootstrap.ensureAdminExists();

    const message = warned.mock.calls.map(([first]) => String(first)).join("\n");
    expect(message).toContain("LIFTED THE BAN");
    expect(message).toContain("none given");
  });

  it("leaves an admin whose ban has already expired alone", async () => {
    // Better Auth lifts an expired ban on the next sign-in rather than
    // refusing it, so this account is usable and nothing here should fire.
    await bootstrap.ensureAdminExists();
    client.writeTransaction((tx) => {
      tx.update(schema.users)
        .set({ banned: true, banReason: "over", banExpires: new Date(Date.now() - 60_000) })
        .where(eq(schema.users.email, "admin@admin.com"))
        .run();
    });

    await bootstrap.ensureAdminExists();

    expect(all<{ banned: number }>("SELECT banned FROM users")).toEqual([{ banned: 1 }]);
    expect(warned).not.toHaveBeenCalledWith(
      expect.stringContaining("restored the administrator role"),
    );
  });

  it("tolerates a concurrent second call instead of crashing boot", async () => {
    // Both callers pass the "no admin exists" check before either await
    // resolves, so the loser hits the users.email unique index. That is the
    // intended backstop -- but it must surface as a no-op, not as a rejection
    // out of instrumentation's register(), which would take the server down.
    await expect(
      Promise.all([bootstrap.ensureAdminExists(), bootstrap.ensureAdminExists()]),
    ).resolves.toBeDefined();

    expect(all<unknown>("SELECT id FROM users WHERE email = 'admin@admin.com'")).toHaveLength(1);
    // And exactly one credential. The loser falls through to the repair pass,
    // where `hasPasswordCredential()` reads false while the winner is still
    // inside scrypt -- so without the in-flight memo both link one, and two
    // `credential` rows disarm Better Auth's "cannot unlink your last account"
    // guard: change the password, unlink, and the published default is live
    // again. A users-only assertion here saw none of that.
    expect(all<unknown>("SELECT id FROM accounts WHERE provider_id = 'credential'")).toHaveLength(
      1,
    );
    expect(all<unknown>("SELECT id FROM user_settings")).toHaveLength(1);
  });
});
