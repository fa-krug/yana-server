import { describe, expect, it, vi } from "vitest";

import { FeedLike, RawArticle } from "./base";
import { ArticleSkipError } from "./errors";
import { FullWebsiteAggregator, RssSummaryFallbackAggregator } from "./website";

vi.mock("./images/store", () => ({
  storeImageRefFromUrl: vi.fn(async () => "yana-img://abc123hash"),
}));

function makeArticle(identifier: string): RawArticle {
  return {
    name: identifier,
    identifier,
    raw_content: "",
    content: "",
    date: new Date(),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("FullWebsiteAggregator", () => {
  it("resolves default content and ignore selectors", () => {
    const feed: FeedLike = { identifier: "https://example.com", dailyLimit: 20 };
    const agg = new FullWebsiteAggregator(feed);

    expect(agg.getContentSelectors()).toContain("article");
    expect(agg.getIgnoreSelectors()).toContain(".iframe-sanitize");
    expect(agg.getIgnoreSelectors()).toContain(".advertisement");
  });

  it("uses custom content and ignore selectors from feed options", () => {
    const feed: FeedLike = {
      identifier: "https://example.com",
      dailyLimit: 20,
      options: {
        content_selectors: ".custom-body, .my-content",
        ignore_selectors: ".promo",
      },
    };
    const agg = new FullWebsiteAggregator(feed);

    expect(agg.getContentSelectors()).toEqual([".custom-body", ".my-content"]);
    expect(agg.getIgnoreSelectors()).toEqual([".iframe-sanitize", ".promo"]);
  });

  it("extracts main content container from HTML", () => {
    const feed: FeedLike = { identifier: "https://example.com", dailyLimit: 20 };
    const agg = new FullWebsiteAggregator(feed);

    const html = `<html>
      <body>
        <div class="nav">Navigation</div>
        <article>
          <p>Main Article Content</p>
        </article>
      </body>
    </html>`;

    const article: RawArticle = {
      name: "Test",
      identifier: "https://example.com/1",
      raw_content: "",
      content: "",
      date: new Date(),
    };

    const extracted = agg.extractContent(html, article);
    expect(extracted).toContain("Main Article Content");
    expect(extracted).not.toContain("Navigation");
  });

  it("replaces youtube iframe with facade in processContent", async () => {
    const feed: FeedLike = { identifier: "https://example.com", dailyLimit: 20 };
    const agg = new FullWebsiteAggregator(feed);

    const html = `<article><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe></article>`;
    const article: RawArticle = {
      name: "Video Post",
      identifier: "https://example.com/video",
      raw_content: "",
      content: "",
      date: new Date(),
    };

    const processed = await agg.processContent(html, article);
    expect(processed).toContain("youtube-embed-container");
    expect(processed).toContain("dQw4w9WgXcQ");
    expect(processed).not.toContain("<iframe");
    expect(processed).toContain("Watch on YouTube");
    // The facade must carry a localized thumbnail, not just a bare play
    // button on black -- see localizeThumbnail() in ./embeds/youtube.ts.
    expect(processed).toContain('<img src="yana-img://abc123hash"');
  });
});

describe("RssSummaryFallbackAggregator", () => {
  it("falls back to RSS summary if no content container matches", () => {
    const feed: FeedLike = { identifier: "https://example.com", dailyLimit: 20 };
    const agg = new RssSummaryFallbackAggregator(feed);

    const html = `<html><body><div class="unmatched">Some text without article tag</div></body></html>`;
    const article: RawArticle = {
      name: "Fallback Test",
      identifier: "https://example.com/fallback",
      raw_content: "",
      content: "RSS Summary Content",
      date: new Date(),
    };

    const extracted = agg.extractContent(html, article);
    expect(extracted).toBe("RSS Summary Content");
  });
});

describe("FullWebsiteAggregator.enrichArticles", () => {
  const feed: FeedLike = { identifier: "https://example.com", dailyLimit: 20 };

  it("skips articles that raise ArticleSkipError and keeps others on other errors", async () => {
    class MixedOutcomeAggregator extends FullWebsiteAggregator {
      async extractHeaderElement(): Promise<null> {
        return null;
      }

      async fetchArticleContent(url: string): Promise<string> {
        if (url.includes("skip")) throw new ArticleSkipError("gone", 404);
        if (url.includes("fail")) throw new Error("network boom");
        return `<article>content for ${url}</article>`;
      }

      extractContent(html: string): string {
        return html;
      }

      async processContent(html: string): Promise<string> {
        return html;
      }
    }

    const agg = new MixedOutcomeAggregator(feed);
    const articles = [
      makeArticle("https://example.com/ok"),
      makeArticle("https://example.com/skip"),
      makeArticle("https://example.com/fail"),
    ];

    const result = await agg.enrichArticles(articles);

    expect(result.map((a) => a.identifier)).toEqual([
      "https://example.com/ok",
      "https://example.com/fail",
    ]);
    expect(result[0].content).toContain("content for https://example.com/ok");
    // The article that failed keeps its original (unenriched) content.
    expect(result[1].content).toBe("");
  });

  it("preserves input order even when articles finish out of completion order", async () => {
    class OutOfOrderAggregator extends FullWebsiteAggregator {
      async extractHeaderElement(): Promise<null> {
        return null;
      }

      async fetchArticleContent(url: string): Promise<string> {
        // The first article is the slowest, the last is the fastest, so
        // completion order is reversed relative to input order.
        const delays: Record<string, number> = {
          "https://example.com/1": 30,
          "https://example.com/2": 15,
          "https://example.com/3": 0,
        };
        await delay(delays[url] ?? 0);
        return `<article>content for ${url}</article>`;
      }

      extractContent(html: string): string {
        return html;
      }

      async processContent(html: string): Promise<string> {
        return html;
      }
    }

    const agg = new OutOfOrderAggregator(feed);
    const articles = [
      makeArticle("https://example.com/1"),
      makeArticle("https://example.com/2"),
      makeArticle("https://example.com/3"),
    ];

    const result = await agg.enrichArticles(articles);

    expect(result.map((a) => a.identifier)).toEqual([
      "https://example.com/1",
      "https://example.com/2",
      "https://example.com/3",
    ]);
    // Each article's content reflects its own URL, not a swapped neighbor's.
    expect(result[0].content).toContain("content for https://example.com/1");
    expect(result[1].content).toContain("content for https://example.com/2");
    expect(result[2].content).toContain("content for https://example.com/3");
  });

  it("never runs more than the feed's concurrency fetches concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    class CappedConcurrencyAggregator extends FullWebsiteAggregator {
      async extractHeaderElement(): Promise<null> {
        return null;
      }

      async fetchArticleContent(url: string): Promise<string> {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(10);
        inFlight--;
        return `<article>content for ${url}</article>`;
      }

      extractContent(html: string): string {
        return html;
      }

      async processContent(html: string): Promise<string> {
        return html;
      }
    }

    const agg = new CappedConcurrencyAggregator(feed);
    // More articles than the concurrency cap, so the cap is actually exercised.
    const articleCount = agg.concurrency * 2 + 1;
    const articles = Array.from({ length: articleCount }, (_, i) =>
      makeArticle(`https://example.com/${i}`),
    );

    const result = await agg.enrichArticles(articles);

    expect(result).toHaveLength(articleCount);
    expect(maxInFlight).toBeLessThanOrEqual(agg.concurrency);
    // Confirms the pool actually parallelizes rather than degenerating to
    // sequential execution.
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

describe("FullWebsiteAggregator.enrichArticles empty-body skip", () => {
  const feed: FeedLike = { identifier: "https://example.com", dailyLimit: 20 };

  class ExtractingAggregator extends FullWebsiteAggregator {
    constructor(
      feedLike: FeedLike,
      private readonly extracted: Record<string, string>,
    ) {
      super(feedLike);
    }

    async extractHeaderElement(): Promise<null> {
      return null;
    }

    async fetchArticleContent(url: string): Promise<string> {
      return `<html><body>page for ${url}</body></html>`;
    }

    extractContent(_html: string, article: RawArticle): string {
      return this.extracted[article.identifier] ?? "";
    }

    async processContent(html: string): Promise<string> {
      // Stand in for the real chrome-adding processContent: a header is
      // prepended whether or not there is a body, which is exactly how an
      // empty extraction used to reach the database as an image-only article.
      return `<figure><img src="https://example.com/header.jpg"></figure>${html}`;
    }
  }

  it("drops an article whose extracted content has neither text nor media", async () => {
    const agg = new ExtractingAggregator(feed, {
      "https://example.com/empty": "<div>  </div>\n<p></p>",
      "https://example.com/real": "<p>A real body.</p>",
    });

    const result = await agg.enrichArticles([
      makeArticle("https://example.com/empty"),
      makeArticle("https://example.com/real"),
    ]);

    expect(result.map((a) => a.identifier)).toEqual(["https://example.com/real"]);
  });

  it("reports the drop through onLog rather than dropping it silently", async () => {
    const logged: string[] = [];
    const agg = new ExtractingAggregator(feed, { "https://example.com/empty": "" });
    agg.onLog = (message) => logged.push(message);

    await agg.enrichArticles([makeArticle("https://example.com/empty")]);

    expect(logged.some((line) => line.includes("https://example.com/empty"))).toBe(true);
    expect(logged.join("\n")).toMatch(/no body/i);
  });

  it("keeps an image-only body, which is what a comic feed legitimately extracts", async () => {
    const agg = new ExtractingAggregator(feed, {
      "https://example.com/comic": '<div><img src="https://example.com/strip.png"></div>',
    });

    const result = await agg.enrichArticles([makeArticle("https://example.com/comic")]);

    expect(result.map((a) => a.identifier)).toEqual(["https://example.com/comic"]);
  });

  it("keeps a media-only body carried by an iframe embed", async () => {
    const agg = new ExtractingAggregator(feed, {
      "https://example.com/video":
        '<div><iframe src="https://www.youtube.com/embed/x"></iframe></div>',
    });

    const result = await agg.enrichArticles([makeArticle("https://example.com/video")]);

    expect(result.map((a) => a.identifier)).toEqual(["https://example.com/video"]);
  });
});
