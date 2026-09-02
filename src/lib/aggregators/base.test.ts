import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";
import { sourceFingerprint } from "./source-fingerprint";
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

  /**
   * The outcome of each AI call used to be thrown away here, which left an
   * article whose translation failed indistinguishable from one that never
   * asked for a translation -- see `RawArticle.ai_failed_reason` and what
   * `src/lib/jobs/handlers/aggregate.ts` does with it.
   */
  it("marks each article whose configured AI post-processing did not complete", async () => {
    const feed: FeedLike = {
      identifier: "https://example.com/rss",
      dailyLimit: 20,
      options: { ai_translate: true, ai_translate_language: "German" },
    };

    // No settings at all, so `applyAiOptions()` fails on `noProvider` before
    // reaching a network call -- a real failure mode (nobody picked a
    // provider) and the one that needs no stubbing.
    const articles = await new TestAggregator(feed).aggregate(undefined, 0, undefined);

    expect(articles).not.toHaveLength(0);
    for (const article of articles) {
      expect(article.ai_failed_reason).toBe("noProvider");
    }
  });

  it("leaves the mark off when the feed configured no AI options at all", async () => {
    const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20, options: {} };

    const articles = await new TestAggregator(feed).aggregate(undefined, 0, undefined);

    expect(articles).not.toHaveLength(0);
    for (const article of articles) {
      expect(article.ai_failed_reason).toBeUndefined();
    }
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

    /**
     * **The AI call is skipped when the source has not moved.**
     *
     * AI post-processing runs before the handler compares anything, so the
     * handler's unchanged-skip never saved the provider call: a feed with
     * translation on re-translated its whole window every cycle -- 480-960
     * calls a day for one feed at the default interval. `articles.sourceHash`
     * is the pre-AI fingerprint that makes the question answerable here.
     */
    describe("applyAiProcessing's source-fingerprint skip", () => {
      const ARTICLE = {
        name: "Original",
        identifier: "https://example.com/1",
        raw_content: "",
        content: "<p>original language</p>",
        date: new Date("2026-01-01T00:00:00.000Z"),
      };

      /** A feed with AI options, and the article already stored against it. */
      function seed(sourceHash: string | null): FeedLike {
        let feedId = 0;
        client.writeTransaction((db) => {
          // Tolerant of a second call in the same test: `users.email` is
          // unique, and one case seeds twice to compare a skipped article
          // with a processed one.
          db.insert(schema.users)
            .values({ id: "u1", email: "u1@example.com" })
            .onConflictDoNothing()
            .run();
          const feed = db
            .insert(schema.feeds)
            .values({ name: "Feed", userId: "u1" })
            .returning({ id: schema.feeds.id })
            .get();
          feedId = feed.id;
          db.insert(schema.articles)
            .values({
              feedId,
              name: "Übersetzt",
              identifier: ARTICLE.identifier,
              plainText: "ursprache",
              date: ARTICLE.date,
              sourceHash,
            })
            .run();
        });
        return {
          id: feedId,
          identifier: "https://example.com/rss",
          dailyLimit: 20,
          userId: "u1",
          options: { ai_translate: true, ai_translate_language: "German" },
        };
      }

      /**
       * Runs the pipeline with no provider reachable, so a call that *is* made
       * shows up as `ai_failed_reason` -- there is no active provider in these
       * settings. Skipped articles come back with neither that nor a rewrite.
       */
      async function run(feed: FeedLike) {
        const agg = makeAggregator(feed);
        return agg.finalizeArticles([{ ...ARTICLE }], undefined);
      }

      it("skips an article whose stored sourceHash still matches", async () => {
        const fingerprint = sourceFingerprint(ARTICLE);
        const [article] = await run(seed(fingerprint));

        expect(article.source_unchanged).toBe(true);
        // No provider was reached, so nothing failed and nothing was rewritten.
        expect(article.ai_failed_reason).toBeUndefined();
        expect(article.content).toBe(ARTICLE.content);
      });

      it("processes an article whose source text changed", async () => {
        const [article] = await run(seed(sourceFingerprint({ ...ARTICLE, name: "Older" })));

        expect(article.source_unchanged).toBeUndefined();
        expect(article.ai_failed_reason).toBe("noProvider");
      });

      /**
       * A null fingerprint means "needs work" -- the row was never completed
       * (a failed reload's error notice, an AI pass that didn't finish, a row
       * predating the column). It must be reprocessed even though the source
       * it came from has not moved, which is the bug the reload-error-notice
       * case in `handlers.test.ts` exists to catch.
       */
      it("processes an article whose stored fingerprint is null", async () => {
        const [article] = await run(seed(null));

        expect(article.source_unchanged).toBeUndefined();
        expect(article.ai_failed_reason).toBe("noProvider");
      });

      it("processes everything for a feed it has never stored an article for", async () => {
        const feed = seed(sourceFingerprint(ARTICLE));
        const [article] = await run({ ...feed, id: (feed.id as number) + 1 });

        expect(article.source_unchanged).toBeUndefined();
      });

      /**
       * A feed can carry options that ask for no AI at all -- a header image
       * toggled off, comments turned on. Such a feed must keep the
       * pre-`sourceHash` behaviour exactly: there is no provider call to save,
       * and the handler applies the identical comparison anyway. Fingerprinting
       * it here would trade nothing for a second skip path.
       */
      it("does not fingerprint or skip a feed whose options ask for no AI", async () => {
        const feed = seed(sourceFingerprint(ARTICLE));
        const [article] = await run({ ...feed, options: { include_header_image: false } });

        expect(article.source_unchanged).toBeUndefined();
        expect(article.source_hash).toBeUndefined();
      });

      it("hands the handler the pre-AI fingerprint on every article, skipped or not", async () => {
        const fingerprint = sourceFingerprint(ARTICLE);

        const [skipped] = await run(seed(fingerprint));
        expect(skipped.source_hash).toBe(fingerprint);

        client.writeTransaction((db) => {
          db.delete(schema.articles).run();
        });
        const [processed] = await run(seed(null));
        // Taken *before* the AI call, so it is the source's fingerprint even
        // on an article a provider would have rewritten.
        expect(processed.source_hash).toBe(fingerprint);
      });
    });
  });
});
