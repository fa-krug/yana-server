import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";
import { BaseAggregator, FeedLike, RawArticle } from "./base";
import { rawArticleContentHash } from "./content-hash";

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

  it("passes userSettings through aggregate to finalizeArticles and applyAiProcessing", async () => {
    const feed: FeedLike = {
      identifier: "https://example.com/rss",
      dailyLimit: 20,
      options: { ai_summarize: true },
    };
    const agg = new TestAggregator(feed);
    let passedSettings: unknown = null;
    agg.finalizeArticles = async (articles, userSettings) => {
      passedSettings = userSettings;
      return articles;
    };
    const mockSettings = { activeAiProvider: "gemini" };
    await agg.aggregate(undefined, 0, mockSettings);
    expect(passedSettings).toBe(mockSettings);
  });

  it("reports coarse progress after each pipeline stage, in increasing order", async () => {
    const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
    const agg = new TestAggregator(feed);
    const reported: number[] = [];

    await agg.aggregate(undefined, 0, undefined, (percent) => reported.push(percent));

    expect(reported).toEqual([10, 20, 60, 80]);
  });

  it("reports no progress at all when the run limit is 0", async () => {
    const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 5 };
    const agg = new TestAggregator(feed);
    const reported: number[] = [];

    await agg.aggregate(
      () => new Date(),
      5,
      undefined,
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
  describe("fingerprintArticles: not paying a provider for an article we already have", () => {
    const DATE = new Date("2026-01-01T00:00:00.000Z");

    /** Two fixed articles, so their fingerprints are stable across runs. */
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
            date: DATE,
          },
          {
            name: "Second",
            identifier: "https://example.com/2",
            raw_content: "",
            content: "<p>Two.</p>",
            date: DATE,
          },
        ];
      }
    }

    const aiFeed = (): FeedLike => ({
      identifier: "https://example.com/rss",
      dailyLimit: 20,
      maxArticleAgeDays: 0,
      options: { ai_summarize: true },
    });

    const settings = {
      activeAiProvider: "openai",
      openaiEnabled: true,
      openaiApiKey: "sk-test",
      aiRequestDelay: 0,
    };

    /** Counts outbound provider requests -- the thing that costs money. */
    function countingFetch(): () => number {
      let calls = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        calls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '{"summary":"S."}' } }] }),
        } as Response;
      });
      return () => calls;
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("sends no provider request for an article whose stored hash still matches", async () => {
      const calls = countingFetch();
      const agg = new FixedAggregator(aiFeed());

      // What the first run would have stored for article 1, and nothing for 2.
      const stored = rawArticleContentHash({
        name: "First",
        content: "<p>One.</p>",
        raw_content: "",
        date: DATE,
      });
      agg.storedContentHash = (identifier) =>
        identifier === "https://example.com/1" ? stored : null;

      const articles = await agg.aggregate(undefined, 0, settings);

      // One request, for the article that is actually new. Before the
      // fingerprint moved ahead of `finalizeArticles()`, this was two -- and
      // two again on the next run, and every run after it, because the skip
      // that existed sat downstream of the call it needed to prevent.
      expect(calls()).toBe(1);
      expect(articles[0].unchanged).toBe(true);
      expect(articles[1].unchanged).toBe(false);
      expect(articles[0].content).toBe("<p>One.</p>");
      expect(articles[1].content).toContain("yana-ai-summary");
    });

    it("sends no request at all when every article is already stored unchanged", async () => {
      const calls = countingFetch();
      const agg = new FixedAggregator(aiFeed());
      const hashes = new Map([
        [
          "https://example.com/1",
          rawArticleContentHash({
            name: "First",
            content: "<p>One.</p>",
            raw_content: "",
            date: DATE,
          }),
        ],
        [
          "https://example.com/2",
          rawArticleContentHash({
            name: "Second",
            content: "<p>Two.</p>",
            raw_content: "",
            date: DATE,
          }),
        ],
      ]);
      agg.storedContentHash = (identifier) => hashes.get(identifier) ?? null;

      await agg.aggregate(undefined, 0, settings);

      expect(calls()).toBe(0);
    });

    it("fingerprints every article and marks none unchanged with no hook set", async () => {
      const calls = countingFetch();
      const agg = new FixedAggregator(aiFeed());

      const articles = await agg.aggregate(undefined, 0, settings);

      // The hook is what `aggregate.ts` sets; unset (reload.ts, and every test
      // that builds an aggregator directly) the behaviour is what it always
      // was -- every article processed -- but the fingerprint is still
      // computed, because the job handler reads it back instead of deriving
      // its own from an article AI has already rewritten.
      expect(calls()).toBe(2);
      expect(articles.every((a) => a.unchanged === false)).toBe(true);
      expect(articles.every((a) => typeof a.content_hash === "string")).toBe(true);
    });

    it("stops the fingerprint depending on what the model returned", async () => {
      countingFetch();
      const agg = new FixedAggregator(aiFeed());
      const first = await agg.aggregate(undefined, 0, settings);
      const firstHashes = first.map((a) => a.content_hash);

      // A different summary on the second run -- which is the normal case at
      // any temperature above zero. The fingerprint must not move with it, or
      // no article is ever "unchanged" and the skip is dead code.
      globalThis.fetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"summary":"A completely different summary."}' } }],
        }),
      })) as unknown as typeof fetch;

      const second = await new FixedAggregator(aiFeed()).aggregate(undefined, 0, settings);

      expect(second.map((a) => a.content_hash)).toEqual(firstHashes);
    });
  });
});
