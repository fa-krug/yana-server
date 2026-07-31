import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

/**
 * The startup path, end to end, on a database that has **never been migrated**
 * -- deliberately not using `applyMigrationsAt()` from test-support, unlike
 * every other real-database test here. That is the whole point: this is the
 * fresh-checkout and fresh-container case, where nothing has prepared the file
 * and `runStartupTasks()` has to do all of it.
 *
 * It is the test that replaces "did someone remember to run the migrations".
 * Since the inline `node -e` left docker-entrypoint.sh, this is the only
 * migration path there is -- for `next dev`, `next start` and the image alike --
 * so a regression here is a container that boots against an empty database.
 */
describe("runStartupTasks", () => {
  let dbPath: string;
  let startup: typeof import("./startup");
  let auth: typeof import("./auth/server").auth;
  let client: typeof import("./db/client");
  let warned: MockInstance<typeof console.warn>;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function all<T>(sql: string): T[] {
    const connection = new Database(dbPath);
    try {
      return connection.prepare(sql).all() as T[];
    } finally {
      connection.close();
    }
  }

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-startup-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";
    startup = await import("./startup");
    ({ auth } = await import("./auth/server"));
    client = await import("./db/client");
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

  it("migrates an untouched database and leaves it signed-into-able", async () => {
    // Nothing exists yet -- not even the file.
    expect(fs.existsSync(dbPath)).toBe(false);

    await startup.runStartupTasks();

    // Every migration in the journal ran, not just the first: `passkeys` comes
    // from 0001 and `users.role` from 0002, so both being present is the
    // journal being honoured rather than one .sql file being replayed.
    const tables = all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map(
      (row) => row.name,
    );
    expect(tables).toEqual(expect.arrayContaining(["users", "user_settings", "accounts"]));
    expect(tables).toContain("passkeys");
    expect(tables).toContain("__drizzle_migrations");

    // And the bootstrap ran *after* the migrations, which is the ordering that
    // matters: it queries `users`, so on a fresh file the reverse order throws
    // "no such table".
    const response = await auth.api.signInEmail({
      body: { email: "admin@admin.com", password: "admin" },
      asResponse: true,
    });
    expect(response.status).toBe(200);
    expect(all<unknown>("SELECT id FROM user_settings")).toHaveLength(1);
  });

  it("is a no-op on the second start", async () => {
    await startup.runStartupTasks();
    const applied = all<{ hash: string }>("SELECT hash FROM __drizzle_migrations").length;

    await startup.runStartupTasks();

    expect(all<{ hash: string }>("SELECT hash FROM __drizzle_migrations")).toHaveLength(applied);
    expect(all<unknown>("SELECT id FROM users")).toHaveLength(1);
    expect(all<unknown>("SELECT id FROM accounts")).toHaveLength(1);
    expect(all<unknown>("SELECT id FROM user_settings")).toHaveLength(1);
  });
});
