import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real-database test, no driver mocks -- see CLAUDE.md's testing convention
// and src/lib/db/client.test.ts, which this follows. Each test points
// DATABASE_PATH at its own temp file, primes it with the generated
// migration, then exercises ensureBootstrapUser() through the real
// getDb()/writeTransaction() singleton. vi.resetModules() plus a dynamic
// import gives each test a clean module-level `cached` connection and
// transaction-depth counter, the same reason client.test.ts does it.

const drizzleDir = path.resolve(import.meta.dirname, "../../../drizzle");

function primeSchema(dbPath: string): void {
  const connection = new Database(dbPath);
  for (const file of fs
    .readdirSync(drizzleDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    for (const statement of fs
      .readFileSync(path.join(drizzleDir, file), "utf8")
      .split("--> statement-breakpoint")) {
      if (statement.trim()) connection.exec(statement);
    }
  }
  connection.close();
}

describe("ensureBootstrapUser", () => {
  let dbPath: string;
  let bootstrap: typeof import("./bootstrap");
  let client: typeof import("./client");

  // Same escape hatch client.ts itself uses to reach the raw better-sqlite3
  // handle -- needed here to close the module singleton's connection in
  // afterEach, the way client.test.ts does.
  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-bootstrap-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    primeSchema(dbPath);
    process.env.DATABASE_PATH = dbPath;
    bootstrap = await import("./bootstrap");
    client = await import("./client");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("creates the bootstrap user and its settings row", async () => {
    const id = await bootstrap.ensureBootstrapUser();
    expect(id).toBe(bootstrap.BOOTSTRAP_USER_ID);

    const connection = new Database(dbPath);
    const user = connection
      .prepare("SELECT id, email, is_admin FROM users WHERE id = ?")
      .get(bootstrap.BOOTSTRAP_USER_ID);
    const settings = connection
      .prepare("SELECT user_id FROM user_settings WHERE user_id = ?")
      .get(bootstrap.BOOTSTRAP_USER_ID);
    connection.close();

    expect(user).toMatchObject({ id: "bootstrap", email: "admin@admin.com", is_admin: 1 });
    expect(settings).toMatchObject({ user_id: "bootstrap" });
  });

  it("is idempotent: calling it twice does not throw or duplicate rows", async () => {
    await bootstrap.ensureBootstrapUser();
    await expect(bootstrap.ensureBootstrapUser()).resolves.toBe(bootstrap.BOOTSTRAP_USER_ID);

    const connection = new Database(dbPath);
    const userCount = connection
      .prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?")
      .get(bootstrap.BOOTSTRAP_USER_ID) as { count: number };
    const settingsCount = connection
      .prepare("SELECT COUNT(*) AS count FROM user_settings WHERE user_id = ?")
      .get(bootstrap.BOOTSTRAP_USER_ID) as { count: number };
    connection.close();

    expect(userCount.count).toBe(1);
    expect(settingsCount.count).toBe(1);
  });
});
