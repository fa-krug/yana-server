import { describe, it, expect } from "vitest";
import type { FeedLike, RawArticle } from "../../base";
import { MeinMmoAggregator } from "./aggregator";

const FEED: FeedLike = {
  identifier: "https://mein-mmo.de/feed/",
  dailyLimit: 20,
  options: { combine_pages: false, include_comments: false },
};

const ARTICLE: RawArticle = {
  name: "Test article",
  identifier: "https://mein-mmo.de/test-article/",
  raw_content: "",
  content: "",
  date: new Date(),
  author: "",
};

describe("MeinMmoAggregator.extractContent", () => {
  it("returns a Promise<string> that resolves to the extracted content", async () => {
    const agg = new MeinMmoAggregator(FEED);
    const html = '<html><body><div class="entry-content"><p>Article body.</p></div></body></html>';

    const result = agg.extractContent(html, ARTICLE);
    expect(result).toBeInstanceOf(Promise);

    const resolved = await result;
    expect(resolved).toContain("Article body.");
  });
});
