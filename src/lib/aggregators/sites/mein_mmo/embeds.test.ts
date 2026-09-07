import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cheerio from "cheerio";
import { DEFAULT_CHROME_LABELS } from "../../chrome-labels";
import { processEmbeds } from "./embeds";

vi.mock("../../embeds/bluesky", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../embeds/bluesky")>();
  return { ...actual, buildBlueskyEmbedHtml: vi.fn() };
});

vi.mock("../../images/store", () => ({
  storeImageRefFromUrl: vi.fn(async () => "yana-img://abc123hash"),
}));

import { buildBlueskyEmbedHtml } from "../../embeds/bluesky";

const mockBuildBluesky = vi.mocked(buildBlueskyEmbedHtml);

beforeEach(() => {
  mockBuildBluesky.mockReset();
});

describe("processEmbeds - Bluesky", () => {
  it("replaces the figure with the rich embed when the build succeeds", async () => {
    mockBuildBluesky.mockResolvedValue("<blockquote><p>Bluesky post text</p></blockquote>");

    const $ = cheerio.load(
      '<div class="entry-content"><figure class="wp-block-embed">' +
        '<a href="https://bsky.app/profile/user.bsky.social/post/abc">link</a>' +
        "</figure></div>",
    );
    const $content = $(".entry-content");

    await processEmbeds($content, $, DEFAULT_CHROME_LABELS);

    expect($content.find("figure").length).toBe(0);
    expect($content.html()).toContain("Bluesky post text");
    expect($content.find('div[data-sanitized-class="bluesky-embed"]').length).toBe(1);
  });

  it("removes the figure entirely when the build fails", async () => {
    mockBuildBluesky.mockResolvedValue(null);

    const $ = cheerio.load(
      '<div class="entry-content"><figure class="wp-block-embed">' +
        '<a href="https://bsky.app/profile/user.bsky.social/post/abc">link</a>' +
        "</figure><p>after</p></div>",
    );
    const $content = $(".entry-content");

    await processEmbeds($content, $, DEFAULT_CHROME_LABELS);

    expect($content.find("figure").length).toBe(0);
    expect($content.find('div[data-sanitized-class="bluesky-embed"]').length).toBe(0);
    expect($content.html()).toContain("after");
  });
});

describe("processEmbeds - other processors still run under the async loop", () => {
  it("still converts a YouTube figure to a facade", async () => {
    const $ = cheerio.load(
      '<div class="entry-content"><figure class="wp-block-embed-youtube">' +
        '<a href="https://www.youtube.com/watch?v=abcdefghijk">watch</a>' +
        "</figure></div>",
    );
    const $content = $(".entry-content");

    await processEmbeds($content, $, DEFAULT_CHROME_LABELS);

    expect($content.find("figure").length).toBe(0);
    expect($content.find('div[data-sanitized-class="youtube-embed"]').length).toBe(1);
    expect($content.find('div[data-sanitized-class="youtube-embed"] img').attr("src")).toBe(
      "yana-img://abc123hash",
    );
  });

  /**
   * This only covers a nocookie embed already wrapped in a recognised
   * `<figure>` -- processEmbeds() runs *after* extractMeinMmoContent()'s
   * removeSelectors() call and never sees a bare, unwrapped
   * `<iframe src="...nocookie...">` at all (that case is deleted during
   * extraction, before processEmbeds() or this test's direct call to it ever
   * runs). The bare-iframe case is covered end-to-end, through the real
   * MeinMmoAggregator.extractContent() -> processContent() chain, in
   * aggregator.test.ts.
   */
  it("still converts a privacy-embedded (youtube-nocookie.com) figure to a facade", async () => {
    const $ = cheerio.load(
      '<div class="entry-content"><figure class="wp-block-embed-youtube" ' +
        'data-sanitized-data-embed-content="https://www.youtube-nocookie.com/embed/abcdefghijk">' +
        "</figure></div>",
    );
    const $content = $(".entry-content");

    await processEmbeds($content, $, DEFAULT_CHROME_LABELS);

    expect($content.find("figure").length).toBe(0);
    expect($content.find('div[data-sanitized-class="youtube-embed"]').length).toBe(1);
  });

  it("still converts a Reddit figure with a thumbnail image", async () => {
    const $ = cheerio.load(
      '<div class="entry-content"><figure class="wp-block-embed embed-reddit">' +
        '<img src="https://reddit.com/thumb.jpg">' +
        '<a href="https://reddit.com/r/foo/comments/123">view</a>' +
        "</figure></div>",
    );
    const $content = $(".entry-content");

    await processEmbeds($content, $, DEFAULT_CHROME_LABELS);

    expect($content.find("figure").length).toBe(0);
    expect($content.find("img").attr("src")).toBe("https://reddit.com/thumb.jpg");
  });

  /**
   * Pipeline-review-3, Task 3, Finding 2: YouTubeFallbackProcessor is the
   * third inline copy of YouTube URL recognition in this file (after
   * YouTubeEmbedProcessor's own extractVideoId()), and it used to test only
   * the "youtube.com"/"youtu.be" substrings on an anchor href -- the same
   * gap Finding 1 closed for iframe srcs. This figure carries none of
   * YouTubeEmbedProcessor's recognised classes, so it falls through to the
   * fallback processor, which must now recognise the nocookie domain too
   * (routed through isYoutubeUrl() from embeds/youtube-url.ts).
   */
  it("falls back to recognising a nocookie.com anchor href when no other processor claims the figure", async () => {
    const $ = cheerio.load(
      '<div class="entry-content"><figure class="wp-block-embed">' +
        '<a href="https://www.youtube-nocookie.com/embed/abcdefghijk">watch</a>' +
        "</figure></div>",
    );
    const $content = $(".entry-content");

    await processEmbeds($content, $, DEFAULT_CHROME_LABELS);

    expect($content.find("figure").length).toBe(0);
    expect($content.find('div[data-sanitized-class="youtube-embed"]').length).toBe(1);
  });
});
