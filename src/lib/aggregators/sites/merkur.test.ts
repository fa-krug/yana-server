import { describe, expect, it, vi } from "vitest";

import type { FeedLike, RawArticle } from "../base";
import { MerkurAggregator } from "./merkur";

vi.mock("../images/store", () => ({
  storeImageRefFromUrl: vi.fn(async () => "yana-img://abc123hash"),
}));

vi.mock("../http/fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../http/fetcher")>()),
  fetchHtml: vi.fn(),
}));

function aggregatorFor(): MerkurAggregator {
  const feed: FeedLike = { identifier: "https://www.merkur.de/rssfeed.rdf", dailyLimit: 20 };
  return new MerkurAggregator(feed);
}

function videoArticle(): RawArticle {
  return {
    name: "Video Post",
    identifier: "https://www.merkur.de/video-x-1234567.html",
    raw_content: "",
    content: "",
    date: new Date(),
  };
}

/**
 * Pipeline-review-3, Task 3, Finding 1: extractContent() (via
 * extractMainContent(), fed by getIgnoreSelectors()) runs before
 * processContent()'s proxyYoutubeEmbeds() ever gets a chance to recognise a
 * YouTube iframe. Merkur's selectorsToRemove used to carry a bare
 * "iframe:not([src*='youtube.com']):not([src*='youtu.be'])" rule, so a
 * youtube-nocookie.com iframe -- whose src contains neither substring -- was
 * deleted during *extraction*, one stage before youtubeIdFrom() could ever
 * see it. Fixed by widening that rule (now YOUTUBE_IFRAME_KEEP_SELECTOR, the
 * shared exemption list in embeds/youtube-url.ts) to also exempt
 * youtube-nocookie.com. This test drives the real, full
 * extractContent() -> processContent() chain on the real subclass -- a test
 * against a bare FullWebsiteAggregator instance (whose default
 * selectorsToRemove carries no iframe:not(...) rule at all) would not catch
 * this, because it never exercises the rule that caused the bug.
 */
describe("MerkurAggregator YouTube iframe survives extraction into a facade", () => {
  it("keeps a youtube-nocookie.com iframe through extractContent() and turns it into a facade in processContent()", async () => {
    const agg = aggregatorFor();
    const html = `
      <html><body>
        <div class="idjs-Story">
          <p>Video below.</p>
          <iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe>
        </div>
      </body></html>
    `;

    const extracted = await agg.extractContent(html, videoArticle());
    // The bug: this used to be gone already, before processContent() ever ran.
    expect(extracted).toContain("<iframe");
    expect(extracted).toContain("youtube-nocookie.com");

    const processed = await agg.processContent(extracted, videoArticle());
    // Merkur's own processContent() runs sanitizeHtmlAttributes()/
    // removeSanitizedAttributes() after proxyYoutubeEmbeds(), which strips
    // the facade's own class marker along with every other raw class
    // attribute -- so unlike the other two sites, "youtube-embed-container"
    // itself does not survive here. What matters for this bug is that the
    // iframe became a facade (a real link plus a localized thumbnail) rather
    // than being deleted outright.
    expect(processed).toContain("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(processed).toContain("yana-img://abc123hash");
    expect(processed).not.toContain("<iframe");
  });

  it("still drops a stray non-YouTube iframe during extraction", async () => {
    const agg = aggregatorFor();
    const html = `
      <html><body>
        <div class="idjs-Story">
          <p>Not a video.</p>
          <iframe src="https://evil.example.com/tracker"></iframe>
        </div>
      </body></html>
    `;

    const extracted = await agg.extractContent(html, videoArticle());
    expect(extracted).not.toContain("<iframe");
  });
});

/**
 * Pipeline-review-3, Task 8, Step 5: `extractContent()` used to fall back to
 * `<body>` on a `.idjs-Story` selector miss -- twice over, in fact.
 * `extractMainContent()` (not the `...IfPresent()` variant) already falls
 * back to `<body>` internally, so the `!extracted || !extracted.trim()`
 * check almost never actually ran; on the rare page where even `<body>` came
 * back empty, `super.extractContent()` (`FullWebsiteAggregator`'s own,
 * pre-unification implementation) fell back to `<body>` *again*. Either way,
 * a selector miss could surface site navigation, not the article, as
 * "content". This is pinned here before the fix, characterising exactly what
 * today's code produces, and updated in the same change to assert the new,
 * safer behaviour (the shared three-tier ladder in
 * `FullWebsiteAggregator.extractContentWithFallback()`: generic guess, then
 * the RSS summary -- never `<body>`).
 */
describe("MerkurAggregator extractContent selector miss", () => {
  it("never surfaces site navigation as the article body on a selector miss", async () => {
    const agg = aggregatorFor();
    const html = `
      <html><body>
        <nav class="site-nav"><a href="/">Home</a><a href="/politik">Politik</a></nav>
        <div class="unrelated">This is not the article, it is page chrome.</div>
      </body></html>
    `;
    const article: RawArticle = {
      name: "No Selector Match",
      identifier: "https://www.merkur.de/no-match-1234567.html",
      raw_content: "",
      content: "The RSS entry's own summary.",
      date: new Date(),
    };

    const extracted = await agg.extractContent(html, article);

    // The fix: a miss degrades to the RSS summary already on the article,
    // never to the page's own navigation/chrome.
    expect(extracted).toBe("The RSS entry's own summary.");
    expect(extracted).not.toContain("site-nav");
    expect(extracted).not.toContain("Politik");
  });
});

/**
 * Pipeline-review-3, Task 8: same structural gap as Heise --
 * `FullWebsiteAggregator.fetchArticleContent()` dropped `noteSourceTitle()`
 * for the whole family. `.id-StoryElement-headline` is itself in
 * `selectorsToRemove`, so `sourceTitleFrom()` has to read the raw page.
 */
describe("MerkurAggregator sourceTitle", () => {
  it("reports the headline read off the fetched page", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(
      `<html><body><h1 class="id-StoryElement-headline">A real Merkur headline</h1></body></html>`,
    );

    const agg = aggregatorFor();
    expect(agg.sourceTitle).toBeNull();
    await agg.fetchArticleContent("https://www.merkur.de/some-article-1234567.html");

    expect(agg.sourceTitle).toBe("A real Merkur headline");
  });
});
