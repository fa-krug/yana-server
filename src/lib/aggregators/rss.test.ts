import { describe, expect, it, vi } from "vitest";

import { FeedLike } from "./base";
import { RssAggregator } from "./rss";
import { ParsedFeed, parseXmlFeed } from "./rss-parser";

describe("RssAggregator", () => {
  it("parses feed items into RawArticle objects with unescaped metadata", async () => {
    const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
    const agg = new RssAggregator(feed);

    const sourceData: ParsedFeed = {
      title: "Example Feed",
      entries: [
        {
          title: "Apple&#8217;s New M4 Chip",
          link: "https://example.com/m4",
          summary: "<p>Article summary</p>",
          published: "Sun, 02 Aug 2026 10:00:00 GMT",
          author: "Jane &amp; John Doe",
        },
      ],
    };

    const articles = await agg.parseToRawArticles(sourceData);
    expect(articles).toHaveLength(1);
    expect(articles[0].name).toBe("Apple’s New M4 Chip");
    expect(articles[0].author).toBe("Jane & John Doe");
    expect(articles[0].identifier).toBe("https://example.com/m4");
    expect(articles[0].content).toBe("<p>Article summary</p>");
    expect(articles[0].date).toBeInstanceOf(Date);
  });

  /**
   * Parser, pass-through and filter together, on the shape that motivated
   * them: Mein-MMO ships its affiliate deal articles in its main feed with the
   * legally required label as a category. Trimmed from the live
   * `https://mein-mmo.de/feed/` on 2026-08-31 -- titles, links and categories
   * verbatim -- because each piece of this path was cheap to get right alone
   * and the whole was only ever wrong at the seams (the parser dropped
   * `<category>` entirely, so nothing downstream could have worked).
   */
  it("drops a labelled article from a real feed's shape, end to end", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>MeinMMO</title>
          <item>
            <title>Episches Gangster-Abenteuer: Mafia bekommt ihr fuer PS5 und Xbox guenstig</title>
            <link>https://mein-mmo.de/episches-gangster-abenteuer-disc-version-mafia-ps5-xbox-richtig-guenstig/</link>
            <description><![CDATA[<p>Deal</p>]]></description>
            <category><![CDATA[Anzeige]]></category>
            <category><![CDATA[Deals]]></category>
          </item>
          <item>
            <title>WoW: Naechster Privat-Server schliesst in wenigen Tagen</title>
            <link>https://mein-mmo.de/wow-privat-server-schliesst/</link>
            <description><![CDATA[<p>News</p>]]></description>
            <category><![CDATA[Community]]></category>
            <category><![CDATA[MMORPG]]></category>
          </item>
        </channel>
      </rss>`;

    const agg = new RssAggregator({ identifier: "https://mein-mmo.de/feed/", dailyLimit: 20 });
    vi.spyOn(agg, "fetchSourceData").mockResolvedValue(parseXmlFeed(xml));
    const logged: string[] = [];
    agg.onLog = (message) => logged.push(message);

    const articles = await agg.aggregate();

    expect(articles.map((article) => article.identifier)).toEqual([
      "https://mein-mmo.de/wow-privat-server-schliesst/",
    ]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('advertising ("Anzeige")');
  });

  describe("fetchArticleContent (reload)", () => {
    it("re-fetches the feed and returns the matching entry's summary, not a page fetch", async () => {
      const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
      const agg = new RssAggregator(feed);

      const sourceData: ParsedFeed = {
        title: "Example Feed",
        entries: [
          { title: "Other", link: "https://example.com/other", summary: "<p>Other</p>" },
          { title: "Target", link: "https://example.com/m4", summary: "<p>Updated summary</p>" },
        ],
      };
      const fetchSourceData = vi.spyOn(agg, "fetchSourceData").mockResolvedValue(sourceData);

      const content = await agg.fetchArticleContent("https://example.com/m4");

      expect(content).toBe("<p>Updated summary</p>");
      expect(fetchSourceData).toHaveBeenCalled();
    });

    it("returns empty when the entry is no longer in the feed", async () => {
      const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
      const agg = new RssAggregator(feed);
      vi.spyOn(agg, "fetchSourceData").mockResolvedValue({ title: "Example Feed", entries: [] });

      const content = await agg.fetchArticleContent("https://example.com/gone");

      expect(content).toBe("");
    });

    it("reports the entry's own title, unescaped exactly as parseToRawArticles does", async () => {
      // `reload.ts` reads this instead of `articles.name`, which on a feed with
      // an AI option on holds the model's previous answer rather than source
      // text -- see `noteSourceTitle()` in ./base.
      const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
      const agg = new RssAggregator(feed);
      vi.spyOn(agg, "fetchSourceData").mockResolvedValue({
        title: "Example Feed",
        entries: [
          {
            title: "Apple&#8217;s New M4 Chip",
            link: "https://example.com/m4",
            summary: "<p>Updated summary</p>",
          },
        ],
      });

      expect(agg.sourceTitle).toBeNull();
      await agg.fetchArticleContent("https://example.com/m4");

      expect(agg.sourceTitle).toBe("Apple’s New M4 Chip");
    });

    it("reports no source title when the entry is no longer in the feed", async () => {
      const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
      const agg = new RssAggregator(feed);
      vi.spyOn(agg, "fetchSourceData").mockResolvedValue({ title: "Example Feed", entries: [] });

      await agg.fetchArticleContent("https://example.com/gone");

      expect(agg.sourceTitle).toBeNull();
    });

    it("returns empty rather than throwing when the feed itself can no longer be fetched", async () => {
      const feed: FeedLike = { identifier: "https://example.com/rss", dailyLimit: 20 };
      const agg = new RssAggregator(feed);
      vi.spyOn(agg, "fetchSourceData").mockRejectedValue(new Error("network error"));

      const content = await agg.fetchArticleContent("https://example.com/m4");

      expect(content).toBe("");
    });
  });

  /**
   * `aggregate()` computes the paced `limit` from the real `collectedToday`
   * and hands it to `fetchSourceData()` -- but `parseToRawArticles()` used to
   * recompute its own slicing bound by calling `this.getCurrentRunLimit()`
   * with no arguments, silently falling back to `collectedToday = 0`. That
   * second, unpaced computation was the one that actually truncated the
   * entry list, so the real pacing `aggregate()` worked out was discarded.
   */
  it("paces the entry count from the limit aggregate() computed, not a fresh collectedToday=0", async () => {
    // maxArticleAgeDays: 0 disables the unrelated age filter, so this test
    // isolates the pacing bug rather than incidentally passing because the
    // fixed 2026-08-02 dates in `entries` below are older than the default
    // 30-day cutoff (measured against the real clock, not the `clock` this
    // test injects for pacing).
    const feed: FeedLike = {
      identifier: "https://example.com/rss",
      dailyLimit: 20,
      maxArticleAgeDays: 0,
    };
    const agg = new RssAggregator(feed);

    const entries = Array.from({ length: 30 }, (_, i) => ({
      title: `Entry ${i}`,
      link: `https://example.com/${i}`,
      summary: `<p>Content ${i}</p>`,
      published: "Sun, 02 Aug 2026 18:00:00 GMT",
    }));
    vi.spyOn(agg, "fetchSourceData").mockResolvedValue({ title: "Example Feed", entries });

    // dailyLimit 20, 18 already collected today, run at 18:00 -- aggregate()
    // computes limit = 1 (see base.ts's getCurrentRunLimit()). Before the fix,
    // parseToRawArticles() recomputed with collected = 0 and returned ~15.
    const clock = () => new Date("2026-08-02T18:00:00Z");
    const articles = await agg.aggregate(clock, 18);

    expect(articles.length).toBeLessThanOrEqual(2);
  });
});
