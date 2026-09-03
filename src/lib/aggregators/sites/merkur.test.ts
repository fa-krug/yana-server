import { describe, expect, it, vi } from "vitest";

import type { FeedLike, RawArticle } from "../base";
import { MerkurAggregator } from "./merkur";

vi.mock("../images/store", () => ({
  storeImageRefFromUrl: vi.fn(async () => "yana-img://abc123hash"),
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
