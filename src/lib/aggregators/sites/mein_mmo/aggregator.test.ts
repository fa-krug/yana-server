import { describe, it, expect, vi } from "vitest";
import type { FeedLike, RawArticle } from "../../base";
import { MeinMmoAggregator } from "./aggregator";

vi.mock("../../http/fetcher", () => ({
  fetchHtml: vi.fn(),
}));

vi.mock("../../images/store", () => ({
  storeImageRefFromUrl: vi.fn(),
}));

import { fetchHtml } from "../../http/fetcher";
import { storeImageRefFromUrl } from "../../images/store";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pageHtmlWithComment(marker: string): string {
  return `<html><body>
    <div class="entry-content">
      <p>Body for ${marker}.</p>
      <img src="https://mein-mmo.de/${marker}.jpg">
    </div>
    <div class="wpd-thread-list">
      <div class="wpd-comment"><div class="wpd-comment-text">Comment for ${marker}.</div></div>
    </div>
  </body></html>`;
}

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

const CMS_VIDEO_HTML =
  '<html><body><div class="entry-content"><p>Article body.</p>' +
  '<div class="wp-block-mmo-video" data-id="857744"><figure>' +
  '<div class="thumbnail" style="background-image: url(https://images.mein-mmo.de/w.jpg);">' +
  "</div>" +
  '<figcaption class="title">Some trailer</figcaption>' +
  "<script>window.Mmo.functions.renderDmPlayer( { dmVideoId: 'x8co8a0' } );</script>" +
  "</figure></div></div></body></html>";

describe("MeinMmoAggregator.extractContent", () => {
  it("returns a Promise<string> that resolves to the extracted content", async () => {
    const agg = new MeinMmoAggregator(FEED);
    const html = '<html><body><div class="entry-content"><p>Article body.</p></div></body></html>';

    const result = agg.extractContent(html, ARTICLE);
    expect(result).toBeInstanceOf(Promise);

    const resolved = await result;
    expect(resolved).toContain("Article body.");
  });

  // The option reads `=== true`, so an absent value -- every feed created
  // before it existed, FEED above included -- means off. A `!== false` typo
  // here would silently keep the CMS's videos in every one of them, which is
  // the behaviour this option exists to end.
  it("drops the CMS's auto-inserted video when the feed sets no include_videos", async () => {
    const resolved = await new MeinMmoAggregator(FEED).extractContent(CMS_VIDEO_HTML, ARTICLE);

    expect(resolved).toContain("Article body.");
    expect(resolved).not.toContain("dailymotion");
    expect(resolved).not.toContain("Some trailer");
  });

  it("keeps it when the feed opts in", async () => {
    const feed: FeedLike = { ...FEED, options: { ...FEED.options, include_videos: true } };

    const resolved = await new MeinMmoAggregator(feed).extractContent(CMS_VIDEO_HTML, ARTICLE);

    expect(resolved).toContain("https://www.dailymotion.com/video/x8co8a0");
    expect(resolved).toContain("Some trailer");
  });
});

describe("MeinMmoAggregator.enrichArticles", () => {
  it("attaches each article's own comments, not a sibling's, when enrichment runs concurrently", async () => {
    // Regression test for the race the final whole-branch review found:
    // MeinMmoAggregator used to stash the fetched page HTML in a single
    // instance field (`firstPageHtml`), read later by processContent() for
    // comment extraction. That was safe only because the old enrichArticles()
    // ran one article to completion before starting the next. This branch
    // parallelizes enrichArticles() up to the feed's concurrency, so a
    // second article's fetchArticleContent() can overwrite that field while
    // the first article's processContent() is still awaiting its img-resolution
    // loop -- and the first article then reads the second article's page for
    // its own comments.
    //
    // Timing is engineered so this reproduces deterministically rather than
    // by luck:
    //  - "fast"'s page fetch resolves at ~5ms, "slow"'s at ~20ms.
    //  - Both articles' pages contain one <img>, so processContent() always
    //    hits its awaited image-resolution loop; that resolution is mocked to
    //    take ~30ms.
    //  - "fast" finishes its fetch first and enters that 30ms image wait at
    //    ~t=5ms, so it is still inside the wait when "slow" finishes its own
    //    fetch at ~t=20ms and overwrites the old single shared field.
    //  - "fast"'s image wait ends at ~t=35ms, after that overwrite -- so under
    //    the old single-field implementation, "fast" reads "slow"'s page HTML
    //    and gets "slow"'s comments instead of its own.
    const fetchDelays: Record<string, number> = {
      "https://mein-mmo.de/fast/": 5,
      "https://mein-mmo.de/slow/": 20,
    };
    const markers: Record<string, string> = {
      "https://mein-mmo.de/fast/": "FAST-MARKER",
      "https://mein-mmo.de/slow/": "SLOW-MARKER",
    };

    vi.mocked(fetchHtml).mockImplementation(async (url: string) => {
      await delay(fetchDelays[url] ?? 0);
      return pageHtmlWithComment(markers[url] ?? url);
    });

    vi.mocked(storeImageRefFromUrl).mockImplementation(async () => {
      await delay(30);
      return "yana-img://fake-hash";
    });

    class TestMeinMmoAggregator extends MeinMmoAggregator {
      async extractHeaderElement(): Promise<null> {
        return null;
      }
    }

    const feed: FeedLike = {
      identifier: "https://mein-mmo.de/feed/",
      dailyLimit: 20,
      options: { combine_pages: false, include_comments: true, max_comments: 5 },
    };
    const agg = new TestMeinMmoAggregator(feed);

    const articles: RawArticle[] = [
      {
        name: "Fast article",
        identifier: "https://mein-mmo.de/fast/",
        raw_content: "",
        content: "",
        date: new Date(),
        author: "",
      },
      {
        name: "Slow article",
        identifier: "https://mein-mmo.de/slow/",
        raw_content: "",
        content: "",
        date: new Date(),
        author: "",
      },
    ];

    const result = await agg.enrichArticles(articles);

    expect(result).toHaveLength(2);
    const fastResult = result.find((a) => a.identifier === "https://mein-mmo.de/fast/")!;
    const slowResult = result.find((a) => a.identifier === "https://mein-mmo.de/slow/")!;

    expect(fastResult.content).toContain("Comment for FAST-MARKER");
    expect(fastResult.content).not.toContain("SLOW-MARKER");

    expect(slowResult.content).toContain("Comment for SLOW-MARKER");
    expect(slowResult.content).not.toContain("FAST-MARKER");
  });
});
