import { describe, expect, it, vi } from "vitest";

import type { FeedLike, RawArticle } from "../../base";
import { MactechnewsAggregator } from "./aggregator";

vi.mock("../../http/fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../http/fetcher")>()),
  fetchHtml: vi.fn(),
}));

const FEED: FeedLike = {
  identifier: "https://www.mactechnews.de/Rss/News.x",
  dailyLimit: 20,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pipeline-review-3, Task 9. `sites/mactechnews/aggregator.ts`'s
 * `fetchArticleContent()` replaces the fetched page with `fetchAllPages()`'s
 * combined result, which is only the joined `.MtnArticle` containers from
 * every page. That combined result is what `enrichOne()`
 * (`../../website.ts`) stores as `article.raw_content`, and comment
 * extraction used to scrape comments straight out of `raw_content` --
 * where `div.MtnCommentScroll`, a sibling of `.MtnArticle` rather than a
 * descendant, no longer exists on a multi-page article. So a two-page
 * MacTechNews article lost all of its comments, on both the aggregation
 * path (`FullWebsiteAggregator.enrichArticles()`) and the reload path
 * (`handleReloadJob()`) -- both call the exact same
 * `fetchArticleContent()` -> `extractContent()` -> `processContent()`
 * sequence on one aggregator instance, so a fix to `processContent()`
 * fixes both.
 */
describe("MactechnewsAggregator multi-page comments", () => {
  it("keeps page 1's comments when the article spans multiple pages", async () => {
    const page1 =
      '<html><body><div class="MtnArticle"><h1>A two-page article</h1>' +
      '<p>Page 1 body.</p><a href="?page=2">2</a></div>' +
      '<div class="MtnCommentScroll"><div class="MtnComment" id="comment-1">' +
      '<span class="MtnCommentAccountName">Alex</span>' +
      '<div class="MtnCommentText"><p>Great read!</p></div>' +
      "</div></div></body></html>";
    const page2 =
      '<html><body><div class="MtnArticle"><p>Page 2 body, no comments container here.</p>' +
      "</div></body></html>";

    const { fetchHtml } = await import("../../http/fetcher");
    vi.mocked(fetchHtml).mockImplementation(async (url: string) => {
      if (url.includes("page=2")) return page2;
      return page1;
    });

    const feed: FeedLike = {
      ...FEED,
      options: { combine_pages: true, include_comments: true, max_comments: 5 },
    };
    const agg = new MactechnewsAggregator(feed);
    const url = "https://www.mactechnews.de/news/a-two-page-article.html";

    // Mirrors `enrichOne()` in ../../website.ts: fetchArticleContent()'s
    // return is what gets stored as `article.raw_content`, and
    // extractContent() runs against that same combined html.
    const combined = await agg.fetchArticleContent(url);
    expect(combined).toContain("Page 1 body.");
    expect(combined).toContain("Page 2 body, no comments container here.");
    // The bug's other half: div.MtnCommentScroll is a sibling of
    // .MtnArticle, so it was never part of fetchAllPages()' combined
    // result in the first place -- confirming comments can only ever be
    // recovered from the stashed first page, not from `combined` itself.
    expect(combined).not.toContain("MtnCommentScroll");

    const article: RawArticle = {
      name: "A two-page article",
      identifier: url,
      raw_content: combined,
      content: "",
      date: new Date(),
      author: "",
    };

    const extracted = await agg.extractContent(combined, article);
    const processed = await agg.processContent(extracted, article);

    expect(processed).toContain("Page 1 body.");
    expect(processed).toContain("Page 2 body, no comments container here.");
    // The failing assertion before the fix: processContent() used to read
    // `article.raw_content` (== `combined`, which never had the comments
    // container) instead of the stashed, un-truncated first page.
    expect(processed).toContain("Great read!");
    expect(processed).toContain("Alex");
  });

  it("keeps working for a single-page article (no pagination, no stash needed)", async () => {
    const page1 =
      '<html><body><div class="MtnArticle"><h1>A single-page article</h1>' +
      "<p>The whole article.</p></div>" +
      '<div class="MtnCommentScroll"><div class="MtnComment" id="comment-1">' +
      '<span class="MtnCommentAccountName">Sam</span>' +
      '<div class="MtnCommentText"><p>Nice one.</p></div>' +
      "</div></div></body></html>";

    const { fetchHtml } = await import("../../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(page1);

    const feed: FeedLike = {
      ...FEED,
      options: { combine_pages: true, include_comments: true, max_comments: 5 },
    };
    const agg = new MactechnewsAggregator(feed);
    const url = "https://www.mactechnews.de/news/a-single-page-article.html";

    const html = await agg.fetchArticleContent(url);
    const article: RawArticle = {
      name: "A single-page article",
      identifier: url,
      raw_content: html,
      content: "",
      date: new Date(),
      author: "",
    };

    const extracted = await agg.extractContent(html, article);
    const processed = await agg.processContent(extracted, article);

    expect(processed).toContain("The whole article.");
    expect(processed).toContain("Nice one.");
  });
});

/**
 * The concurrency proof Mein-MMO already carries
 * (`../mein_mmo/aggregator.test.ts`), replayed here for MacTechNews now that
 * it uses the same shared `FirstPageStash`: a per-URL stash, not a single
 * instance field, is what keeps two concurrently-enriched articles from
 * reading each other's first page for their comments.
 */
describe("MactechnewsAggregator.enrichArticles", () => {
  it("attaches each article's own comments, not a sibling's, when enrichment runs concurrently", async () => {
    const fetchDelays: Record<string, number> = {
      "https://www.mactechnews.de/news/fast.html": 5,
      "https://www.mactechnews.de/news/slow.html": 20,
    };
    const markers: Record<string, string> = {
      "https://www.mactechnews.de/news/fast.html": "FAST-MARKER",
      "https://www.mactechnews.de/news/slow.html": "SLOW-MARKER",
    };

    const pageHtmlWithComment = (marker: string): string =>
      `<html><body><div class="MtnArticle"><p>Body for ${marker}.</p></div>` +
      `<div class="MtnCommentScroll"><div class="MtnComment" id="c-${marker}">` +
      `<span class="MtnCommentAccountName">Someone</span>` +
      `<div class="MtnCommentText"><p>Comment for ${marker}.</p></div>` +
      `</div></div></body></html>`;

    const { fetchHtml } = await import("../../http/fetcher");
    vi.mocked(fetchHtml).mockImplementation(async (url: string) => {
      await delay(fetchDelays[url] ?? 0);
      return pageHtmlWithComment(markers[url] ?? url);
    });

    // Bypasses header extraction entirely -- it runs its own strategies
    // (including a page fetch) against `article.identifier` and would
    // otherwise consume the same mocked `fetchHtml()` unpredictably. Mirrors
    // `TestMeinMmoAggregator` in `../mein_mmo/aggregator.test.ts`, the same
    // concurrency proof for the map this shared stash replaces there.
    class TestMactechnewsAggregator extends MactechnewsAggregator {
      async extractHeaderElement(): Promise<null> {
        return null;
      }
    }

    const feed: FeedLike = {
      ...FEED,
      options: { combine_pages: false, include_comments: true, max_comments: 5 },
    };
    const agg = new TestMactechnewsAggregator(feed);

    const articles: RawArticle[] = [
      {
        name: "Fast article",
        identifier: "https://www.mactechnews.de/news/fast.html",
        raw_content: "",
        content: "",
        date: new Date(),
        author: "",
      },
      {
        name: "Slow article",
        identifier: "https://www.mactechnews.de/news/slow.html",
        raw_content: "",
        content: "",
        date: new Date(),
        author: "",
      },
    ];

    const result = await agg.enrichArticles(articles);

    expect(result).toHaveLength(2);
    const fastResult = result.find(
      (a) => a.identifier === "https://www.mactechnews.de/news/fast.html",
    )!;
    const slowResult = result.find(
      (a) => a.identifier === "https://www.mactechnews.de/news/slow.html",
    )!;

    expect(fastResult.content).toContain("Comment for FAST-MARKER");
    expect(fastResult.content).not.toContain("SLOW-MARKER");

    expect(slowResult.content).toContain("Comment for SLOW-MARKER");
    expect(slowResult.content).not.toContain("FAST-MARKER");
  });
});
