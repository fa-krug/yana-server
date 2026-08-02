import { describe, expect, it } from "vitest";

import { FeedLike } from "./base";
import { RssAggregator } from "./rss";
import { ParsedFeed } from "./rss-parser";

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
});
