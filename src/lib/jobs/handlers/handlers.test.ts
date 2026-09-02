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

    it("rewrites an article when new comments are appended to its body", async () => {
      const feedId = seedAggregateFeed();

      const withoutComment = {
        name: "Reddit Post",
        identifier: "art-1",
        raw_content: "<p>post</p>",
        content: "<p>post</p>",
        date: new Date("2026-01-01T00:00:00.000Z"),
      };
      // What the Reddit aggregator actually produces on a later run: the
      // comment section is rendered into the article body, so a new comment
      // changes the content the block tree is built from.
      const withComment = {
        ...withoutComment,
        raw_content:
          "<p>post</p><blockquote><p><strong>ada</strong></p><div>nice</div></blockquote>",
        content: "<p>post</p><blockquote><p><strong>ada</strong></p><div>nice</div></blockquote>",
      };

      const factory = await import("@/lib/aggregators/factory");
      const aggregateHandler = handlers.getHandler("aggregate");

      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => [withoutComment],
      } as unknown as ReturnType<typeof factory.createAggregator>);
      await aggregateHandler!(makeJob("aggregate", { feedId }));

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

    it("rewrites an article whose stored contentHash is null", async () => {
      const feedId = seedAggregateFeed();

      // Every row that predates the column is in this state. It must be
      // treated as changed exactly once, then settle.
      client.writeTransaction((db) => {
        db.insert(schema.articles)
          .values({
            name: "Legacy",
            identifier: "art-1",
            feedId,
            rawContent: "<p>x</p>",
            date: new Date("2026-01-01T00:00:00.000Z"),
            contentHash: null,
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

    it("keeps the write-loop's progress() calls to a small, bounded number of distinct values for a large feed", async () => {
      // This pins the property that actually turns 200 progress() calls into
      // roughly 20 writes/SSE events: the per-article expression in
      // aggregate.ts is `80 + Math.floor(((i + 1) / total) * 20)`, which only
      // takes on ~20 distinct integers no matter how large `total` is, and
      // progress()'s own read-before-write dedupe (queue.ts) only publishes
      // on a genuine change. Nothing here exercises that dedupe directly --
      // this test is about the *input* to it. If someone widened the
      // expression's resolution (say, to `Math.floor(((i + 1) / total) *
      // 2000)`), every one of those 200 calls would produce a distinct
      // percentage, defeating the dedupe entirely: 200 write transactions
      // and 200 SSE frames per job instead of ~20. That regression would not
      // fail any test that only checks final state (all of them settle on
      // progress: 100 either way), so the assertion below is on the *number
      // of distinct values requested*, not on the final progress.
      const feedId = seedAggregateFeed();
      const total = 200;
      const rawArticles = Array.from({ length: total }, (_, i) => ({
        name: `Article ${i}`,
        identifier: `art-${i}`,
        raw_content: `<p>body ${i}</p>`,
        content: `<p>body ${i}</p>`,
        date: new Date(),
      }));

      const factory = await import("@/lib/aggregators/factory");
      vi.mocked(factory.createAggregator).mockReturnValue({
        aggregate: async () => rawArticles,
      } as unknown as ReturnType<typeof factory.createAggregator>);

      const progressSpy = vi.spyOn(queue, "progress");

      const aggregateHandler = handlers.getHandler("aggregate");
      const job = makeJob("aggregate", { feedId });
      await aggregateHandler!(job);

      const percentagesRequested = progressSpy.mock.calls
        .filter(([id]) => id === job.id)
        .map(([, percent]) => percent);

      expect(percentagesRequested.length).toBe(total);

      const distinctCount = new Set(percentagesRequested).size;
      // The write loop's expression only spans the 80-100 range and steps by
      // 1/20th of the way through `total` articles each time it advances --
      // 21 possible integer values (80 through 100 inclusive), never more,
      // regardless of `total`. A generous upper bound (25) keeps this test
      // from being brittle about the exact boundary rounding while still
      // catching an order-of-magnitude regression like the one described
      // above.
      expect(distinctCount).toBeLessThanOrEqual(25);
      expect(distinctCount).toBeGreaterThan(1);
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

    it("still fetches from source when the article has no previously stored rawContent", async () => {
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
            rawContent: "",
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
      expect(reloaded?.rawContent).toBe("<p>Fresh from the source</p>");
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
            rawContent: "<p>Stale, previously stored</p>",
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
        expect(reloaded?.rawContent).toBe("<p>Fresh from the source</p>");
        expect(reloaded?.plainText).toContain("Fresh from the source");

        const lines = logLines(job.id);
        expect(lines).toContain("reloaded article content");
        expect(lines.some((l) => l.includes("providerError"))).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    /**
     * Builds the fixture shared by the reload-happy-path tests: a mocked
     * aggregator whose `fetchArticleContent` succeeds, a user/feed/article
     * row, and a real `article.reload` job row. Factored out because both
     * the plain content-reload assertions below and the progress-reporting
     * test need the identical setup -- duplicating it would drift the two
     * apart the next time either changed.
     */
    async function seedReloadJob(): Promise<{
      job: ReturnType<typeof makeJob>;
      articleId: number;
      userId: string;
      fetchArticleContent: ReturnType<typeof vi.fn>;
    }> {
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
      let userId = "";
      client.writeTransaction((db) => {
        let user = db.select().from(schema.users).limit(1).get();
        if (!user) {
          db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
          user = db.select().from(schema.users).limit(1).get();
        }
        userId = user!.id;

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
            rawContent: "<p>Stale, previously stored</p>",
            plainText: "",
            date: new Date(),
          })
          .returning({ id: schema.articles.id })
          .get();
        articleId = article.id;
      });

      const job = makeJob("article.reload", { articleId });
      return { job, articleId, userId, fetchArticleContent };
    }

    it("re-fetches the original page and logs after reloading article content", async () => {
      const { job, articleId, fetchArticleContent } = await seedReloadJob();

      const reloadHandler = handlers.getHandler("article.reload");
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
      expect(reloaded?.rawContent).toBe("<p>Fresh from the source</p>");

      const lines = logLines(job.id);
      expect(lines).toContain("reloaded article content");
    });

    it("reports progress while reloading and reaches 100 on success", async () => {
      const { job, articleId, userId } = await seedReloadJob();
      const { getJob } = await import("@/lib/jobs/queue");
      const { subscribeUserEvents } = await import("@/lib/api/events");
      const { handleReloadJob } = await import("./reload");

      expect(getJob(job.id)!.progress).toBe(0);

      // Asserting only the final stored value (100) would still pass if the
      // intermediate progress(job.id, 5|30|55|80) calls were deleted and
      // only the last one survived -- exactly the regression this test
      // exists to catch. Subscribing to the job's own SSE event stream (the
      // same mechanism `queue.progress()`'s dedupe-and-publish drives, see
      // `queue.test.ts`'s "job/run events" suite) observes every individual
      // call in order, not just where progress ends up.
      const heard: unknown[] = [];
      const unsubscribe = subscribeUserEvents(userId, (event) => heard.push(event));
      await handleReloadJob(job);
      unsubscribe();

      const progressSequence = heard
        .filter(
          (event): event is { type: "job"; payload: { jobId: number; progress: number } } =>
            typeof event === "object" &&
            event !== null &&
            (event as { type?: unknown }).type === "job" &&
            (event as { payload?: { jobId?: unknown } }).payload?.jobId === job.id,
        )
        .map((event) => event.payload.progress);
      expect(progressSequence).toEqual([5, 30, 55, 80, 100]);

      expect(getJob(job.id)!.progress).toBe(100);
      expect(articleId).toBeGreaterThan(0);
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
            rawContent: "<p>Stale, previously stored</p>",
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
      // The stale raw page is left alone -- there is no fresh page to replace it with.
      expect(reloaded?.rawContent).toBe("<p>Stale, previously stored</p>");

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
            rawContent: "<html><body><article><p>Stale body.</p></article></body></html>",
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
      expect(article!.rawContent).toBe(freshPage);
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
            rawContent: "<p>stale</p>",
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
            rawContent: "<p>stale</p>",
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
