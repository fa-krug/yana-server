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
    expect(agg.getCurrentRunLimit(undefined, 12)).toBe(0);
  });

  it("filters articles older than maxArticleAgeDays", async () => {
    const feed: FeedLike = { identifier: "test", dailyLimit: 20, maxArticleAgeDays: 30 };
    const agg = new TestAggregator(feed);
    const articles = await agg.fetchSourceData().then((data) => agg.parseToRawArticles(data));
    const filtered = await agg.filterArticles(articles);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("Recent Article");
  });

  it("filters articles older than 30 days by default", async () => {
    const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
    const agg = new TestAggregator(feed);
    const articles = await agg.aggregate();
    expect(articles).toHaveLength(1);
    expect(articles[0].name).toBe("Recent Article");
  });

  it("applies morning aggression before 10 AM", () => {
    const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
    const agg = new TestAggregator(feed);
    // 8 AM clock
    const morningClock = () => new Date("2026-08-02T08:00:00Z");
    const limit = agg.getCurrentRunLimit(morningClock, 0);
    // 40% of remaining 20 is 8
    expect(limit).toBeGreaterThanOrEqual(8);
  });

  it("calculates adaptive limit in afternoon", () => {
    const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
    const agg = new TestAggregator(feed);
    // 2 PM clock (14:00)
    const afternoonClock = () => new Date("2026-08-02T14:00:00Z");
    const limit = agg.getCurrentRunLimit(afternoonClock, 0);
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(20);
  });

  it("defaults maxArticleAgeDays to 30 when the feed omits it", () => {
    const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
    const agg = new TestAggregator(feed);
    expect(agg.maxArticleAgeDays).toBe(30);
  });

  it("uses the feed's own maxArticleAgeDays when set", async () => {
    const feed: FeedLike = {
      identifier: "https://example.com/rss",
      dailyLimit: 20,
      maxArticleAgeDays: 90,
    };
    const agg = new TestAggregator(feed);
    expect(agg.maxArticleAgeDays).toBe(90);
    const articles = await agg.aggregate();
    expect(articles).toHaveLength(2);
  });

  it("disables the age filter entirely when maxArticleAgeDays is 0", async () => {
    const feed: FeedLike = {
      identifier: "https://example.com/rss",
      dailyLimit: 20,
      maxArticleAgeDays: 0,
    };
    const agg = new TestAggregator(feed);
    const articles = await agg.aggregate();
    expect(articles).toHaveLength(2);
  });

  it("defaults concurrency to 4 when the feed omits it", () => {
    const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
    const agg = new TestAggregator(feed);
    expect(agg.concurrency).toBe(4);
  });

  it("uses the feed's own concurrency when set", () => {
    const feed: FeedLike = {
      identifier: "https://example.com/rss",
      dailyLimit: 20,
      concurrency: 2,
    };
    const agg = new TestAggregator(feed);
    expect(agg.concurrency).toBe(2);
  });

  it("hands finalizeArticles the pipeline's articles, and nothing else", async () => {
    // `aggregate()` used to thread the owner's `userSettings` down to
    // `finalizeArticles()`, for one consumer: the AI stage. That stage works on
    // the block tree now and runs in the job handler, so the parameter went
    // with it -- an aggregator has no business reading a user's AI credentials.
    const feed: FeedLike = {
      identifier: "https://example.com/rss",
      dailyLimit: 20,
      options: { ai_summarize: true },
    };
    const agg = new TestAggregator(feed);
    let receivedArgs: unknown[] = [];
    agg.finalizeArticles = async (...args) => {
      receivedArgs = args;
      return args[0];
    };

    const out = await agg.aggregate(undefined, 0);

    // Both halves matter, and the arity is the half that has to be read off the
    // *base class* rather than off this stub: a `length` taken from the arrow
    // above would only ever report what this test itself declared.
    expect(receivedArgs).toEqual([out]);
    expect(BaseAggregator.prototype.finalizeArticles.length).toBe(1);
  });

  it("reports coarse progress after each pipeline stage, in increasing order", async () => {
    const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
    const agg = new TestAggregator(feed);
    const reported: number[] = [];

    await agg.aggregate(undefined, 0, (percent) => reported.push(percent));

    expect(reported).toEqual([10, 20, 60, 80]);
  });

  it("reports no progress at all when the run limit is 0", async () => {
    const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 5 };
    const agg = new TestAggregator(feed);
    const reported: number[] = [];

    await agg.aggregate(
      () => new Date(),
      5,
      (percent) => reported.push(percent),
    );

    expect(reported).toEqual([]);
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
  describe("the pipeline no longer runs AI", () => {
    class FixedAggregator extends BaseAggregator {
      async fetchSourceData(): Promise<unknown> {
        return null;
      }
      async parseToRawArticles(): Promise<RawArticle[]> {
        return [
          {
            name: "First",
            identifier: "https://example.com/1",
            raw_content: "",
            content: "<p>One.</p>",
            date: new Date("2026-01-01T00:00:00.000Z"),
          },
        ];
      }
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("makes no provider request, even with AI options set and a provider configured", async () => {
      const calls = vi.fn();
      globalThis.fetch = calls;

      const agg = new FixedAggregator({
        identifier: "https://example.com/rss",
        dailyLimit: 20,
        maxArticleAgeDays: 0,
        options: { ai_summarize: true, ai_improve_writing: true },
      });

      const articles = await agg.aggregate(undefined, 0);

      // AI moved to the job handlers, which is where `parseBlocks()` runs and
      // therefore the only place a block tree exists to work on. There is no
      // longer even a way to hand an aggregator the credentials it would need:
      // `aggregate()` takes no `userSettings`. It would also be doing it for
      // articles the
      // handler is about to skip as unchanged.
      expect(calls).not.toHaveBeenCalled();
      expect(articles[0].content).toBe("<p>One.</p>");
    });

    it("leaves finalizeArticles an identity the site aggregators extend", async () => {
      const agg = new FixedAggregator({ identifier: "x", dailyLimit: 20, maxArticleAgeDays: 0 });
      const input = await agg.parseToRawArticles();

      expect(await agg.finalizeArticles(input)).toBe(input);
    });
  });
});
