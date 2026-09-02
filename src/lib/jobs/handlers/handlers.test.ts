import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RawArticle } from "@/lib/aggregators/base";
import { sourceFingerprint } from "@/lib/aggregators/source-fingerprint";

import { applyMigrationsAt } from "../../db/test-support";

vi.mock("@/lib/aggregators/factory", () => ({
  createAggregator: vi.fn(),
}));

vi.mock("@/lib/feeds/logo", () => ({
  discoverLogo: vi.fn(),
  storeLogo: vi.fn(),
  fetchIconBytes: vi.fn(),
}));

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

    // Re-registered every test (not a top-level `vi.mock`): `vi.resetModules()`
    // clears the *module* registry but not the *mocks* registry, so a
    // `vi.mock` factory that calls `importOriginal()` would resolve once for
    // the whole file and freeze its `actual` queue functions to this test's
    // `../db/client` singleton -- which `afterEach` then closes, breaking
    // every later test's `writeTransaction` calls with "connection is not
    // open". Re-registering with `vi.doMock` here, after `resetModules()` and
    // before the imports below, makes `importOriginal()` resolve fresh each
    // test, against the fresh `../db/client` created for *this* `dbPath`.
    vi.doMock("../queue", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../queue")>();
      return { ...actual, isCancelRequested: vi.fn(() => false) };
    });

    client = await import("../../db/client");
    schema = await import("../../db/schema");
    queue = await import("../queue");
    handlers = await import("./index");
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  /** Builds a real `jobs` row (via the queue) so `appendLogLine`'s FK holds. */
  function makeJob(kind: string, payload: Record<string, unknown> = {}) {
    const id = queue.enqueue(kind, payload);
    return queue.getJob(id)!;
  }

  function logLines(jobId: number): string[] {
    return queue.listJobLogs(jobId).map((l) => l.line);
  }

  function seedUser(id: string, email: string): void {
    let user = client.getDb().select().from(schema.users).where(eq(schema.users.id, id)).get();
    if (!user) {
      client.writeTransaction((db) => {
        db.insert(schema.users).values({ id, email }).run();
      });
      user = client.getDb().select().from(schema.users).where(eq(schema.users.id, id)).get();
    }
  }

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

      const job = makeJob("retention");

      await retentionHandler!(job);

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

      const job = makeJob("retention");

      await retentionHandler!(job);

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

      const lines = logLines(job.id);
      expect(lines).toContain(`user ${userId}: removed 1 expired articles`);
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

      const job = makeJob("retention");

      await retentionHandler!(job);

      const remaining = client.getDb().select().from(schema.articleTombstones).all();
      const remainingArticleIds = remaining.map((t) => t.articleId);
      expect(remainingArticleIds).not.toContain(999);
      expect(remainingArticleIds).toContain(1000);

      // Nothing to remove per-user (no feeds for this user), but pruning
      // always logs its own line, deleted count included.
      const lines = logLines(job.id);
      expect(lines).toContain("pruned 1 expired tombstones");
      expect(lines.some((l) => l.startsWith("user "))).toBe(false);
    });

    it("logs a per-user removal line only for the user with expired articles", async () => {
      seedUser("retention-user-a", "retention-a@example.com");
      seedUser("retention-user-b", "retention-b@example.com");

      let feedAId = 0;
      let feedBId = 0;

      client.writeTransaction((db) => {
        db.insert(schema.userSettings)
          .values({ userId: "retention-user-a", articleRetentionDays: 60 })
          .run();
        db.insert(schema.userSettings)
          .values({ userId: "retention-user-b", articleRetentionDays: 60 })
          .run();

        const feedA = db
          .insert(schema.feeds)
          .values({ name: "Feed A", userId: "retention-user-a" })
          .returning({ id: schema.feeds.id })
          .get();
        feedAId = feedA.id;

        const feedB = db
          .insert(schema.feeds)
          .values({ name: "Feed B", userId: "retention-user-b" })
          .returning({ id: schema.feeds.id })
          .get();
        feedBId = feedB.id;

        // User A: one expired, unstarred article -> gets removed.
        const old = db
          .insert(schema.articles)
          .values({
            name: "Old",
            identifier: "old-a",
            feedId: feedAId,
            date: new Date("2024-01-01"),
            starred: false,
          })
          .returning({ id: schema.articles.id })
          .get();
        const eightyDaysAgo = Math.floor((Date.now() - 80 * 24 * 60 * 60_000) / 1000);
        db.run(sql`UPDATE articles SET created_at = ${eightyDaysAgo} WHERE id = ${old.id}`);

        // User B: a fresh article -> nothing expires, no removal line for B.
        db.insert(schema.articles)
          .values({ name: "Fresh", identifier: "fresh-b", feedId: feedBId, date: new Date() })
          .run();
      });

      const retentionHandler = handlers.getHandler("retention");
      const job = makeJob("retention");

      await retentionHandler!(job);

      const lines = logLines(job.id);
      expect(lines).toContain("user retention-user-a: removed 1 expired articles");
      expect(lines.some((l) => l.startsWith("user retention-user-b:"))).toBe(false);
      expect(lines.some((l) => /^pruned \d+ expired tombstones$/.test(l))).toBe(true);
    });
  });

  describe("retention cancellation", () => {
    it("stops processing further users once cancellation is requested", async () => {
      let userAId = "";
      let userBId = "";
      client.writeTransaction((db) => {
        const a = db
          .insert(schema.users)
          .values({ id: "user-a", email: "a@example.com" })
          .returning({ id: schema.users.id })
          .get();
        const b = db
          .insert(schema.users)
          .values({ id: "user-b", email: "b@example.com" })
          .returning({ id: schema.users.id })
          .get();
        userAId = a.id;
        userBId = b.id;

        db.insert(schema.userSettings).values({ userId: userAId, articleRetentionDays: 60 }).run();
        db.insert(schema.userSettings).values({ userId: userBId, articleRetentionDays: 60 }).run();

        const feedA = db
          .insert(schema.feeds)
          .values({ name: "Feed A", userId: userAId })
          .returning({ id: schema.feeds.id })
          .get();
        const feedB = db
          .insert(schema.feeds)
          .values({ name: "Feed B", userId: userBId })
          .returning({ id: schema.feeds.id })
          .get();

        const eightyDaysAgo = Math.floor((Date.now() - 80 * 24 * 3_600_000) / 1000);

        const a1 = db
          .insert(schema.articles)
          .values({
            name: "Old A",
            identifier: "a1",
            feedId: feedA.id,
            date: new Date("2024-01-01"),
            starred: false,
          })
          .returning({ id: schema.articles.id })
          .get();
        db.run(sql`UPDATE articles SET created_at = ${eightyDaysAgo} WHERE id = ${a1.id}`);

        const b1 = db
          .insert(schema.articles)
          .values({
            name: "Old B",
            identifier: "b1",
            feedId: feedB.id,
            date: new Date("2024-01-01"),
            starred: false,
          })
          .returning({ id: schema.articles.id })
          .get();
        db.run(sql`UPDATE articles SET created_at = ${eightyDaysAgo} WHERE id = ${b1.id}`);
      });

      vi.mocked(queue.isCancelRequested).mockReturnValueOnce(false).mockReturnValueOnce(true);

      const retentionHandler = handlers.getHandler("retention");
      const job = makeJob("retention");

      const { JobCancelledError } = await import("../errors");
      await expect(retentionHandler!(job)).rejects.toThrow(JobCancelledError);

      const remaining = client.getDb().select().from(schema.articles).all();
      const identifiers = remaining.map((a) => a.identifier);
      expect(identifiers).not.toContain("a1"); // user A's retention already ran
      expect(identifiers).toContain("b1"); // user B never reached
    });
  });

  describe("restore", () => {
    it("logs and returns early when the feed row is not found", async () => {
      const restoreHandler = handlers.getHandler("feed.restore");
      expect(restoreHandler).toBeDefined();

      const job = makeJob("feed.restore", { feedId: 999_999 });

      await restoreHandler!(job);

      const tombstones = client.getDb().select().from(schema.articleTombstones).all();
      expect(tombstones).toHaveLength(0);

      const lines = logLines(job.id);
      expect(lines).toEqual(["feed not found, skipping"]);
    });

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

      const job = makeJob("feed.restore", { feedId });

      await restoreHandler!(job);

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

      const lines = logLines(job.id);
      expect(lines).toContain("removed 2 existing articles before re-aggregating");
      // The feed is disabled, so handleAggregateJob's own early-return line
      // should follow -- proving the re-aggregate step really ran afterward.
      expect(lines).toContain(`feed ${feedId} not found or disabled, skipping`);
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

      const job = makeJob("feed.restore", { feedId });

      await restoreHandler!(job);

      const tombstones = client.getDb().select().from(schema.articleTombstones).all();
      expect(tombstones).toHaveLength(0);

      const lines = logLines(job.id);
      expect(lines).toContain("removed 0 existing articles before re-aggregating");
    });
  });

  describe("aggregate", () => {
    /** One enabled feed, owned by a user this seeds if the database has none. */
    function seedAggregateFeed(): number {
      let feedId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }
        const feed = db
          .insert(schema.feeds)
          .values({ name: "Active Feed", userId: user!.id, enabled: true })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;
      });
      return feedId;
    }

    it("logs and returns early when the payload has no feedId", async () => {
      const factory = await import("@/lib/aggregators/factory");

      const aggregateHandler = handlers.getHandler("aggregate");
      expect(aggregateHandler).toBeDefined();

      const job = makeJob("aggregate", {});

      await aggregateHandler!(job);

      expect(factory.createAggregator).not.toHaveBeenCalled();
      const lines = logLines(job.id);
      expect(lines).toEqual(["no feedId in payload, skipping"]);
    });

    it("logs and returns early for a feed that is disabled", async () => {
      let feedId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }

        const feed = db
          .insert(schema.feeds)
          .values({ name: "Disabled Feed", userId: user!.id, enabled: false })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;
      });

      const factory = await import("@/lib/aggregators/factory");

      const aggregateHandler = handlers.getHandler("aggregate");
      expect(aggregateHandler).toBeDefined();

      const job = makeJob("aggregate", { feedId });

      await aggregateHandler!(job);

      expect(factory.createAggregator).not.toHaveBeenCalled();
      const lines = logLines(job.id);
      expect(lines).toEqual([`feed ${feedId} not found or disabled, skipping`]);
    });

    it("logs fetched and created counts for newly seen articles", async () => {
      let feedId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }

        const feed = db
          .insert(schema.feeds)
          .values({ name: "Active Feed", userId: user!.id, enabled: true })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;
      });

      const rawArticles = [
        {
          name: "Article One",
          identifier: "art-1",
          raw_content: "<p>one</p>",
          content: "<p>one</p>",
          date: new Date(),
        },
        {
          name: "Article Two",
          identifier: "art-2",
          raw_content: "<p>two</p>",
          content: "<p>two</p>",
          date: new Date(),
        },
      ];

      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => rawArticles,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      const aggregateHandler = handlers.getHandler("aggregate");
      const job = makeJob("aggregate", { feedId });

      await aggregateHandler!(job);

      const inserted = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.feedId, feedId))
        .all();
      expect(inserted).toHaveLength(2);

      const lines = logLines(job.id);
      expect(lines).toContain('aggregating feed "Active Feed" (full_website)');
      expect(lines).toContain("fetched 2 articles");
      expect(lines).toContain("upserted articles: 2 created, 0 updated, 0 unchanged");
    });

    it("logs an updated count when re-aggregating an already-seen article", async () => {
      let feedId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }

        const feed = db
          .insert(schema.feeds)
          .values({ name: "Active Feed", userId: user!.id, enabled: true })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;

        db.insert(schema.articles)
          .values({
            name: "Stale Title",
            identifier: "art-1",
            feedId,
            date: new Date("2024-01-01"),
          })
          .run();
      });

      const rawArticles = [
        {
          name: "Article One Updated",
          identifier: "art-1",
          raw_content: "<p>fresh</p>",
          content: "<p>fresh</p>",
          date: new Date(),
        },
      ];

      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => rawArticles,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      const aggregateHandler = handlers.getHandler("aggregate");
      const job = makeJob("aggregate", { feedId });

      await aggregateHandler!(job);

      const stillOne = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.feedId, feedId))
        .all();
      expect(stillOne).toHaveLength(1);
      expect(stillOne[0].name).toBe("Article One Updated");

      const lines = logLines(job.id);
      expect(lines).toContain('aggregating feed "Active Feed" (full_website)');
      expect(lines).toContain("fetched 1 articles");
      expect(lines).toContain("upserted articles: 0 created, 1 updated, 0 unchanged");
    });

    it("stops the article loop once cancellation is requested, keeping already-processed articles", async () => {
      let feedId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }

        const feed = db
          .insert(schema.feeds)
          .values({ name: "Active Feed", userId: user!.id, enabled: true })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;
      });

      const rawArticles = [
        {
          name: "One",
          identifier: "art-1",
          raw_content: "<p>1</p>",
          content: "<p>1</p>",
          date: new Date(),
        },
        {
          name: "Two",
          identifier: "art-2",
          raw_content: "<p>2</p>",
          content: "<p>2</p>",
          date: new Date(),
        },
        {
          name: "Three",
          identifier: "art-3",
          raw_content: "<p>3</p>",
          content: "<p>3</p>",
          date: new Date(),
        },
      ];

      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => rawArticles,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      vi.mocked(queue.isCancelRequested).mockReturnValueOnce(false).mockReturnValueOnce(true);

      const aggregateHandler = handlers.getHandler("aggregate");
      const job = makeJob("aggregate", { feedId });

      const { JobCancelledError } = await import("../errors");
      await expect(aggregateHandler!(job)).rejects.toThrow(JobCancelledError);

      const inserted = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.feedId, feedId))
        .all();
      expect(inserted).toHaveLength(1);
    });

    it("does not rewrite an article whose content is unchanged", async () => {
      const feedId = seedAggregateFeed();

      const rawArticles = [
        {
          name: "Article One",
          identifier: "art-1",
          raw_content: "<p>one</p>",
          content: "<p>one</p>",
          date: new Date("2026-01-01T00:00:00.000Z"),
        },
      ];

      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => rawArticles,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      const aggregateHandler = handlers.getHandler("aggregate");

      await aggregateHandler!(makeJob("aggregate", { feedId }));

      // `updatedAt` is `mode: "timestamp"` -- second granularity -- and the two
      // runs here are milliseconds apart, so comparing the two values as-is
      // passes even when the row really was rewritten. Stamp an old value
      // first: now only a genuine skip can leave it in place.
      client.writeTransaction((db) => {
        db.run(sql`UPDATE articles SET updated_at = 1000000000 WHERE feed_id = ${feedId}`);
      });

      const first = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.feedId, feedId))
        .get();
      expect(first!.updatedAt.getTime()).toBe(1_000_000_000_000);
      const firstBlocks = client
        .getDb()
        .select()
        .from(schema.articleBlocks)
        .where(eq(schema.articleBlocks.articleId, first!.id))
        .all();

      const secondJob = makeJob("aggregate", { feedId });
      await aggregateHandler!(secondJob);

      const second = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.feedId, feedId))
        .get();
      const secondBlocks = client
        .getDb()
        .select()
        .from(schema.articleBlocks)
        .where(eq(schema.articleBlocks.articleId, first!.id))
        .all();

      // The row was not touched: updatedAt did not advance, so this article
      // does not re-enter /api/v1's sync `updated` stream.
      expect(second!.updatedAt.getTime()).toBe(first!.updatedAt.getTime());
      // The block tree was not deleted and reinserted: same rows, same ids.
      expect(secondBlocks.map((b) => b.id)).toEqual(firstBlocks.map((b) => b.id));
      expect(firstBlocks.length).toBeGreaterThan(0);
      expect(logLines(secondJob.id)).toContain(
        "upserted articles: 0 created, 0 updated, 1 unchanged",
      );
    });

    /**
     * **A comment is not the article.** `formatArticleContent()` renders the
     * comment section into the same body the block tree is parsed from, so
     * this used to rewrite the row -- and, on a feed with AI options, re-run
     * the provider -- every time a thread got busier. It also pushed the
     * article back into `/api/v1`'s sync `updated` stream for text nobody
     * edited. The fingerprint now looks past the section (and past the raw
     * page, which is where the scraping aggregators get their comments from).
     */
    it("leaves an article alone when only its comments changed", async () => {
      const feedId = seedAggregateFeed();

      const body = `<section data-sanitized-class="article-content"><p>post</p></section>`;
      const withoutComment = {
        name: "Reddit Post",
        identifier: "art-1",
        raw_content: "<html>page v1</html>",
        content: body,
        date: new Date("2026-01-01T00:00:00.000Z"),
      };
      // What the aggregators actually produce on a later run: one more
      // comment in the rendered section, and -- for the scrapers -- a
      // different page to have scraped it out of.
      const withComment = {
        ...withoutComment,
        raw_content: "<html>page v2</html>",
        content:
          `${body}\n\n<section data-sanitized-class="article-comments">` +
          `<blockquote><p><strong>ada</strong></p><div>nice</div></blockquote></section>`,
      };

      const factory = await import("@/lib/aggregators/factory");
      const aggregateHandler = handlers.getHandler("aggregate");

      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => [withoutComment],
      } as unknown as ReturnType<typeof factory.createAggregator>);
      await aggregateHandler!(makeJob("aggregate", { feedId }));

      // Age the row: `updatedAt` is second granularity, so both runs land in
      // the same second and an unchanged value would prove nothing.
      client.writeTransaction((db) => {
        db.run(sql`UPDATE articles SET updated_at = 1000000000 WHERE feed_id = ${feedId}`);
      });

      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => [withComment],
      } as unknown as ReturnType<typeof factory.createAggregator>);
      const secondJob = makeJob("aggregate", { feedId });
      await aggregateHandler!(secondJob);

      const row = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.feedId, feedId))
        .get();
      expect(row!.plainText).not.toContain("nice");
      expect(row!.updatedAt.getTime()).toBe(1_000_000_000_000);
      expect(logLines(secondJob.id)).toContain(
        "upserted articles: 0 created, 0 updated, 1 unchanged",
      );
    });

    it("rewrites an article when its own content changes, comments and all", async () => {
      const feedId = seedAggregateFeed();

      const comments =
        `<section data-sanitized-class="article-comments">` +
        `<blockquote><p><strong>ada</strong></p><div>nice</div></blockquote></section>`;
      const first = {
        name: "Reddit Post",
        identifier: "art-1",
        raw_content: "",
        content: `<section data-sanitized-class="article-content"><p>post</p></section>\n\n${comments}`,
        date: new Date("2026-01-01T00:00:00.000Z"),
      };
      // The body itself was edited upstream. The comment section rides along
      // -- the exclusion is about what *triggers* a rewrite, not about what
      // gets stored once one happens.
      const edited = {
        ...first,
        content: `<section data-sanitized-class="article-content"><p>post, corrected</p></section>\n\n${comments}`,
      };

      const factory = await import("@/lib/aggregators/factory");
      const aggregateHandler = handlers.getHandler("aggregate");

      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => [first],
      } as unknown as ReturnType<typeof factory.createAggregator>);
      await aggregateHandler!(makeJob("aggregate", { feedId }));

      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => [edited],
      } as unknown as ReturnType<typeof factory.createAggregator>);
      const secondJob = makeJob("aggregate", { feedId });
      await aggregateHandler!(secondJob);

      const row = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.feedId, feedId))
        .get();
      expect(row!.plainText).toContain("corrected");
      expect(row!.plainText).toContain("nice");
      expect(logLines(secondJob.id)).toContain(
        "upserted articles: 0 created, 1 updated, 0 unchanged",
      );
    });

    it("still skips on a later run for a feed whose articles carry no date", async () => {
      const feedId = seedAggregateFeed();

      // No `date` field at all: the handler falls back to `new Date()`.
      // Hashing the stored value would differ on every run and the skip would
      // never fire.
      const rawArticles = [
        { name: "Undated", identifier: "art-1", raw_content: "<p>x</p>", content: "<p>x</p>" },
      ];

      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => rawArticles,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      const aggregateHandler = handlers.getHandler("aggregate");
      await aggregateHandler!(makeJob("aggregate", { feedId }));
      const secondJob = makeJob("aggregate", { feedId });
      await aggregateHandler!(secondJob);

      expect(logLines(secondJob.id)).toContain(
        "upserted articles: 0 created, 0 updated, 1 unchanged",
      );
    });

    it("rewrites an article whose stored fingerprint is null", async () => {
      const feedId = seedAggregateFeed();

      // Every row that predates the column is in this state. It must be
      // treated as changed exactly once, then settle.
      client.writeTransaction((db) => {
        db.insert(schema.articles)
          .values({
            name: "Legacy",
            identifier: "art-1",
            feedId,
            date: new Date("2026-01-01T00:00:00.000Z"),
            sourceHash: null,
          })
          .run();
      });

      const rawArticles = [
        {
          name: "Legacy",
          identifier: "art-1",
          raw_content: "<p>x</p>",
          content: "<p>x</p>",
          date: new Date("2026-01-01T00:00:00.000Z"),
        },
      ];

      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => rawArticles,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      const aggregateHandler = handlers.getHandler("aggregate");
      const firstJob = makeJob("aggregate", { feedId });
      await aggregateHandler!(firstJob);
      expect(logLines(firstJob.id)).toContain(
        "upserted articles: 0 created, 1 updated, 0 unchanged",
      );

      const secondJob = makeJob("aggregate", { feedId });
      await aggregateHandler!(secondJob);
      expect(logLines(secondJob.id)).toContain(
        "upserted articles: 0 created, 0 updated, 1 unchanged",
      );
    });

    it("re-aggregates an article whose content a failed reload replaced with an error notice", async () => {
      const feedId = seedAggregateFeed();

      const raw = {
        name: "Article One",
        identifier: "https://example.com/art-1",
        raw_content: "<p>real body</p>",
        content: "<p>real body</p>",
        date: new Date("2026-01-01T00:00:00.000Z"),
      };

      const factory = await import("@/lib/aggregators/factory");
      // One aggregator object serving both handlers: `aggregate` for the
      // aggregation runs, the reload surface for the reload in between --
      // whose fetch fails, which is what makes reload write error blocks.
      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => [raw],
        fetchArticleContent: vi.fn().mockRejectedValue(new Error("HTTP 404 Not Found")),
        extractHeaderElement: async () => null,
        extractContent: (html: string) => html,
        processContent: (html: string) => html,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      const aggregateHandler = handlers.getHandler("aggregate");
      const reloadHandler = handlers.getHandler("article.reload");

      await aggregateHandler!(makeJob("aggregate", { feedId }));
      const article = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.feedId, feedId))
        .get();
      expect(article!.plainText).toContain("real body");

      // A failed reload overwrites the body with an error notice. Before this
      // fix the stored contentHash still described the *old* content, so the
      // next aggregation cycle skipped the row and the error notice was
      // permanent -- an article that could never heal itself again.
      await reloadHandler!(makeJob("article.reload", { articleId: article!.id }));
      const broken = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, article!.id))
        .get();
      expect(broken!.plainText).toContain("could not be reloaded");

      const healingJob = makeJob("aggregate", { feedId });
      await aggregateHandler!(healingJob);

      const healed = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, article!.id))
        .get();
      expect(healed!.plainText).toContain("real body");
      expect(healed!.plainText).not.toContain("could not be reloaded");
      expect(logLines(healingJob.id)).toContain(
        "upserted articles: 0 created, 1 updated, 0 unchanged",
      );
    });

    /**
     * **A manual reload wins over the next aggregation run.**
     *
     * Reload used to null `contentHash`, which made every reload provisional:
     * the next cycle re-derived the article from the feed and discarded what
     * an operator had just asked for. Keeping the stored fingerprints -- which
     * describe the *source* the row came from, not the bytes stored -- is what
     * makes the reload stand while the source is unchanged, and still lets a
     * genuine upstream edit replace it.
     */
    it("keeps a reloaded article until the source itself changes", async () => {
      const feedId = seedAggregateFeed();

      const source = {
        name: "Article One",
        identifier: "https://example.com/art-1",
        raw_content: "",
        content: "<p>as the feed listed it</p>",
        date: new Date("2026-01-01T00:00:00.000Z"),
      };

      const factory = await import("@/lib/aggregators/factory");
      // One aggregator serving both handlers, as the error-notice test does:
      // `aggregate` for the runs, the reload surface for the reload between
      // them -- whose fetch returns something the feed listing does not have.
      const fetchArticleContent = vi.fn().mockResolvedValue("<p>the operator's refetch</p>");
      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => [source],
        fetchArticleContent,
        extractHeaderElement: async () => null,
        extractContent: (html: string) => html,
        processContent: (html: string) => html,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      const aggregateHandler = handlers.getHandler("aggregate");
      const reloadHandler = handlers.getHandler("article.reload");

      await aggregateHandler!(makeJob("aggregate", { feedId }));
      const article = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.feedId, feedId))
        .get()!;
      const aggregatedHash = article.sourceHash;
      expect(article.plainText).toContain("as the feed listed it");

      await reloadHandler!(makeJob("article.reload", { articleId: article.id }));
      const reloaded = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, article.id))
        .get()!;
      expect(reloaded.plainText).toContain("the operator's refetch");
      // The fingerprint is preserved rather than nulled -- it still describes
      // the source this row came from, which the reload did not change.
      expect(reloaded.sourceHash).toBe(aggregatedHash);

      // Age the row so a rewrite is detectable at second granularity.
      client.writeTransaction((db) => {
        db.run(sql`UPDATE articles SET updated_at = 1000000000 WHERE feed_id = ${feedId}`);
      });

      const nextJob = makeJob("aggregate", { feedId });
      await aggregateHandler!(nextJob);

      const afterAggregation = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, article.id))
        .get()!;
      expect(afterAggregation.plainText).toContain("the operator's refetch");
      expect(afterAggregation.plainText).not.toContain("as the feed listed it");
      expect(afterAggregation.updatedAt.getTime()).toBe(1_000_000_000_000);
      expect(logLines(nextJob.id)).toContain(
        "upserted articles: 0 created, 0 updated, 1 unchanged",
      );

      // But an upstream edit still wins: the fingerprints describe the source,
      // so once it moves they no longer match.
      source.content = "<p>as the feed listed it, corrected upstream</p>";
      const editJob = makeJob("aggregate", { feedId });
      await aggregateHandler!(editJob);

      const afterEdit = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, article.id))
        .get()!;
      expect(afterEdit.plainText).toContain("corrected upstream");
      expect(logLines(editJob.id)).toContain(
        "upserted articles: 0 created, 1 updated, 0 unchanged",
      );
    });

    /**
     * **The one case a reload cannot make stick**, stated here so it is a
     * known limit rather than a surprise.
     *
     * A null fingerprint means the row was never completed. Reload cannot
     * fill it in: the value has to be one the *aggregator* would compute, over
     * the feed's own article rather than the page reload fetched, and reload
     * has no way to know it. So the row keeps reload's content but stays
     * "needs work", and the next aggregation run reprocesses it -- once,
     * after which it settles.
     */
    it("leaves a never-aggregated row without a fingerprint, so it is reprocessed once", async () => {
      const feedId = seedAggregateFeed();
      let articleId = 0;
      client.writeTransaction((db) => {
        const row = db
          .insert(schema.articles)
          .values({
            name: "Broken",
            identifier: "https://example.com/art-1",
            feedId,
            plainText: "could not be reloaded",
            date: new Date("2026-01-01T00:00:00.000Z"),
            sourceHash: null,
          })
          .returning({ id: schema.articles.id })
          .get();
        articleId = row.id;
      });

      const source = {
        name: "Broken",
        identifier: "https://example.com/art-1",
        raw_content: "",
        content: "<p>as the feed lists it</p>",
        date: new Date("2026-01-01T00:00:00.000Z"),
      };
      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => [source],
        fetchArticleContent: vi.fn().mockResolvedValue("<p>fixed by the operator</p>"),
        extractHeaderElement: async () => null,
        extractContent: (html: string) => html,
        processContent: (html: string) => html,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      await handlers.getHandler("article.reload")!(makeJob("article.reload", { articleId }));

      const reloaded = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, articleId))
        .get()!;
      expect(reloaded.plainText).toContain("fixed by the operator");
      expect(reloaded.sourceHash).toBeNull();

      // Reprocessed on the next run, and settled afterwards.
      await handlers.getHandler("aggregate")!(makeJob("aggregate", { feedId }));
      const afterAggregation = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, articleId))
        .get()!;
      expect(afterAggregation.plainText).toContain("as the feed lists it");
      expect(afterAggregation.sourceHash).not.toBeNull();
    });

    /**
     * **An article whose configured AI pass did not run must not be stamped
     * with a `contentHash`, and the job must not report success.**
     *
     * `ai_failed_reason` is what `applyAiProcessing()` in
     * `@/lib/aggregators/base` sets on the article; these tests set it
     * directly because the factory is mocked at `aggregate()`, which is above
     * where that happens. Before this, the outcome was discarded entirely: the
     * untranslated article was saved, fingerprinted as current, and skipped by
     * every later run -- so a feed set to translate served some articles in
     * the original language permanently, while every job showed green.
     */
    describe("an article whose AI post-processing did not complete", () => {
      const failed = {
        name: "Untranslated",
        identifier: "art-1",
        raw_content: "<p>original language</p>",
        content: "<p>original language</p>",
        date: new Date("2026-01-01T00:00:00.000Z"),
        ai_failed_reason: "providerError",
      };

      it("is stored without a contentHash, so the next run retries it", async () => {
        const feedId = seedAggregateFeed();
        const factory = await import("@/lib/aggregators/factory");
        vi.mocked(factory.createAggregator).mockReturnValue({
          aggregate: async () => [failed],
        } as unknown as ReturnType<typeof factory.createAggregator>);

        const aggregateHandler = handlers.getHandler("aggregate");
        const job = makeJob("aggregate", { feedId });

        await expect(aggregateHandler!(job)).rejects.toThrow(/AI processing did not complete/);

        // Saved anyway: an untranslated article beats no article. What it must
        // not carry is the fingerprint that means "current".
        const stored = client
          .getDb()
          .select()
          .from(schema.articles)
          .where(eq(schema.articles.feedId, feedId))
          .get();
        expect(stored!.plainText).toContain("original language");
        expect(stored!.sourceHash).toBeNull();
        expect(logLines(job.id)).toContain("upserted articles: 1 created, 0 updated, 0 unchanged");

        // The next run's AI call succeeds, so the same feed item is now a
        // *different* article -- rewritten and, this time, fingerprinted.
        vi.mocked(factory.createAggregator).mockReturnValue({
          aggregate: async () => [
            { ...failed, ai_failed_reason: undefined, content: "<p>ursprache</p>" },
          ],
        } as unknown as ReturnType<typeof factory.createAggregator>);
        const healingJob = makeJob("aggregate", { feedId });
        await aggregateHandler!(healingJob);

        const healed = client
          .getDb()
          .select()
          .from(schema.articles)
          .where(eq(schema.articles.feedId, feedId))
          .get();
        expect(healed!.plainText).toContain("ursprache");
        expect(healed!.sourceHash).not.toBeNull();
      });

      it("does not overwrite the stored version of an article it already has", async () => {
        const feedId = seedAggregateFeed();
        const factory = await import("@/lib/aggregators/factory");
        const aggregateHandler = handlers.getHandler("aggregate");

        // First run: AI succeeded, so what is stored is the translated body.
        vi.mocked(factory.createAggregator).mockReturnValue({
          aggregate: async () => [
            { ...failed, ai_failed_reason: undefined, content: "<p>ursprache</p>" },
          ],
        } as unknown as ReturnType<typeof factory.createAggregator>);
        await aggregateHandler!(makeJob("aggregate", { feedId }));

        // Second run: the provider is down. The article's *feed* text is
        // unchanged, so the hash does not match the stored translated body and
        // the skip above does not fire -- without the guard this run would
        // replace a good German article with the original-language one over a
        // transient error.
        vi.mocked(factory.createAggregator).mockReturnValue({
          aggregate: async () => [failed],
        } as unknown as ReturnType<typeof factory.createAggregator>);
        const job = makeJob("aggregate", { feedId });
        await expect(aggregateHandler!(job)).rejects.toThrow(/AI processing did not complete/);

        const stored = client
          .getDb()
          .select()
          .from(schema.articles)
          .where(eq(schema.articles.feedId, feedId))
          .get();
        expect(stored!.plainText).toContain("ursprache");
        expect(stored!.plainText).not.toContain("original language");
        expect(logLines(job.id)).toContain("upserted articles: 0 created, 0 updated, 0 unchanged");
        expect(logLines(job.id).some((l) => l.includes("kept the stored version"))).toBe(true);
      });
    });

    /**
     * **The whole point of `articles.sourceHash`, end to end.**
     *
     * Unlike every other test in this block, this one drives a *real*
     * `BaseAggregator` subclass rather than a stub with an `aggregate()`
     * method, because the behaviour under test spans both halves: the
     * aggregator decides whether to call a provider, and the handler decides
     * whether to touch the row. A stub bypasses the first half entirely.
     *
     * Before this, AI ran on every fetched article on every cycle -- the
     * handler's unchanged-skip saved the write, never the provider call.
     */
    it("makes no AI call, and no write, for an article whose source has not changed", async () => {
      let feedId = 0;
      client.writeTransaction((db) => {
        db.insert(schema.users)
          .values({ id: "ai-user", email: "ai-user@example.com" })
          .onConflictDoNothing()
          .run();
        db.insert(schema.userSettings)
          .values({
            userId: "ai-user",
            activeAiProvider: "gemini",
            geminiEnabled: true,
            geminiApiKey: "test-key",
            aiRequestDelay: 0,
          })
          .run();
        const feed = db
          .insert(schema.feeds)
          .values({
            name: "Translating Feed",
            userId: "ai-user",
            identifier: "https://example.com/rss",
            enabled: true,
            // The article below carries a fixed date so its fingerprint is
            // stable across the three runs; without this the default 30-day
            // ingestion filter would drop it before AI ever ran.
            maxArticleAgeDays: 0,
            options: { ai_translate: true, ai_translate_language: "German" },
          })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;
      });

      const raw = {
        name: "Original",
        identifier: "https://example.com/art-1",
        raw_content: "",
        content: "<p>original language</p>",
        date: new Date("2026-01-01T00:00:00.000Z"),
      };

      const { BaseAggregator } = await import("@/lib/aggregators/base");
      class RealAggregator extends BaseAggregator {
        async fetchSourceData(): Promise<unknown> {
          return [{ ...raw }];
        }
        async parseToRawArticles(sourceData: unknown): Promise<RawArticle[]> {
          return sourceData as RawArticle[];
        }
      }

      const feedRow = client
        .getDb()
        .select()
        .from(schema.feeds)
        .where(eq(schema.feeds.id, feedId))
        .get()!;
      const feedLike = { ...feedRow };
      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockImplementation(
        () =>
          new RealAggregator(feedLike) as unknown as ReturnType<typeof factory.createAggregator>,
      );

      // One provider call per article that is actually processed.
      const aiCalls = vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: "Übersetzt",
                      content: "<p>ursprache</p>",
                    }),
                  },
                ],
              },
            },
          ],
        }),
      }));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = aiCalls as unknown as typeof fetch;

      try {
        const aggregateHandler = handlers.getHandler("aggregate");

        const first = makeJob("aggregate", { feedId });
        await aggregateHandler!(first);

        expect(aiCalls).toHaveBeenCalledTimes(1);
        const stored = client
          .getDb()
          .select()
          .from(schema.articles)
          .where(eq(schema.articles.feedId, feedId))
          .get();
        expect(stored!.plainText).toContain("ursprache");
        // The stored fingerprint is the *pre*-AI one: it matches the source
        // article, not the translated body that got written. Taken after the
        // AI call it would never match the feed again and the skip could
        // never fire.
        expect(stored!.sourceHash).toBe(sourceFingerprint(raw));

        // Age the row so a rewrite is detectable: `updatedAt` is second
        // granularity and both runs land in the same second otherwise.
        client.writeTransaction((db) => {
          db.run(sql`UPDATE articles SET updated_at = 1000000000 WHERE feed_id = ${feedId}`);
        });

        const second = makeJob("aggregate", { feedId });
        await aggregateHandler!(second);

        // The source is byte-identical, so no second provider call.
        expect(aiCalls).toHaveBeenCalledTimes(1);
        const after = client
          .getDb()
          .select()
          .from(schema.articles)
          .where(eq(schema.articles.feedId, feedId))
          .get();
        // And the translated article is still there, untouched -- not
        // overwritten with the original-language text the skip left on the
        // raw article.
        expect(after!.plainText).toContain("ursprache");
        expect(after!.updatedAt.getTime()).toBe(1_000_000_000_000);
        expect(logLines(second.id)).toContain(
          "upserted articles: 0 created, 0 updated, 1 unchanged",
        );

        // A changed source text is processed again, so the skip is a skip and
        // not a permanent stop.
        raw.content = "<p>original language, revised</p>";
        const third = makeJob("aggregate", { feedId });
        await aggregateHandler!(third);
        expect(aiCalls).toHaveBeenCalledTimes(2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("logo", () => {
    it("logs and returns when the feed row is not found", async () => {
      const logoModule = await import("@/lib/feeds/logo");

      const logoHandler = handlers.getHandler("feed.logo");
      expect(logoHandler).toBeDefined();

      const job = makeJob("feed.logo", { feedId: 999_999 });

      await logoHandler!(job);

      expect(logoModule.discoverLogo).not.toHaveBeenCalled();
      const lines = logLines(job.id);
      expect(lines).toEqual(["feed not found, skipping"]);
    });

    it("logs and returns when no logo source is configured", async () => {
      let feedId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }

        const feed = db
          .insert(schema.feeds)
          .values({ name: "No Source Feed", userId: user!.id, identifier: "", logoSourceUrl: "" })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;
      });

      const logoModule = await import("@/lib/feeds/logo");
      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockReturnValue({
        getSourceUrl: () => "",
        logoImageUrl: async () => null,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      const logoHandler = handlers.getHandler("feed.logo");
      expect(logoHandler).toBeDefined();

      const job = makeJob("feed.logo", { feedId });

      await logoHandler!(job);

      expect(logoModule.discoverLogo).not.toHaveBeenCalled();
      const lines = logLines(job.id);
      expect(lines).toEqual(["no logo source configured, skipping"]);
    });

    it("logs when no logo is found", async () => {
      let feedId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }

        const feed = db
          .insert(schema.feeds)
          .values({
            name: "Feed",
            userId: user!.id,
            identifier: "https://example.com",
            logoSourceUrl: "",
          })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;
      });

      const logoModule = await import("@/lib/feeds/logo");
      vi.mocked(logoModule.discoverLogo).mockResolvedValue(null);
      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockReturnValue({
        getSourceUrl: () => "https://example.com",
        logoImageUrl: async () => null,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      const logoHandler = handlers.getHandler("feed.logo");
      const job = makeJob("feed.logo", { feedId });

      await logoHandler!(job);

      expect(logoModule.storeLogo).not.toHaveBeenCalled();
      const lines = logLines(job.id);
      expect(lines).toContain("no logo found");
    });

    it("logs the source url when a logo is stored", async () => {
      let feedId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }

        const feed = db
          .insert(schema.feeds)
          .values({
            name: "Feed",
            userId: user!.id,
            identifier: "https://example.com",
            logoSourceUrl: "",
          })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;
      });

      const logoUrl = "https://example.com/favicon.ico";
      const logoModule = await import("@/lib/feeds/logo");
      vi.mocked(logoModule.discoverLogo).mockResolvedValue({
        url: logoUrl,
        bytes: Buffer.from("fake-bytes"),
      });
      vi.mocked(logoModule.storeLogo).mockResolvedValue("some-content-hash");
      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockReturnValue({
        getSourceUrl: () => "https://example.com",
        logoImageUrl: async () => null,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      const logoHandler = handlers.getHandler("feed.logo");
      const job = makeJob("feed.logo", { feedId });

      await logoHandler!(job);

      expect(logoModule.storeLogo).toHaveBeenCalledWith(feedId, expect.any(Buffer), logoUrl);
      const lines = logLines(job.id);
      expect(lines).toContain(`stored logo from ${logoUrl}`);
    });

    it("prefers the aggregator's own logo image over favicon discovery", async () => {
      let feedId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }

        const feed = db
          .insert(schema.feeds)
          .values({
            name: "Reddit Feed",
            userId: user!.id,
            identifier: "test",
            aggregator: "reddit",
            logoSourceUrl: "",
          })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;
      });

      const apiImageUrl = "https://styles.redditmedia.com/t5_x/icon.png";
      const logoModule = await import("@/lib/feeds/logo");
      vi.mocked(logoModule.fetchIconBytes).mockResolvedValue(Buffer.from("fake-bytes"));
      vi.mocked(logoModule.storeLogo).mockResolvedValue("some-content-hash");
      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockReturnValue({
        getSourceUrl: () => "https://www.reddit.com/r/test",
        logoImageUrl: async () => apiImageUrl,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      const logoHandler = handlers.getHandler("feed.logo");
      const job = makeJob("feed.logo", { feedId });

      await logoHandler!(job);

      expect(logoModule.discoverLogo).not.toHaveBeenCalled();
      expect(logoModule.fetchIconBytes).toHaveBeenCalledWith(apiImageUrl);
      expect(logoModule.storeLogo).toHaveBeenCalledWith(feedId, expect.any(Buffer), apiImageUrl);
      const lines = logLines(job.id);
      expect(lines).toContain(`stored logo from ${apiImageUrl}`);
    });

    it("falls back to favicon discovery when the aggregator's own logo image can't be fetched", async () => {
      let feedId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }

        const feed = db
          .insert(schema.feeds)
          .values({
            name: "Reddit Feed",
            userId: user!.id,
            identifier: "test",
            aggregator: "reddit",
            logoSourceUrl: "",
          })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;
      });

      const favUrl = "https://www.reddit.com/favicon.ico";
      const logoModule = await import("@/lib/feeds/logo");
      vi.mocked(logoModule.fetchIconBytes).mockResolvedValue(null);
      vi.mocked(logoModule.discoverLogo).mockResolvedValue({
        url: favUrl,
        bytes: Buffer.from("fake-bytes"),
      });
      vi.mocked(logoModule.storeLogo).mockResolvedValue("some-content-hash");
      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockReturnValue({
        getSourceUrl: () => "https://www.reddit.com/r/test",
        logoImageUrl: async () => "https://styles.redditmedia.com/t5_x/icon.png",
      } as unknown as ReturnType<typeof factory.createAggregator>);

      const logoHandler = handlers.getHandler("feed.logo");
      const job = makeJob("feed.logo", { feedId });

      await logoHandler!(job);

      expect(logoModule.discoverLogo).toHaveBeenCalledWith("https://www.reddit.com/r/test");
      expect(logoModule.storeLogo).toHaveBeenCalledWith(feedId, expect.any(Buffer), favUrl);
    });
  });

  describe("reload", () => {
    it("logs and returns early when the payload has no articleId", async () => {
      const reloadHandler = handlers.getHandler("article.reload");
      expect(reloadHandler).toBeDefined();

      const job = makeJob("article.reload", {});

      await reloadHandler!(job);

      const lines = logLines(job.id);
      expect(lines).toEqual(["no articleId in payload, skipping"]);
    });

    it("logs and returns when the article is not found", async () => {
      const reloadHandler = handlers.getHandler("article.reload");
      expect(reloadHandler).toBeDefined();

      const job = makeJob("article.reload", { articleId: 999999 });

      await reloadHandler!(job);

      const lines = logLines(job.id);
      expect(lines).toEqual(["article not found, skipping"]);
    });

    it("always fetches from source rather than trusting anything already stored", async () => {
      vi.resetModules();
      const fetchArticleContent = vi.fn().mockResolvedValue("<p>Fresh from the source</p>");
      vi.doMock("@/lib/aggregators/factory", () => ({
        createAggregator: () => ({
          fetchArticleContent,
          extractHeaderElement: async () => null,
          extractContent: (html: string) => html,
          processContent: (html: string) => html,
        }),
      }));
      handlers = await import("./index");

      let articleId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }

        const feed = db
          .insert(schema.feeds)
          .values({ name: "Feed", userId: user!.id })
          .returning({ id: schema.feeds.id })
          .get();

        const article = db
          .insert(schema.articles)
          .values({
            name: "No Content",
            identifier: "https://example.com/art-1",
            feedId: feed.id,
            date: new Date(),
          })
          .returning({ id: schema.articles.id })
          .get();
        articleId = article.id;
      });

      const reloadHandler = handlers.getHandler("article.reload");
      const job = makeJob("article.reload", { articleId });

      await reloadHandler!(job);

      expect(fetchArticleContent).toHaveBeenCalledWith("https://example.com/art-1");

      const reloaded = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, articleId))
        .get();
      expect(reloaded?.plainText).toContain("Fresh from the source");
    });

    it("fails the job when the feed's AI options are configured but AI processing did not complete -- while still keeping the freshly fetched content", async () => {
      vi.resetModules();
      const fetchArticleContent = vi.fn().mockResolvedValue("<p>Fresh from the source</p>");
      vi.doMock("@/lib/aggregators/factory", () => ({
        createAggregator: () => ({
          fetchArticleContent,
          extractHeaderElement: async () => null,
          extractContent: (html: string) => html,
          processContent: (html: string) => html,
        }),
      }));
      handlers = await import("./index");

      // AI provider replies 429 on every attempt -- applyAiOptions() must
      // report this as a failure the job propagates, not a silent skip.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        json: async () => ({}),
      } as Response);

      let articleId = 0;
      client.writeTransaction((db) => {
        const user = db
          .insert(schema.users)
          .values({ id: "ai-user", email: "ai-user@example.com" })
          .returning({ id: schema.users.id })
          .get();
        db.insert(schema.userSettings)
          .values({
            userId: user.id,
            activeAiProvider: "gemini",
            geminiEnabled: true,
            geminiApiKey: "test-key",
            aiMaxRetries: 0,
          })
          .run();

        const feed = db
          .insert(schema.feeds)
          .values({
            name: "Feed",
            userId: user.id,
            options: { ai_translate: true, ai_translate_language: "German" },
          })
          .returning({ id: schema.feeds.id })
          .get();

        const article = db
          .insert(schema.articles)
          .values({
            name: "Has Content",
            identifier: "https://example.com/art-1",
            feedId: feed.id,
            plainText: "stale",
            date: new Date(),
          })
          .returning({ id: schema.articles.id })
          .get();
        articleId = article.id;
      });

      const reloadHandler = handlers.getHandler("article.reload");
      const job = makeJob("article.reload", { articleId });

      try {
        await expect(reloadHandler!(job)).rejects.toThrow(/AI processing did not complete/);

        // The refetch itself succeeded and was saved -- only the AI step failed.
        const reloaded = client
          .getDb()
          .select()
          .from(schema.articles)
          .where(eq(schema.articles.id, articleId))
          .get();
        expect(reloaded?.plainText).toContain("Fresh from the source");

        const lines = logLines(job.id);
        expect(lines).toContain("reloaded article content");
        expect(lines.some((l) => l.includes("providerError"))).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("re-fetches the original page and logs after reloading article content", async () => {
      vi.resetModules();
      const fetchArticleContent = vi.fn().mockResolvedValue("<p>Fresh from the source</p>");
      vi.doMock("@/lib/aggregators/factory", () => ({
        createAggregator: () => ({
          fetchArticleContent,
          extractHeaderElement: async () => null,
          extractContent: (html: string) => html,
          processContent: (html: string) => html,
        }),
      }));
      handlers = await import("./index");

      let articleId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }

        const feed = db
          .insert(schema.feeds)
          .values({ name: "Feed", userId: user!.id })
          .returning({ id: schema.feeds.id })
          .get();

        const article = db
          .insert(schema.articles)
          .values({
            name: "Has Content",
            identifier: "https://example.com/art-1",
            feedId: feed.id,
            plainText: "",
            date: new Date(),
          })
          .returning({ id: schema.articles.id })
          .get();
        articleId = article.id;
      });

      const reloadHandler = handlers.getHandler("article.reload");
      const job = makeJob("article.reload", { articleId });

      await reloadHandler!(job);

      expect(fetchArticleContent).toHaveBeenCalledWith("https://example.com/art-1");

      const reloaded = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, articleId))
        .get();
      expect(reloaded?.plainText).toContain("Fresh from the source");
      expect(reloaded?.plainText).not.toContain("Stale, previously stored");

      const lines = logLines(job.id);
      expect(lines).toContain("reloaded article content");
    });

    it("writes an error article and logs when the original page can no longer be fetched", async () => {
      vi.resetModules();
      vi.doMock("@/lib/aggregators/factory", () => ({
        createAggregator: () => ({
          fetchArticleContent: vi.fn().mockRejectedValue(new Error("HTTP 404 Not Found")),
          extractHeaderElement: async () => null,
          extractContent: (html: string) => html,
          processContent: (html: string) => html,
        }),
      }));
      handlers = await import("./index");

      let articleId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }

        const feed = db
          .insert(schema.feeds)
          .values({ name: "Feed", userId: user!.id })
          .returning({ id: schema.feeds.id })
          .get();

        const article = db
          .insert(schema.articles)
          .values({
            name: "Has Content",
            identifier: "https://example.com/gone",
            feedId: feed.id,
            plainText: "stale",
            date: new Date(),
          })
          .returning({ id: schema.articles.id })
          .get();
        articleId = article.id;
      });

      const reloadHandler = handlers.getHandler("article.reload");
      const job = makeJob("article.reload", { articleId });

      await reloadHandler!(job);

      const reloaded = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, articleId))
        .get();
      expect(reloaded?.plainText).toContain("could not be reloaded");
      expect(reloaded?.plainText).toContain("HTTP 404 Not Found");

      const lines = logLines(job.id);
      expect(lines).toContain("failed to refetch original page: HTTP 404 Not Found");
      expect(lines).toContain("wrote error article after failed refetch");
    });
  });

  describe("aggregate", () => {
    it("parses the aggregator's processed content, not the raw fetched page", async () => {
      vi.resetModules();
      vi.doMock("@/lib/aggregators/factory", () => ({
        createAggregator: () => ({
          aggregate: async () => [
            {
              identifier: "https://example.com/article-1",
              name: "Article One",
              // A full-website aggregator (Tagesschau, Heise, ...) always
              // populates raw_content with the whole fetched page -- nav,
              // header, footer included -- while `content` is what
              // extractContent()/processContent() actually distilled from it.
              raw_content:
                "<html><body><nav>Hauptnavigation Untermenü einblenden</nav>" +
                "<article><p>Real article body.</p></article></body></html>",
              content: "<p>Real article body.</p>",
              date: new Date("2024-01-01"),
              author: "",
            },
          ],
        }),
      }));
      handlers = await import("./index");

      let userId = "";
      let feedId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }
        userId = user!.id;

        const feed = db
          .insert(schema.feeds)
          .values({ name: "Test Feed", userId, aggregator: "full_website", enabled: true })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;
      });

      const aggregateHandler = handlers.getHandler("aggregate");
      expect(aggregateHandler).toBeDefined();

      await aggregateHandler!({
        id: 1,
        runId: null,
        userId: null,
        kind: "aggregate",
        payload: { feedId },
        status: "running",
        attempts: 1,
        maxAttempts: 3,
        priority: 0,
        runAt: new Date(),
        startedAt: new Date(),
        finishedAt: null,
        progress: 0,
        error: "",
        createdAt: new Date(),
      });

      const article = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.feedId, feedId))
        .get();
      expect(article).toBeDefined();
      expect(article!.plainText).toContain("Real article body");
      expect(article!.plainText).not.toContain("Hauptnavigation");
      expect(article!.plainText).not.toContain("Untermenü");
    });

    it("passes the feed owner's real user_settings row into aggregate(), not undefined", async () => {
      vi.resetModules();
      const aggregateMock = vi.fn().mockResolvedValue([]);
      vi.doMock("@/lib/aggregators/factory", () => ({
        createAggregator: () => ({ aggregate: aggregateMock }),
      }));
      handlers = await import("./index");

      let feedId = 0;
      client.writeTransaction((db) => {
        db.insert(schema.users).values({ id: "ai-user", email: "ai@example.com" }).run();
        db.insert(schema.userSettings)
          .values({ userId: "ai-user", activeAiProvider: "openai", openaiEnabled: true })
          .run();

        const feed = db
          .insert(schema.feeds)
          .values({
            name: "Test Feed",
            userId: "ai-user",
            aggregator: "full_website",
            enabled: true,
          })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;
      });

      const aggregateHandler = handlers.getHandler("aggregate");
      const job = makeJob("aggregate", { feedId });
      await aggregateHandler!(job);

      expect(aggregateMock).toHaveBeenCalledTimes(1);
      const [, , settingsArg] = aggregateMock.mock.calls[0]!;
      expect(settingsArg).toMatchObject({ userId: "ai-user", activeAiProvider: "openai" });
    });

    it("passes today's already-collected article count as collectedToday, not always 0", async () => {
      vi.resetModules();
      const aggregateMock = vi.fn().mockResolvedValue([]);
      vi.doMock("@/lib/aggregators/factory", () => ({
        createAggregator: () => ({ aggregate: aggregateMock }),
      }));
      handlers = await import("./index");

      let feedId = 0;
      client.writeTransaction((db) => {
        db.insert(schema.users).values({ id: "pacing-user", email: "pacing@example.com" }).run();
        const feed = db
          .insert(schema.feeds)
          .values({
            name: "Test Feed",
            userId: "pacing-user",
            aggregator: "full_website",
            enabled: true,
          })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;

        // Two articles already collected earlier today for this feed, one
        // yesterday (must not count), and one for a different feed (must not
        // count either).
        const otherFeed = db
          .insert(schema.feeds)
          .values({ name: "Other Feed", userId: "pacing-user", enabled: true })
          .returning({ id: schema.feeds.id })
          .get();

        db.insert(schema.articles)
          .values([
            { name: "A", identifier: "a1", feedId, date: new Date() },
            { name: "B", identifier: "a2", feedId, date: new Date() },
          ])
          .run();
        const yesterday = db
          .insert(schema.articles)
          .values({ name: "C", identifier: "a3", feedId, date: new Date() })
          .returning({ id: schema.articles.id })
          .get();
        db.run(
          sql`UPDATE articles SET created_at = ${Math.floor(Date.now() / 1000) - 90_000} WHERE id = ${yesterday.id}`,
        );
        db.insert(schema.articles)
          .values({ name: "D", identifier: "a4", feedId: otherFeed.id, date: new Date() })
          .run();
      });

      const aggregateHandler = handlers.getHandler("aggregate");
      const job = makeJob("aggregate", { feedId });
      await aggregateHandler!(job);

      expect(aggregateMock).toHaveBeenCalledTimes(1);
      const [, collectedTodayArg] = aggregateMock.mock.calls[0]!;
      expect(collectedTodayArg).toBe(2);
    });
  });

  describe("reload", () => {
    it("re-runs the aggregator's extraction on the freshly re-fetched page, not the raw page verbatim", async () => {
      vi.resetModules();
      const freshPage =
        "<html><body><nav>Hauptnavigation Untermenü einblenden</nav>" +
        "<article><p>Real article body.</p></article></body></html>";
      vi.doMock("@/lib/aggregators/factory", () => ({
        createAggregator: () => ({
          fetchArticleContent: vi.fn().mockResolvedValue(freshPage),
          // A stand-in for TagesschauAggregator's own extractContent/processContent:
          // strips everything outside <article>, mirroring what the real
          // pipeline distills from a full page fetch.
          extractHeaderElement: async () => null,
          extractContent: (html: string) => {
            const match = html.match(/<article>([\s\S]*)<\/article>/);
            return match ? match[1] : "";
          },
          processContent: (html: string) => html,
        }),
      }));
      handlers = await import("./index");

      let userId = "";
      let feedId = 0;
      let articleId = 0;
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }
        userId = user!.id;

        const feed = db
          .insert(schema.feeds)
          .values({ name: "Test Feed", userId, aggregator: "full_website", enabled: true })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;

        const article = db
          .insert(schema.articles)
          .values({
            name: "Article One",
            identifier: "https://example.com/article-1",
            feedId,
            date: new Date("2024-01-01"),
            // Stale on purpose: reload must not re-parse this, only a freshly
            // re-fetched page.
          })
          .returning({ id: schema.articles.id })
          .get();
        articleId = article.id;
      });

      const reloadHandler = handlers.getHandler("article.reload");
      expect(reloadHandler).toBeDefined();

      await reloadHandler!({
        id: 1,
        runId: null,
        userId: null,
        kind: "article.reload",
        payload: { articleId },
        status: "running",
        attempts: 1,
        maxAttempts: 3,
        priority: 0,
        runAt: new Date(),
        startedAt: new Date(),
        finishedAt: null,
        progress: 0,
        error: "",
        createdAt: new Date(),
      });

      const article = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, articleId))
        .get();
      expect(article!.plainText).toContain("Real article body");
      expect(article!.plainText).not.toContain("Stale body");
      expect(article!.plainText).not.toContain("Hauptnavigation");
      expect(article!.plainText).not.toContain("Untermenü");
    });
  });

  describe("reload credential and AI-option wiring", () => {
    it("resolves the feed owner's stored credentials before creating the aggregator", async () => {
      vi.resetModules();
      const createAggregatorMock = vi.fn((_feed: { options?: Record<string, unknown> }) => ({
        fetchArticleContent: vi.fn().mockResolvedValue("<p>Fresh from source</p>"),
        extractHeaderElement: async () => null,
        extractContent: (html: string) => html,
        processContent: (html: string) => html,
      }));
      vi.doMock("@/lib/aggregators/factory", () => ({
        createAggregator: createAggregatorMock,
      }));
      handlers = await import("./index");

      let feedId = 0;
      let articleId = 0;
      client.writeTransaction((db) => {
        db.insert(schema.users).values({ id: "yt-user", email: "yt@example.com" }).run();
        db.insert(schema.userSettings)
          .values({ userId: "yt-user", youtubeEnabled: true, youtubeApiKey: "yt-secret-key" })
          .run();

        const feed = db
          .insert(schema.feeds)
          .values({ name: "YT Feed", userId: "yt-user", aggregator: "youtube" })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;

        const article = db
          .insert(schema.articles)
          .values({
            name: "Video",
            identifier: "https://www.youtube.com/watch?v=abc123",
            feedId,
            date: new Date(),
          })
          .returning({ id: schema.articles.id })
          .get();
        articleId = article.id;
      });

      const reloadHandler = handlers.getHandler("article.reload");
      const job = makeJob("article.reload", { articleId });
      await reloadHandler!(job);

      expect(createAggregatorMock).toHaveBeenCalledTimes(1);
      const passedFeed = createAggregatorMock.mock.calls[0]![0];
      expect(passedFeed.options).toMatchObject({ youtube_api_key: "yt-secret-key" });
    });

    it("re-applies the feed's AI options (e.g. translation) to the freshly reloaded content", async () => {
      vi.resetModules();
      let contentSeenByAi = "";
      const applyAiOptionsMock = vi.fn(
        async (
          article: { name?: string; content?: string; [key: string]: unknown },
          _options?: Record<string, unknown> | null,
          _userSettings?: Record<string, unknown>,
        ) => {
          contentSeenByAi = article.content || "";
          article.name = "Translated Title";
          article.content = "<p>Translated content</p>";
          return article;
        },
      );
      vi.doMock("@/lib/ai/run", async (importOriginal) => {
        const actual = await importOriginal<typeof import("@/lib/ai/run")>();
        return { ...actual, applyAiOptions: applyAiOptionsMock };
      });
      vi.doMock("@/lib/aggregators/factory", () => ({
        createAggregator: () => ({
          fetchArticleContent: vi.fn().mockResolvedValue("<p>Fresh from source</p>"),
          extractHeaderElement: async () => null,
          extractContent: (html: string) => html,
          processContent: (html: string) => html,
        }),
      }));
      handlers = await import("./index");

      let feedId = 0;
      let articleId = 0;
      client.writeTransaction((db) => {
        db.insert(schema.users).values({ id: "ai-user", email: "ai@example.com" }).run();
        db.insert(schema.userSettings)
          .values({
            userId: "ai-user",
            activeAiProvider: "openai",
            openaiEnabled: true,
            openaiApiKey: "sk-test",
          })
          .run();

        const feed = db
          .insert(schema.feeds)
          .values({
            name: "Feed",
            userId: "ai-user",
            options: { ai_translate: true, ai_translate_language: "German" },
          })
          .returning({ id: schema.feeds.id })
          .get();
        feedId = feed.id;

        const article = db
          .insert(schema.articles)
          .values({
            name: "Original Title",
            identifier: "https://example.com/art-1",
            feedId,
            date: new Date(),
          })
          .returning({ id: schema.articles.id })
          .get();
        articleId = article.id;
      });

      const reloadHandler = handlers.getHandler("article.reload");
      const job = makeJob("article.reload", { articleId });
      await reloadHandler!(job);

      expect(applyAiOptionsMock).toHaveBeenCalledTimes(1);
      const [, optionsArg, settingsArg] = applyAiOptionsMock.mock.calls[0]!;
      expect(contentSeenByAi).toBe("<p>Fresh from source</p>");
      expect(optionsArg).toMatchObject({ ai_translate: true });
      expect(settingsArg).toMatchObject({ userId: "ai-user", activeAiProvider: "openai" });

      const reloaded = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, articleId))
        .get();
      expect(reloaded?.name).toBe("Translated Title");
      expect(reloaded?.plainText).toContain("Translated content");
    });
  });
});
