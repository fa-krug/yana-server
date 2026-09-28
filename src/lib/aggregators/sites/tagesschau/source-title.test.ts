import { describe, expect, it, vi } from "vitest";

import type { FeedLike } from "../../base";
import { TagesschauAggregator } from "./aggregator";

vi.mock("../../http/fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../http/fetcher")>()),
  fetchHtml: vi.fn(),
}));

function aggregatorFor(): TagesschauAggregator {
  const feed: FeedLike = {
    identifier: "https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml",
    dailyLimit: 20,
  };
  return new TagesschauAggregator(feed);
}

/**
 * Pipeline-review-3, Task 8: same structural gap as Heise/Merkur --
 * `FullWebsiteAggregator.fetchArticleContent()` dropped `noteSourceTitle()`
 * for the whole family.
 */
describe("TagesschauAggregator sourceTitle", () => {
  it("reports the headline read off the fetched page", async () => {
    const { fetchHtml } = await import("../../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(
      `<html><body><span class="seitenkopf__headline--text">Eine echte Tagesschau-Überschrift</span></body></html>`,
    );

    const agg = aggregatorFor();
    expect(agg.sourceTitle).toBeNull();
    await agg.fetchArticleContent("https://www.tagesschau.de/inland/test-100.html");

    expect(agg.sourceTitle).toBe("Eine echte Tagesschau-Überschrift");
  });

  it("reports the headline of a regional story redirected to BR24", async () => {
    const { fetchHtml } = await import("../../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(
      `<html><body><section class="ArticleModuleTeaser-module-scss-module__Y44zPW__wrapper">` +
        `<h2 class="heading1 ArticleModuleTeaser-module-scss-module__Y44zPW__title">BR24-Überschrift </h2>` +
        `</section><section class="ArticleBody-module-scss-module__oQZvRW__section">` +
        `<div class="RichText-module-scss-module__ZDJi6a__richText"><p>Text.</p></div>` +
        `</section></body></html>`,
    );

    const agg = aggregatorFor();
    await agg.fetchArticleContent("https://www.tagesschau.de/inland/oktoberfest-unfall-104.html");

    expect(agg.sourceTitle).toBe("BR24-Überschrift");
  });

  it("reports no source title when the page carries no matching headline", async () => {
    const { fetchHtml } = await import("../../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(`<html><body><p>No headline here.</p></body></html>`);

    const agg = aggregatorFor();
    await agg.fetchArticleContent("https://www.tagesschau.de/inland/test-100.html");

    expect(agg.sourceTitle).toBeNull();
  });
});
