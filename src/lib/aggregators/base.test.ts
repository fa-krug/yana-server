import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";
import { BaseAggregator, FeedLike, RawArticle } from "./base";

class TestAggregator extends BaseAggregator {
  public fetchedLimit?: number;

  async fetchSourceData(limit?: number): Promise<unknown> {
    this.fetchedLimit = limit;
    return [
      {
        name: "Recent Article",
        identifier: "https://example.com/1",
        raw_content: "",
        content: "Content 1",
        date: new Date(),
      },
      {
        name: "Old Article",
        identifier: "https://example.com/2",
        raw_content: "",
        content: "Content 2",
        date: new Date(Date.now() - 70 * 24 * 60 * 60 * 1000), // 70 days old
      },
    ];
  }

  async parseToRawArticles(sourceData: unknown): Promise<RawArticle[]> {
    return sourceData as RawArticle[];
  }

  public chromeLabelsForTest() {
    return this.chromeLabels();
  }
}

describe("BaseAggregator", () => {
  it("validates that feed identifier is present", () => {
    const feed: FeedLike = { identifier: "", dailyLimit: 20 };
    const agg = new TestAggregator(feed);
    expect(() => agg.validate()).toThrow("Feed identifier is required");
  });

  it("returns 0 run limit when daily limit is reached", () => {
    const feed: FeedLike = { identifier: "test", dailyLimit: 5 };
    const agg = new TestAggregator(feed);
    expect(agg.getCurrentRunLimit(() => new Date(), 5)).toBe(0);
  });

  it("filters articles older than maxArticleAgeDays", async () => {
    const feed: FeedLike = { identifier: "test", dailyLimit: 20, maxArticleAgeDays: 30 };
    const agg = new TestAggregator(feed);
    const articles = await agg.fetchSourceData().then((data) => agg.parseToRawArticles(data));
    const filtered = await agg.filterArticles(articles);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("Recent Article");
  });

  describe("chromeLabels", () => {
    let dbPath: string;
    let client: typeof import("../db/client");
    let schema: typeof import("../db/schema");
    let base: typeof import("./base");

    // `base.test.ts`'s own top-level `import { BaseAggregator } from "./base"`
    // (used by the three tests above) is resolved once, before this
    // `beforeEach` ever runs -- and it drags in `./chrome-labels`, which
    // statically imports `getDb`/`DB_PATH` from `../db/client`. That module
    // instance's `DB_PATH` constant is fixed at import time from whatever
    // `process.env.DATABASE_PATH` happened to be *then* (unset, on a fresh
    // checkout), and `vi.resetModules()` below cannot retroactively change an
    // already-bound reference. So exercising `chromeLabels()` here needs its
    // own dynamically-imported `./base` -- loaded fresh, after
    // `DATABASE_PATH` is set and the registry is reset -- exactly the pattern
    // `chrome-labels.test.ts` already uses for the same reason.
    beforeEach(async () => {
      vi.resetModules();
      dbPath = path.join(
        os.tmpdir(),
        `yana-baseagg-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
      );
      process.env.DATABASE_PATH = dbPath;
      applyMigrationsAt(dbPath);

      client = await import("../db/client");
      schema = await import("../db/schema");
      base = await import("./base");
    });

    afterEach(() => {
      delete process.env.DATABASE_PATH;
      const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
      if (connection.open) connection.close();
      for (const suffix of ["", "-shm", "-wal"]) {
        fs.rmSync(`${dbPath}${suffix}`, { force: true });
      }
    });

    function makeAggregator(feed: FeedLike) {
      class DynamicTestAggregator extends base.BaseAggregator {
        async fetchSourceData(): Promise<unknown> {
          return [];
        }
        async parseToRawArticles(sourceData: unknown): Promise<RawArticle[]> {
          return sourceData as RawArticle[];
        }
        public chromeLabelsForTest() {
          return this.chromeLabels();
        }
      }
      return new DynamicTestAggregator(feed);
    }

    it("memoizes the resolved labels for the lifetime of the aggregator instance", async () => {
      client.writeTransaction((db) => {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        db.insert(schema.userSettings).values({ userId: "user1", language: "de" }).run();
      });

      const feed: FeedLike = { identifier: "test", dailyLimit: 20, userId: "user1" };
      const agg = makeAggregator(feed);

      const first = await agg.chromeLabelsForTest();
      expect(first.comments).toBe("Kommentare");

      // Delete the row entirely: a second, un-memoized call would fall back to
      // English (no row found), so getting German back proves the first
      // resolution was cached rather than re-queried.
      client.writeTransaction((db) => {
        db.delete(schema.userSettings).run();
      });

      const second = await agg.chromeLabelsForTest();
      expect(second.comments).toBe("Kommentare");
      expect(second).toBe(first);
    });

    it("falls back to English defaults with no database access when the feed has no userId", async () => {
      const feed: FeedLike = { identifier: "test", dailyLimit: 20 };
      const agg = makeAggregator(feed);

      const labels = await agg.chromeLabelsForTest();
      expect(labels.comments).toBe("Comments");
    });
  });
});
