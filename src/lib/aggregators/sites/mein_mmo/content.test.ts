import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cheerio from "cheerio";
import type { RawArticle } from "../../base";
import { extractMeinMmoContent } from "./content";

vi.mock("../../embeds/bluesky", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../embeds/bluesky")>();
  return { ...actual, buildBlueskyEmbedHtml: vi.fn() };
});

import { buildBlueskyEmbedHtml } from "../../embeds/bluesky";

const mockBuildBluesky = vi.mocked(buildBlueskyEmbedHtml);

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
});

describe("extractMeinMmoContent", () => {
  it("resolves asynchronously and extracts the entry-content div", async () => {
    const html = '<html><body><div class="entry-content"><p>Hello world.</p></div></body></html>';

    const result = extractMeinMmoContent(html, ARTICLE, []);
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

    const result = await extractMeinMmoContent(html, ARTICLE, []);

    expect(result).toContain("Rich Bluesky post");
    expect(result).toContain('data-sanitized-class="bluesky-embed"');
  });
});

// Everything above mocks buildBlueskyEmbedHtml at the module boundary, which
// proves the async plumbing works but never exercises the real builder's HTML
// (inline styles, real Bluesky CDN <img> URLs) against this file's later
// cleanDataAttributes/sanitizeClassNames passes, or against the img-src
// localization pass at content.ts:116-125 that every other embed relies on.
// This block stubs fetch instead -- the actual network boundary -- and
// vi.doUnmock's the bluesky module so the real buildBlueskyEmbedHtml runs.
describe("extractMeinMmoContent - real Bluesky builder end-to-end (unmocked)", () => {
  it("survives the real extraction pipeline and localizes the embed's image", async () => {
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

    const result = await realExtractMeinMmoContent(html, ARTICLE, []);

    // Proves the real builder ran (not the module-mocked stub above).
    expect(result).toContain("Real Author");
    expect(result).toContain("Real post text.");

    // Proves the existing localization pass at content.ts:116-125 applies to
    // Bluesky's images too: the raw CDN URL must not survive into the output.
    const $ = cheerio.load(result);
    const src = $("img").attr("src");
    expect(src).toMatch(/^yana-img:\/\//);
    expect(result).not.toContain("https://cdn.bsky.app/img/test.jpg");

    vi.unstubAllGlobals();
  });
});
