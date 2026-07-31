import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

// Real-database test, no driver mocks -- see CLAUDE.md's testing convention
// and src/lib/db/bootstrap.test.ts, which this follows. Each test points
// DATABASE_PATH at its own temp file, migrates it the way docker-entrypoint.sh
// does (applyMigrationsAt -> migrate()), then exercises the actions/queries
// through the real getDb()/writeTransaction() singleton.
//
// next/cache's revalidatePath() is the one thing stubbed: it requires a Next
// request scope that does not exist under Vitest and throws if called for
// real, and it has no database behavior of its own to verify. Everything
// touching SQLite runs unmocked.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("settings", () => {
  let dbPath: string;
  let queries: typeof import("./queries");
  let actions: typeof import("./actions");
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  // Same escape hatch client.ts itself uses to reach the raw better-sqlite3
  // handle -- needed here to close the module singleton's connection in
  // afterEach, the way bootstrap.test.ts does.
  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-settings-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    queries = await import("./queries");
    actions = await import("./actions");
    client = await import("@/lib/db/client");
    // Same module epoch as `client` above (no resetModules() in between), so
    // this is the identical userSettings table object client.ts's own
    // internal `import * as schema from "./schema"` resolves to -- required
    // for the delete below to act on the connection getDb() actually opened.
    schema = await import("@/lib/db/schema");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  describe("updateLibrarySettings", () => {
    it("rejects a retention of zero days", async () => {
      const result = await actions.updateLibrarySettings({
        articleRetentionDays: 0,
        updateIntervalMinutes: 30,
      });
      expect(result.ok).toBe(false);
    });

    it("rejects an update interval below one minute", async () => {
      const result = await actions.updateLibrarySettings({
        articleRetentionDays: 60,
        updateIntervalMinutes: 0,
      });
      expect(result.ok).toBe(false);
    });

    it("accepts sane values and persists them", async () => {
      const result = await actions.updateLibrarySettings({
        articleRetentionDays: 90,
        updateIntervalMinutes: 15,
      });
      expect(result.ok).toBe(true);

      // A no-op write() would still return { ok: true }, so this reads the
      // row back for real rather than trusting the flag alone.
      const settings = await queries.getSettings();
      expect(settings.articleRetentionDays).toBe(90);
      expect(settings.updateIntervalMinutes).toBe(15);
    });
  });

  describe("updateGeneralSettings", () => {
    it("accepts sane values and persists them", async () => {
      const result = await actions.updateGeneralSettings({ theme: "dark", language: "de" });
      expect(result.ok).toBe(true);

      const settings = await queries.getSettings();
      expect(settings.theme).toBe("dark");
      expect(settings.language).toBe("de");
    });
  });

  describe("currentUserId", () => {
    it("memoizes the bootstrap seed per process: a deleted settings row stays deleted", async () => {
      const userId = await queries.currentUserId();

      // Delete the row the first call's seed created, through
      // writeTransaction() per the project's write convention -- never a bare
      // db.delete() outside one.
      client.writeTransaction((tx) => {
        tx.delete(schema.userSettings).where(eq(schema.userSettings.userId, userId)).run();
      });

      await queries.currentUserId();

      // If the bootstrap seed had re-run, ensureBootstrapUser()'s
      // existing-row check would have found none and recreated it. It
      // doesn't: the seed already ran once for this process and is memoized,
      // so the second call is a no-op. This also documents the real tradeoff
      // of that memoization -- the seed is not self-healing within a
      // process's lifetime.
      await expect(queries.getSettings()).rejects.toThrow(/no user_settings row/);
    });
  });
});
