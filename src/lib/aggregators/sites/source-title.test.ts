import { describe, expect, it, vi } from "vitest";

import type { FeedLike } from "../base";
import { ArsTechnicaAggregator } from "./ars_technica";
import { CaschysBlogAggregator } from "./caschys_blog";
import { DarkLegacyAggregator } from "./dark_legacy";
import { TheVergeAggregator } from "./the_verge";

vi.mock("../http/fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../http/fetcher")>()),
  fetchHtml: vi.fn(),
}));

vi.mock("../images/store", () => ({
  storeImageRefFromUrl: vi.fn(async () => "yana-img://abc123hash"),
}));

/**
 * Pipeline-review-3, Task 8: `FullWebsiteAggregator.fetchArticleContent()`
 * used to override `RssAggregator`'s without calling it, so *none* of the
 * eleven `FullWebsiteAggregator` sites ever noted a source title -- silently
 * dropping the one thing `reload.ts` needs to avoid feeding a previous AI
 * run's title back into the model. `sourceTitleFrom()` is the fix; this
 * covers the sites that get *no* selector, on purpose:
 *
 * - `RssSummaryFallbackAggregator` sites (ars_technica, the_verge) -- no
 *   selector is supplied for them, so they report `null`, exactly as before.
 * - Comics (oglaf/explosm/dark_legacy, represented here by DarkLegacy) have
 *   no headline distinct from the feed's and deliberately leave the hook at
 *   its default.
 *
 * See heise.test.ts, merkur.test.ts and mein_mmo/mactechnews's own aggregator
 * tests for the six sites that *do* get a selector.
 */
describe("FullWebsiteAggregator subclasses with no sourceTitleFrom selector", () => {
  it("CaschysBlogAggregator reports its h1.entry-title selector (sanity: the six selector sites are covered elsewhere)", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(
      `<html><body><h1 class="entry-title">A Caschy's Blog headline</h1></body></html>`,
    );
    const feed: FeedLike = { identifier: "https://stadt-bremerhaven.de/feed/", dailyLimit: 20 };
    const agg = new CaschysBlogAggregator(feed);

    await agg.fetchArticleContent("https://stadt-bremerhaven.de/some-post/");

    expect(agg.sourceTitle).toBe("A Caschy's Blog headline");
  });

  it("ArsTechnicaAggregator (RssSummaryFallbackAggregator) reports no source title", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(
      `<html><body><h1>Ars Technica's own page headline</h1></body></html>`,
    );
    const feed: FeedLike = { identifier: "https://arstechnica.com/feed/", dailyLimit: 20 };
    const agg = new ArsTechnicaAggregator(feed);

    await agg.fetchArticleContent("https://arstechnica.com/gadgets/some-post/");

    expect(agg.sourceTitle).toBeNull();
  });

  it("TheVergeAggregator (RssSummaryFallbackAggregator) reports no source title", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(
      `<html><body><h1>The Verge's own page headline</h1></body></html>`,
    );
    const feed: FeedLike = { identifier: "https://www.theverge.com/rss/index.xml", dailyLimit: 20 };
    const agg = new TheVergeAggregator(feed);

    await agg.fetchArticleContent("https://www.theverge.com/some-post");

    expect(agg.sourceTitle).toBeNull();
  });

  it("a comic aggregator (DarkLegacyAggregator) reports no source title", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(
      `<html><body><img id="gallery" src="x.png"></body></html>`,
    );
    const feed: FeedLike = { identifier: "https://darklegacycomics.com/feed.xml", dailyLimit: 20 };
    const agg = new DarkLegacyAggregator(feed);

    await agg.fetchArticleContent("https://darklegacycomics.com/500");

    expect(agg.sourceTitle).toBeNull();
  });
});
