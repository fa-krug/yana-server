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

/**
 * The "Inhalt" widget the Fixed TOC (`ftwp`) WordPress plugin injects into a
 * Mein-MMO article body, trimmed to two entries but with nothing renamed.
 * Captured from https://mein-mmo.de/pokemon-schlimme-schicksale-liste/ on
 * 2026-08-23.
 *
 * Two shapes matter and both are reproduced here: the widget is emitted
 * *inside* a `<p class="wp-block-paragraph">` (an HTML parser hoists the div
 * out and leaves that paragraph empty, which is why the empty-element pass has
 * to clean up after the removal), and the plugin's other wrapper,
 * `div#ftwp-postcontent`, holds the entire article body -- so a selector
 * broader than the container's own id would delete the article.
 */
const TOC_ARTICLE_HTML =
  '<html><body><div class="entry-content"><div id="ftwp-postcontent">' +
  '<p class="wp-block-paragraph">Leider kommt es im Anime zu F&auml;llen.</p>' +
  '<p class="wp-block-paragraph">' +
  '<div id="ftwp-container-outer" class="ftwp-in-post ftwp-float-none">' +
  '<div id="ftwp-container" class="ftwp-wrap ftwp-hidden-state ftwp-minimize">' +
  '<button type="button" id="ftwp-trigger" title="click To Maximize The Table Of Contents">' +
  '<span class="ftwp-trigger-icon ftwp-icon-number"></span></button>' +
  '<nav id="ftwp-contents" data-colexp="collapse">' +
  '<header id="ftwp-header" class="ftwp-header-clickable">' +
  '<h3 id="ftwp-header-title">Inhalt</h3></header>' +
  '<ol id="ftwp-list" class="ftwp-liststyle-decimal ftwp-list-nest">' +
  '<li class="ftwp-item ftwp-has-sub ftwp-expand">' +
  '<a class="ftwp-anchor" href="#ftoc-heading-1">' +
  '<span class="ftwp-text">8 Pok&eacute;mon mit schlimmen Schicksalen</span></a>' +
  '<ol class="ftwp-sub"><li class="ftwp-item">' +
  '<a class="ftwp-anchor" href="#ftoc-heading-2">' +
  '<span class="ftwp-text">Zwei wilde Magmars einfach zermalmt</span></a>' +
  "</li></ol></li>" +
  '<li class="ftwp-item"><a class="ftwp-anchor ftwp-otherpage-anchor" ' +
  'href="https://mein-mmo.de/pokemon-schlimme-schicksale-liste/2/#ftoc-heading-4">' +
  '<span class="ftwp-text">Das Pok&eacute;mon Knogga will sein Kind sch&uuml;tzen</span></a></li>' +
  "</ol></nav></div></div></p>" +
  '<h2 id="ftoc-heading-2" class="wp-block-heading">Zwei wilde Magmars einfach zermalmt</h2>' +
  '<p class="wp-block-paragraph">Der Rest des Artikels.</p>' +
  "</div></div></body></html>";

// The table of contents is navigation for Mein-MMO's own page, not article
// text -- and on a multi-page article most of its entries point at /2/, /3/
// and so on, which do not exist in the aggregated article at all.
describe("MeinMmoAggregator.extractContent - the ftwp table of contents", () => {
  it("drops the whole widget while keeping the article body around it", async () => {
    const resolved = await new MeinMmoAggregator(FEED).extractContent(TOC_ARTICLE_HTML, ARTICLE);

    expect(resolved).not.toContain("ftwp-container-outer");
    expect(resolved).not.toContain("Inhalt");
    expect(resolved).not.toContain("ftoc-heading-1");
    expect(resolved).not.toContain("pokemon-schlimme-schicksale-liste/2/");

    // The article itself -- including the headings the removed entries linked
    // to -- survives. `div#ftwp-postcontent` wraps all of it, so this is what
    // fails if the selector is ever widened to match the plugin's id prefix.
    expect(resolved).toContain("Leider kommt es im Anime");
    expect(resolved).toContain("Zwei wilde Magmars einfach zermalmt");
    expect(resolved).toContain("Der Rest des Artikels.");
  });
});

/**
 * Pipeline-review-3, Task 8: same structural gap as Heise/Merkur/Tagesschau
 * -- `FullWebsiteAggregator.fetchArticleContent()` dropped `noteSourceTitle()`
 * for the whole family. Mein-MMO paginates a single article across several
 * page fetches within one `fetchArticleContent()` call, which is exactly why
 * `noteSourceTitle()`'s "sticky" rule (see base.ts) matters here: a template
 * that only repeats the `<h1>` on page 1 must not have page 2's miss blank
 * out what page 1 already found.
 */
describe("MeinMmoAggregator sourceTitle", () => {
  it("reports the h1.entry-title headline", async () => {
    vi.mocked(fetchHtml).mockResolvedValueOnce(
      '<html><body><h1 class="entry-title">A real Mein-MMO headline</h1>' +
        '<div class="entry-content"><p>Body.</p></div></body></html>',
    );

    const agg = new MeinMmoAggregator({ ...FEED, options: { combine_pages: false } });
    expect(agg.sourceTitle).toBeNull();
    await agg.fetchArticleContent("https://mein-mmo.de/test-article/");

    expect(agg.sourceTitle).toBe("A real Mein-MMO headline");
  });

  it("falls back to og:title when h1.entry-title is absent", async () => {
    vi.mocked(fetchHtml).mockResolvedValueOnce(
      '<html><head><meta property="og:title" content="An og:title headline"></head>' +
        '<body><div class="entry-content"><p>Body.</p></div></body></html>',
    );

    const agg = new MeinMmoAggregator({ ...FEED, options: { combine_pages: false } });
    await agg.fetchArticleContent("https://mein-mmo.de/test-article/");

    expect(agg.sourceTitle).toBe("An og:title headline");
  });

  it("keeps page 1's headline even when a later paginated page has none", async () => {
    const page1 =
      '<html><body><h1 class="entry-title">Page 1 has the real headline</h1>' +
      '<div class="entry-content"><p>Page 1 body.</p>' +
      '<div class="page-links"><span class="post-page-numbers">1</span>' +
      '<a class="post-page-numbers" href="https://mein-mmo.de/test-article/2/">2</a>' +
      "</div></div></body></html>";
    const page2 =
      '<html><body><div class="entry-content"><p>Page 2 body, no headline repeated.</p></div></body></html>';

    vi.mocked(fetchHtml).mockImplementation(async (url: string) => {
      if (url.includes("/2/")) return page2;
      return page1;
    });

    const agg = new MeinMmoAggregator({ ...FEED, options: { combine_pages: true } });
    await agg.fetchArticleContent("https://mein-mmo.de/test-article/");

    expect(agg.sourceTitle).toBe("Page 1 has the real headline");
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

/**
 * Pipeline-review-3, Task 3, Finding 1: MeinMmoAggregator.extractContent()
 * (via extractMeinMmoContent()'s removeSelectors(getIgnoreSelectors()) call)
 * runs before MeinMmoAggregator.processContent()'s proxyYoutubeEmbeds() ever
 * sees a raw iframe. This site's `remove` list used to carry a bare
 * "iframe:not([src*='youtube.com']):not([src*='youtu.be'])" rule, so a
 * youtube-nocookie.com iframe that isn't wrapped in a <figure> (and so is
 * never claimed by processEmbeds()'s figure-based strategies either) was
 * deleted during extraction. Fixed by widening that rule to
 * YOUTUBE_IFRAME_KEEP_SELECTOR, which also exempts youtube-nocookie.com.
 * This drives the real extractContent() -> processContent() chain on the
 * real subclass, not the bare FullWebsiteAggregator base class.
 */
describe("MeinMmoAggregator YouTube iframe survives extraction into a facade", () => {
  it("keeps a bare youtube-nocookie.com iframe through extractContent() and turns it into a facade in processContent()", async () => {
    const agg = new MeinMmoAggregator(FEED);
    const html = `<html><body><div class="entry-content">
      <p>Video below.</p>
      <iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe>
    </div></body></html>`;

    const extracted = await agg.extractContent(html, ARTICLE);
    // The bug: this used to be gone already, before processContent() ever ran.
    expect(extracted).toContain("<iframe");
    expect(extracted).toContain("youtube-nocookie.com");

    const processed = await agg.processContent(extracted, ARTICLE);
    expect(processed).toContain("youtube-embed-container");
    expect(processed).toContain("dQw4w9WgXcQ");
    expect(processed).not.toContain("<iframe");
  });
});
