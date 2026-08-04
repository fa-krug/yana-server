import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
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

        db.insert(schema.userSettings)
          .values({
            userId: user!.id,
            articleRetentionDays: 60,
          })
          .run();

        const feed = db
          .insert(schema.feeds)
          .values({
            name: "Test Feed",
            userId: user!.id,
          })
          .returning({ id: schema.feeds.id })
          .get();

        feedId = feed.id;

        // Insert article A: published 2 years ago (old date), but imported today (new createdAt)
        // Must SURVIVE retention.
        db.insert(schema.articles)
          .values({
            name: "Old Publish Date",
            identifier: "a1",
            feedId,
            date: new Date("2024-01-01"),
            starred: false,
          })
          .run();

        // Insert article B: old createdAt (> 60 days ago), unstarred -> Must be DELETED
        const b = db
          .insert(schema.articles)
          .values({
            name: "Old Imported Date",
            identifier: "a2",
            feedId,
            date: new Date("2024-01-01"),
            starred: false,
          })
          .returning({ id: schema.articles.id })
          .get();

        const eightyDaysAgo = Math.floor((Date.now() - 80 * 24 * 3, 600_000) / 1000);
        db.run(sql`UPDATE articles SET created_at = ${eightyDaysAgo} WHERE id = ${b.id}`);

        // Insert article C: old createdAt (> 60 days ago), STARRED -> Must SURVIVE
        const c = db
          .insert(schema.articles)
          .values({
            name: "Old Starred Article",
            identifier: "a3",
            feedId,
            date: new Date("2024-01-01"),
            starred: true,
          })
          .returning({ id: schema.articles.id })
          .get();

        db.run(sql`UPDATE articles SET created_at = ${eightyDaysAgo} WHERE id = ${c.id}`);
      });

      const retentionHandler = handlers.getHandler("retention");
      expect(retentionHandler).toBeDefined();

      const dummyJob = {
        id: 1,
        runId: null,
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

    it("writes a tombstone for every article it deletes", async () => {
      let userId = "";
      let oldArticleId = 0;
      let freshArticleId = 0;

      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }
        userId = user!.id;

        db.insert(schema.userSettings).values({ userId, articleRetentionDays: 60 }).run();

        const feed = db
          .insert(schema.feeds)
          .values({ name: "Test Feed", userId })
          .returning({ id: schema.feeds.id })
          .get();

        // Old, unstarred -> must be deleted and tombstoned.
        const old = db
          .insert(schema.articles)
          .values({
            name: "Old Imported Date",
            identifier: "old-1",
            feedId: feed.id,
            date: new Date("2024-01-01"),
            starred: false,
          })
          .returning({ id: schema.articles.id })
          .get();
        oldArticleId = old.id;

        const eightyDaysAgo = Math.floor((Date.now() - 80 * 24 * 60 * 60_000) / 1000);
        db.run(sql`UPDATE articles SET created_at = ${eightyDaysAgo} WHERE id = ${old.id}`);

        // Fresh -> must survive, so it must not produce a tombstone.
        const fresh = db
          .insert(schema.articles)
          .values({
            name: "Fresh Article",
            identifier: "fresh-1",
            feedId: feed.id,
            date: new Date(),
            starred: false,
          })
          .returning({ id: schema.articles.id })
          .get();
        freshArticleId = fresh.id;
      });

      const retentionHandler = handlers.getHandler("retention");
      expect(retentionHandler).toBeDefined();

      const dummyJob = {
        id: 1,
        runId: null,
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

      const tombstones = client.getDb().select().from(schema.articleTombstones).all();
      expect(tombstones).toHaveLength(1);
      expect(tombstones[0].articleId).toBe(oldArticleId);
      expect(tombstones[0].userId).toBe(userId);

      const remaining = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, oldArticleId))
        .all();
      expect(remaining).toHaveLength(0);

      const survivor = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, freshArticleId))
        .all();
      expect(survivor).toHaveLength(1);
    });

    it("prunes tombstones older than the retention window but keeps recent ones", async () => {
      let userId = "";

      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }
        userId = user!.id;

        db.insert(schema.userSettings).values({ userId, articleRetentionDays: 60 }).run();

        // A stale tombstone, well past the 90-day tombstone-retention window.
        const stale = db
          .insert(schema.articleTombstones)
          .values({ articleId: 999, userId })
          .returning({ id: schema.articleTombstones.id })
          .get();
        const staleDeletedAt = Math.floor((Date.now() - 999 * 24 * 60 * 60_000) / 1000);
        db.run(
          sql`UPDATE article_tombstones SET deleted_at = ${staleDeletedAt} WHERE id = ${stale.id}`,
        );

        // A recent tombstone, well within the window.
        db.insert(schema.articleTombstones).values({ articleId: 1000, userId }).run();
      });

      const retentionHandler = handlers.getHandler("retention");
      expect(retentionHandler).toBeDefined();

      const dummyJob = {
        id: 1,
        runId: null,
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

      const remaining = client.getDb().select().from(schema.articleTombstones).all();
      const remainingArticleIds = remaining.map((t) => t.articleId);
      expect(remainingArticleIds).not.toContain(999);
      expect(remainingArticleIds).toContain(1000);
    });
  });

  describe("restore", () => {
    it("writes a tombstone for every article it wipes before re-aggregating", async () => {
      let userId = "";
      let feedId = 0;
      let articleAId = 0;
      let articleBId = 0;

      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }
        userId = user!.id;

        // Disabled, so the re-aggregate handleRestoreJob triggers afterwards
        // returns immediately -- this test is only about the wipe step.
        const feed = db
          .insert(schema.feeds)
          .values({ name: "Test Feed", userId, enabled: false })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;

        const a = db
          .insert(schema.articles)
          .values({ name: "Article A", identifier: "a1", feedId, date: new Date("2024-01-01") })
          .returning({ id: schema.articles.id })
          .get();
        articleAId = a.id;

        const b = db
          .insert(schema.articles)
          .values({ name: "Article B", identifier: "a2", feedId, date: new Date("2024-01-01") })
          .returning({ id: schema.articles.id })
          .get();
        articleBId = b.id;
      });

      const restoreHandler = handlers.getHandler("feed.restore");
      expect(restoreHandler).toBeDefined();

      const dummyJob = {
        id: 1,
        runId: null,
        kind: "feed.restore",
        payload: { feedId },
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

      await restoreHandler!(dummyJob);

      const remainingArticles = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.feedId, feedId))
        .all();
      expect(remainingArticles).toHaveLength(0);

      const tombstones = client.getDb().select().from(schema.articleTombstones).all();
      expect(tombstones).toHaveLength(2);
      expect(tombstones.every((t) => t.userId === userId)).toBe(true);
      expect(tombstones.map((t) => t.articleId).sort()).toEqual([articleAId, articleBId].sort());
    });

    it("wipes no articles and writes no tombstones for a feed with none", async () => {
      let feedId = 0;

      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }

        const feed = db
          .insert(schema.feeds)
          .values({ name: "Empty Feed", userId: user!.id, enabled: false })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;
      });

      const restoreHandler = handlers.getHandler("feed.restore");
      expect(restoreHandler).toBeDefined();

      const dummyJob = {
        id: 1,
        runId: null,
        kind: "feed.restore",
        payload: { feedId },
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

      await restoreHandler!(dummyJob);

      const tombstones = client.getDb().select().from(schema.articleTombstones).all();
      expect(tombstones).toHaveLength(0);
    });
  });
});
