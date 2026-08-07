import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      expect(lines).toContain("upserted articles: 2 created, 0 updated");
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
            rawContent: "<p>stale</p>",
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
      expect(lines).toContain("upserted articles: 0 created, 1 updated");
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

    it("logs and returns when the article is not found or has no stored content", async () => {
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
            identifier: "art-1",
            feedId: feed.id,
            rawContent: "",
            date: new Date(),
          })
          .returning({ id: schema.articles.id })
          .get();
        articleId = article.id;
      });

      const reloadHandler = handlers.getHandler("article.reload");
      expect(reloadHandler).toBeDefined();

      const job = makeJob("article.reload", { articleId });

      await reloadHandler!(job);

      const lines = logLines(job.id);
      expect(lines).toEqual(["article not found or has no stored content, skipping"]);
    });

    it("logs after reloading article content", async () => {
      vi.resetModules();
      vi.doMock("@/lib/aggregators/factory", () => ({
        createAggregator: () => ({
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
            identifier: "art-1",
            feedId: feed.id,
            rawContent: "<p>Hello world</p>",
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

      const reloaded = client
        .getDb()
        .select()
        .from(schema.articles)
        .where(eq(schema.articles.id, articleId))
        .get();
      expect(reloaded?.plainText).toContain("Hello world");

      const lines = logLines(job.id);
      expect(lines).toContain("reloaded article content");
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

      // articles.rawContent must be the true raw page (nav included), never
      // the already-distilled `content` -- reload.ts re-runs extractContent()
      // against whatever is stored here on the assumption that it's a full
      // page. Storing `content` there instead silently breaks reload: the
      // site-specific markers extractContent() looks for are already gone,
      // so it finds no body text and overwrites the article with just its
      // header image.
      expect(article!.rawContent).toContain("Hauptnavigation");
      expect(article!.rawContent).toContain("Real article body");
    });
  });

  describe("reload", () => {
    it("re-runs the aggregator's extraction on raw_content instead of re-parsing the raw page verbatim", async () => {
      vi.resetModules();
      vi.doMock("@/lib/aggregators/factory", () => ({
        createAggregator: () => ({
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
            rawContent:
              "<html><body><nav>Hauptnavigation Untermenü einblenden</nav>" +
              "<article><p>Real article body.</p></article></body></html>",
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
      expect(article!.plainText).not.toContain("Hauptnavigation");
      expect(article!.plainText).not.toContain("Untermenü");
    });
  });
});
