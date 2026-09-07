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
 * file covers the sites that don't get a CSS-selector tier:
 *
 * - `CaschysBlogAggregator` is a sanity check that a selector site still
 *   works from this file (the six selector sites are covered in full in
 *   heise.test.ts, merkur.test.ts and mein_mmo/mactechnews's own tests).
 * - Comics (oglaf/explosm/dark_legacy, represented here by DarkLegacy) have
 *   no headline distinct from the feed's and deliberately leave the hook at
 *   its default (`null`).
 * - `ArsTechnicaAggregator`/`TheVergeAggregator` (both
 *   `RssSummaryFallbackAggregator`) were first left reporting `null` too,
 *   matching the task-8 brief's literal "not dropping `rss.ts:59`" fix --
 *   which turned out not to resolve against the code: that call lives in
 *   `RssAggregator.fetchArticleContent()`, which does a full *feed* refetch,
 *   and neither class overrides `FullWebsiteAggregator`'s page-only fetch, so
 *   reaching it would cost a second network round-trip per article on every
 *   ordinary aggregation run. Fixed instead with an `og:title` tier through
 *   the same `sourceTitleFrom()` hook -- free, since it reads the page
 *   already in hand -- following the same Open Graph convention
 *   `MeinMmoAggregator.sourceTitleFrom()` already uses as its own fallback.
 */
describe("FullWebsiteAggregator subclasses' sourceTitleFrom without a headline selector", () => {
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

  it("ArsTechnicaAggregator reports the headline from og:title", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(
      `<html><head><meta property="og:title" content="Ars Technica's real headline">` +
        `<meta property="og:site_name" content="Ars Technica"></head><body></body></html>`,
    );
    const feed: FeedLike = { identifier: "https://arstechnica.com/feed/", dailyLimit: 20 };
    const agg = new ArsTechnicaAggregator(feed);

    expect(agg.sourceTitle).toBeNull();
    await agg.fetchArticleContent("https://arstechnica.com/gadgets/some-post/");

    expect(agg.sourceTitle).toBe("Ars Technica's real headline");
  });

  it("ArsTechnicaAggregator reports no source title when og:title is absent", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(
      `<html><body><h1>Not an Open Graph tag, so this must not be read</h1></body></html>`,
    );
    const feed: FeedLike = { identifier: "https://arstechnica.com/feed/", dailyLimit: 20 };
    const agg = new ArsTechnicaAggregator(feed);

    await agg.fetchArticleContent("https://arstechnica.com/gadgets/some-post/");

    expect(agg.sourceTitle).toBeNull();
  });

  it("TheVergeAggregator reports the headline from og:title", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(
      `<html><head><meta property="og:title" content="The Verge's real headline">` +
        `<meta property="og:site_name" content="The Verge"></head><body></body></html>`,
    );
    const feed: FeedLike = { identifier: "https://www.theverge.com/rss/index.xml", dailyLimit: 20 };
    const agg = new TheVergeAggregator(feed);

    expect(agg.sourceTitle).toBeNull();
    await agg.fetchArticleContent("https://www.theverge.com/some-post");

    expect(agg.sourceTitle).toBe("The Verge's real headline");
  });

  it("TheVergeAggregator reports no source title when og:title is absent", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(
      `<html><body><h1>Not an Open Graph tag, so this must not be read</h1></body></html>`,
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
