import { describe, expect, it } from "vitest";

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
}

describe("BaseAggregator", () => {
  it("validates that feed identifier is present", () => {
    const feed: FeedLike = { identifier: "", dailyLimit: 20 };
    const agg = new TestAggregator(feed);
    expect(() => agg.validate()).toThrow("Feed identifier is required");
  });

  it("returns 0 run limit when daily limit is reached", () => {
    const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 10 };
    const agg = new TestAggregator(feed);
    expect(agg.getCurrentRunLimit(undefined, 10)).toBe(0);
    expect(agg.getCurrentRunLimit(undefined, 12)).toBe(0);
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

  it("filters articles older than 30 days by default", async () => {
    const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
    const agg = new TestAggregator(feed);
    const articles = await agg.aggregate();
    expect(articles).toHaveLength(1);
    expect(articles[0].name).toBe("Recent Article");
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
});
