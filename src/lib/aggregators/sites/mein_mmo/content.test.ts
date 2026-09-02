import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cheerio from "cheerio";
import type { RawArticle } from "../../base";
import { DEFAULT_CHROME_LABELS } from "../../chrome-labels";
import { extractMeinMmoContent } from "./content";

vi.mock("../../embeds/bluesky", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../embeds/bluesky")>();
  return { ...actual, buildBlueskyEmbedHtml: vi.fn() };
});

// A bare factory rather than a spread of the original, as in aggregator.test.ts
// beside this file: `storeImageRefFromUrl` is the only export anything in this
// module graph imports, and loading the real one drags better-sqlite3's native
// binding in for nothing.
vi.mock("../../images/store", () => ({
  storeImageRefFromUrl: vi.fn(),
}));

import { buildBlueskyEmbedHtml } from "../../embeds/bluesky";
import { storeImageRefFromUrl } from "../../images/store";

const mockBuildBluesky = vi.mocked(buildBlueskyEmbedHtml);
const mockStoreImageRef = vi.mocked(storeImageRefFromUrl);

const ARTICLE: RawArticle = {
  name: "Test article",
  identifier: "https://mein-mmo.de/test-article/",
  raw_content: "",
  content: "",
  date: new Date(),
  author: "",
};

beforeEach(() => {
  mockBuildBluesky.mockReset();
  mockStoreImageRef.mockReset();
  mockStoreImageRef.mockImplementation(async (url: string) => `yana-img://stored(${url})`);
});

/**
 * A `div.wp-block-mmo-video` block as Mein-MMO's CMS really emits one --
 * trimmed to the parts this file reads, but nothing renamed. Captured from
 * https://mein-mmo.de/wow-20-jahre-video-erinnerung-goldene-zeit/ on
 * 2026-08-22.
 */
function cmsVideoBlock({ poster = true }: { poster?: boolean } = {}): string {
  const style = poster
    ? ' style="background-image: url(https://images.mein-mmo.de/medien/2022/07/WOW-Titel.jpg);"'
    : "";
  return (
    '<div class="wp-block-mmo-video" data-id="857744"><figure>' +
    '<div class="player-wrapper" data-id="dmp_40" data-type="inline">' +
    `<div id="dmp_40" class="video-player"${style}></div>` +
    `<div class="thumbnail"${style}>` +
    '<div class="overlay-info"><span class="video-tag"><span class="video-tag-text">' +
    "Video starten</span></span></div></div></div>" +
    '<figcaption class="title">WoW Classic: Der Trailer zu Wrath of the Lich King</figcaption>' +
    "<script>document.addEventListener( 'DOMContentLoaded', () => {" +
    "window.Mmo.functions.renderDmPlayer( { dmDivId: 'dmp_40', dmVideoId: 'x8co8a0'," +
    " hasAdvertising: true, videoAutoplayCms: true } ); });</script>" +
    '<label class="toggle"><input type="checkbox" name="autoplay" checked="checked" />' +
    "Autoplay</label></figure></div>"
  );
}

const ARTICLE_WITH_CMS_VIDEO =
  '<html><body><div class="entry-content"><p>Intro.</p>' +
  cmsVideoBlock() +
  '<h2 class="wp-block-heading">Rest of the article</h2></div></body></html>';

// The auto-inserted CMS player -- Mein-MMO picks the video, not the article's
// author, so it is regularly about something else entirely. Off by default.
describe("extractMeinMmoContent - div.wp-block-mmo-video", () => {
  it("drops the block, and fetches nothing for it, when include_videos is off", async () => {
    const result = await extractMeinMmoContent(
      ARTICLE_WITH_CMS_VIDEO,
      ARTICLE,
      [],
      DEFAULT_CHROME_LABELS,
      false,
    );

    expect(result).toContain("Intro.");
    expect(result).toContain("Rest of the article");
    expect(result).not.toContain("dailymotion");
    expect(result).not.toContain("Wrath of the Lich King");
    expect(result).not.toContain("wp-block-mmo-video");
    // Removed before the thumbnail is localized, not by selectorsToRemove
    // afterward -- otherwise every dropped block still costs a request.
    expect(mockStoreImageRef).not.toHaveBeenCalled();
  });

  it("keeps it as a Dailymotion facade when include_videos is on", async () => {
    const result = await extractMeinMmoContent(
      ARTICLE_WITH_CMS_VIDEO,
      ARTICLE,
      [],
      DEFAULT_CHROME_LABELS,
      true,
    );

    expect(result).toContain("https://www.dailymotion.com/video/x8co8a0");
    expect(result).toContain("Wrath of the Lich King");
  });

  it("prefers the article's own poster over Dailymotion's frame grab", async () => {
    const result = await extractMeinMmoContent(
      ARTICLE_WITH_CMS_VIDEO,
      ARTICLE,
      [],
      DEFAULT_CHROME_LABELS,
      true,
    );

    const $ = cheerio.load(result);
    expect($("img").attr("src")).toBe(
      "yana-img://stored(https://images.mein-mmo.de/medien/2022/07/WOW-Titel.jpg)",
    );
    expect(mockStoreImageRef).not.toHaveBeenCalledWith(
      "https://www.dailymotion.com/thumbnail/video/x8co8a0",
      expect.anything(),
    );
  });

  it("falls back to Dailymotion's thumbnail when the block carries no poster", async () => {
    const html =
      '<html><body><div class="entry-content"><p>Intro.</p>' +
      cmsVideoBlock({ poster: false }) +
      "</div></body></html>";

    const result = await extractMeinMmoContent(html, ARTICLE, [], DEFAULT_CHROME_LABELS, true);

    const $ = cheerio.load(result);
    expect($("img").attr("src")).toBe(
      "yana-img://stored(https://www.dailymotion.com/thumbnail/video/x8co8a0)",
    );
  });

  it("falls back to Dailymotion's thumbnail when the poster cannot be stored", async () => {
    mockStoreImageRef.mockImplementation(async (url: string) =>
      url.includes("images.mein-mmo.de") ? null : `yana-img://stored(${url})`,
    );

    const result = await extractMeinMmoContent(
      ARTICLE_WITH_CMS_VIDEO,
      ARTICLE,
      [],
      DEFAULT_CHROME_LABELS,
      true,
    );

    const $ = cheerio.load(result);
    expect($("img").attr("src")).toBe(
      "yana-img://stored(https://www.dailymotion.com/thumbnail/video/x8co8a0)",
    );
  });
});

describe("extractMeinMmoContent", () => {
  it("resolves asynchronously and extracts the entry-content div", async () => {
    const html = '<html><body><div class="entry-content"><p>Hello world.</p></div></body></html>';

    const result = extractMeinMmoContent(html, ARTICLE, [], DEFAULT_CHROME_LABELS, false);
    expect(result).toBeInstanceOf(Promise);

    const resolved = await result;
    expect(resolved).toContain("Hello world.");
  });

  it("propagates a rich Bluesky embed built asynchronously into the returned HTML", async () => {
    mockBuildBluesky.mockResolvedValue("<blockquote><p>Rich Bluesky post</p></blockquote>");

    const html =
      '<html><body><div class="entry-content"><p>Intro.</p>' +
      '<figure class="wp-block-embed">' +
      '<a href="https://bsky.app/profile/user.bsky.social/post/abc">link</a>' +
      "</figure></div></body></html>";

    const result = await extractMeinMmoContent(html, ARTICLE, [], DEFAULT_CHROME_LABELS, false);

    expect(result).toContain("Rich Bluesky post");
    expect(result).toContain('data-sanitized-class="bluesky-embed"');
  });
});

// Everything above mocks buildBlueskyEmbedHtml at the module boundary, which
// proves the async plumbing works but never exercises the real builder's HTML
// (inline styles, real Bluesky CDN <img> URLs) against this file's later
// cleanDataAttributes/sanitizeClassNames passes. This block stubs fetch
// instead -- the actual network boundary -- and vi.doUnmock's the bluesky
// module so the real buildBlueskyEmbedHtml runs.
//
// Image localization itself is NOT this function's job: extractMeinMmoContent
// only builds the content HTML (with the real, un-localized Bluesky CDN URL
// still present); MeinMmoAggregator.processContent() -- one stage later, in
// aggregator.ts -- is what resolves every body <img src> (Bluesky's included)
// to a real yana-img:// reference via storeImageRefFromUrl.
describe("extractMeinMmoContent - real Bluesky builder end-to-end (unmocked)", () => {
  it("survives the real extraction pipeline with the embed's image left for processContent to localize", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes("resolveHandle")) {
        return { ok: true, json: async () => ({ did: "did:plc:test123" }) };
      }
      return {
        ok: true,
        json: async () => ({
          posts: [
            {
              author: { handle: "user.bsky.social", displayName: "Real Author" },
              record: { text: "Real post text.", createdAt: "2026-06-04T04:34:34.364Z" },
              likeCount: 5,
              repostCount: 1,
              replyCount: 0,
              embed: {
                $type: "app.bsky.embed.images#view",
                images: [{ fullsize: "https://cdn.bsky.app/img/test.jpg" }],
              },
            },
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    vi.doUnmock("../../embeds/bluesky");
    vi.resetModules();
    const { extractMeinMmoContent: realExtractMeinMmoContent } = await import("./content");

    const html =
      '<html><body><div class="entry-content"><p>Intro.</p>' +
      '<figure class="wp-block-embed">' +
      '<a href="https://bsky.app/profile/user.bsky.social/post/abc">link</a>' +
      "</figure></div></body></html>";

    const result = await realExtractMeinMmoContent(html, ARTICLE, [], DEFAULT_CHROME_LABELS, false);

    // Proves the real builder ran (not the module-mocked stub above).
    expect(result).toContain("Real Author");
    expect(result).toContain("Real post text.");

    // extractMeinMmoContent does not localize images -- that is
    // MeinMmoAggregator.processContent()'s job, one stage later -- so the
    // real Bluesky CDN URL is expected to still be present here, unmodified.
    const $ = cheerio.load(result);
    const src = $("img").attr("src");
    expect(src).toBe("https://cdn.bsky.app/img/test.jpg");

    vi.unstubAllGlobals();
  });
});
