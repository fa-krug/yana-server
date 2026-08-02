import { describe, expect, it } from "vitest";

import { FeedLike, RawArticle } from "./base";
import { FullWebsiteAggregator, RssSummaryFallbackAggregator } from "./website";

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

  it("replaces youtube iframe with facade in processContent", () => {
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

    const processed = agg.processContent(html, article);
    expect(processed).toContain("youtube-embed-container");
    expect(processed).toContain("dQw4w9WgXcQ");
    expect(processed).not.toContain("<iframe");
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
