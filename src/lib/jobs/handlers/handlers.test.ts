import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../../db/test-support";

describe("src/lib/jobs/handlers", () => {
  let dbPath: string;
  let client: typeof import("../../db/client");
  let schema: typeof import("../../db/schema");
  let queue: typeof import("../queue");
  let handlers: typeof import("./index");

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-handlers-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    applyMigrationsAt(dbPath);

    client = await import("../../db/client");
    schema = await import("../../db/schema");
    queue = await import("../queue");
    handlers = await import("./index");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  describe("retention", () => {
    it("deletes unstarred articles older than articleRetentionDays by createdAt, excluding starred articles", async () => {
      let feedId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }

        db.insert(schema.userSettings).values({
          userId: user!.id,
          articleRetentionDays: 60,
        }).run();

        const feed = db.insert(schema.feeds).values({
          name: "Test Feed",
          userId: user!.id,
        }).returning({ id: schema.feeds.id }).get();

        feedId = feed.id;

        // Insert article A: published 2 years ago (old date), but imported today (new createdAt)
        // Must SURVIVE retention.
        db.insert(schema.articles).values({
          name: "Old Publish Date",
          identifier: "a1",
          feedId,
          date: new Date("2024-01-01"),
          starred: false,
        }).run();

        // Insert article B: old createdAt (> 60 days ago), unstarred -> Must be DELETED
        const b = db.insert(schema.articles).values({
          name: "Old Imported Date",
          identifier: "a2",
          feedId,
          date: new Date("2024-01-01"),
          starred: false,
        }).returning({ id: schema.articles.id }).get();

        const eightyDaysAgo = Math.floor((Date.now() - 80 * 24 * 3,600_000) / 1000);
        db.run(sql`UPDATE articles SET created_at = ${eightyDaysAgo} WHERE id = ${b.id}`);

        // Insert article C: old createdAt (> 60 days ago), STARRED -> Must SURVIVE
        const c = db.insert(schema.articles).values({
          name: "Old Starred Article",
          identifier: "a3",
          feedId,
          date: new Date("2024-01-01"),
          starred: true,
        }).returning({ id: schema.articles.id }).get();

        db.run(sql`UPDATE articles SET created_at = ${eightyDaysAgo} WHERE id = ${c.id}`);
      });

      const retentionHandler = handlers.getHandler("retention");
      expect(retentionHandler).toBeDefined();

      const dummyJob: schema.Job = {
        id: 1,
        kind: "retention",
        payload: {},
        status: "running",
        attempts: 1,
        maxAttempts: 3,
        runAt: new Date(),
        startedAt: new Date(),
        finishedAt: null,
        progress: 0,
        error: "",
        createdAt: new Date(),
      };

      await retentionHandler!(dummyJob);

      const remainingArticles = client.getDb().select().from(schema.articles).all();
      expect(remainingArticles.length).toBe(2);

      const identifiers = remainingArticles.map((a) => a.identifier);
      expect(identifiers).toContain("a1"); // Saved by new createdAt
      expect(identifiers).toContain("a3"); // Saved by starred
      expect(identifiers).not.toContain("a2"); // Deleted by retention
    });
  });
});
