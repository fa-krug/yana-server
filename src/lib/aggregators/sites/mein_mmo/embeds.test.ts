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
});
