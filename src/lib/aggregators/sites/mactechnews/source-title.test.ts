import { describe, expect, it, vi } from "vitest";

import type { FeedLike } from "../../base";
import { MactechnewsAggregator } from "./aggregator";

vi.mock("../../http/fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../http/fetcher")>()),
  fetchHtml: vi.fn(),
}));

const FEED: FeedLike = {
  identifier: "https://www.mactechnews.de/Rss/News.x",
  dailyLimit: 20,
};

/**
 * Pipeline-review-3, Task 8: same structural gap as Heise/Merkur/Tagesschau/
 * Mein-MMO -- `FullWebsiteAggregator.fetchArticleContent()` dropped
 * `noteSourceTitle()` for the whole family. MacTechNews also paginates a
 * single article across several page fetches within one
 * `fetchArticleContent()` call, so `noteSourceTitle()`'s "sticky" rule (see
 * ../../base) matters here too.
 */
describe("MactechnewsAggregator sourceTitle", () => {
  it("reports the heading found inside .MtnArticle", async () => {
    const { fetchHtml } = await import("../../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(
      '<html><body><div class="MtnArticle"><h1>A real MacTechNews headline</h1>' +
        "<p>Body.</p></div></body></html>",
    );

    const agg = new MactechnewsAggregator({ ...FEED, options: { combine_pages: false } });
    expect(agg.sourceTitle).toBeNull();
    await agg.fetchArticleContent("https://www.mactechnews.de/news/article-1.html");

    expect(agg.sourceTitle).toBe("A real MacTechNews headline");
  });

  it("keeps page 1's headline even when a later paginated page has none", async () => {
    const page1 =
      '<html><body><div class="MtnArticle"><h1>Page 1 has the real headline</h1>' +
      '<p>Page 1 body.</p><a href="?page=2">2</a></div></body></html>';
    const page2 =
      '<html><body><div class="MtnArticle"><p>Page 2 body, no heading repeated.</p></div></body></html>';

    const { fetchHtml } = await import("../../http/fetcher");
    vi.mocked(fetchHtml).mockImplementation(async (url: string) => {
      if (url.includes("page=2")) return page2;
      return page1;
    });

    const agg = new MactechnewsAggregator({ ...FEED, options: { combine_pages: true } });
    await agg.fetchArticleContent("https://www.mactechnews.de/news/article-1.html");

    expect(agg.sourceTitle).toBe("Page 1 has the real headline");
  });
});
