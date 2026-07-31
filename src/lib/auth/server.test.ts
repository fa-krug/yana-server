import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

/**
 * Real-database test, no driver mocks -- the convention in CLAUDE.md, and here
 * it is the only kind of test worth writing.
 *
 * What is under test is a *mapping*, not logic: Better Auth's singular model
 * names (`user`, `account`, `session`) resolved onto this repository's plural
 * Drizzle exports by `usePlural`, and its camelCase field names resolved onto
 * Drizzle property names that happen to match. Nothing in that mapping is
 * visible to `tsc` -- the adapter indexes the table object with a computed
 * string -- so a wrong `usePlural`, a renamed property (`credentialId` for
 * `credentialID`) or a column Better Auth writes that the table lacks all
 * compile cleanly and fail at the first request, with errors that read like
 * data corruption. Only a real sign-up against a real migrated file catches it.
 *
 * Assertions read the file back through raw SQL rather than through Drizzle, so
 * a mistake in the schema definition cannot mask itself on the way out.
 */
describe("the Better Auth instance", () => {
  let dbPath: string;
  let auth: typeof import("./server").auth;
  let client: typeof import("@/lib/db/client");

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  /** Sign up, returning the response's session cookie along with the body. */
  async function signUp(body: Record<string, unknown>): Promise<{
    cookie: string;
    payload: { user?: { id?: string } };
    status: number;
  }> {
    const response = await auth.api.signUpEmail({
      body: body as never,
      asResponse: true,
    });
    return {
      cookie: response.headers.get("set-cookie") ?? "",
      payload: (await response.json()) as { user?: { id?: string } },
      status: response.status,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-auth-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    // Set before the import: Better Auth reads it while building its context.
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";
    ({ auth } = await import("./server"));
    client = await import("@/lib/db/client");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("writes a sign-up into phase 2's users table and the new satellites", async () => {
    const { payload, status } = await signUp({
      email: "someone@example.com",
      password: "correct horse battery staple",
      name: "Some One",
    });

    expect(status).toBe(200);
    const userId = payload.user?.id;
    expect(typeof userId).toBe("string");

    const connection = new Database(dbPath);
    const user = connection.prepare("SELECT * FROM users WHERE id = ?").get(userId) as Record<
      string,
      unknown
    >;
    const account = connection
      .prepare("SELECT * FROM accounts WHERE user_id = ?")
      .get(userId) as Record<string, unknown>;
    const sessionCount = connection
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
      .get(userId) as { count: number };
    connection.close();

    // The columns phase 2 declared, populated by Better Auth without a single
    // `fields` mapping entry -- which is the claim `usePlural` alone is enough.
    expect(user).toMatchObject({
      email: "someone@example.com",
      name: "Some One",
      email_verified: 0,
      first_name: "",
      last_name: "",
      is_admin: 0,
    });
    expect(typeof user.created_at).toBe("number");
    expect(typeof user.updated_at).toBe("number");

    expect(account).toMatchObject({ provider_id: "credential", account_id: userId });
    // scrypt, Better Auth's default. The assertion that matters is only that
    // the plaintext is not what landed in the column.
    expect(account.password).not.toBe("correct horse battery staple");
    expect(String(account.password).length).toBeGreaterThan(32);

    expect(sessionCount.count).toBe(1);
  });

  it("ignores isAdmin in the sign-up body, so nobody can self-promote", async () => {
    // The whole authorization model is this one boolean, so an additional field
    // left open to request input would be the entire privilege ladder in one
    // POST. `input: false` in the config is what closes it; this proves it.
    const { payload } = await signUp({
      email: "climber@example.com",
      password: "correct horse battery staple",
      name: "Climber",
      isAdmin: true,
    });

    const connection = new Database(dbPath);
    const user = connection
      .prepare("SELECT is_admin FROM users WHERE id = ?")
      .get(payload.user?.id) as { is_admin: number };
    connection.close();

    expect(user.is_admin).toBe(0);
  });

  it("round-trips the session cookie back to the signed-up user", async () => {
    const { cookie, payload } = await signUp({
      email: "returning@example.com",
      password: "correct horse battery staple",
      name: "Returning",
    });

    // Proves the sessions mapping in the direction the app actually uses it:
    // token lookup, not insert. A wrong column name here would have let the
    // previous test pass and every login fail.
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });

    expect(session?.user.id).toBe(payload.user?.id);
    expect(session?.user.email).toBe("returning@example.com");
  });

  it("does not open the database while the module is being imported", async () => {
    // `next build` imports every route's module graph, and `data/` does not
    // exist until docker-entrypoint.sh migrates it -- so an eager getDb() in
    // this module would create a database on the build machine. The proxy in
    // server.ts is what keeps it lazy; this is the test that would notice if
    // somebody "simplified" it back to `drizzleAdapter(getDb(), ...)`.
    vi.resetModules();
    const missing = path.join(os.tmpdir(), `yana-auth-never-${Date.now()}`, "nested", "yana.db");
    process.env.DATABASE_PATH = missing;

    await import("./server");

    expect(fs.existsSync(path.dirname(missing))).toBe(false);
    process.env.DATABASE_PATH = dbPath;
  });
});
