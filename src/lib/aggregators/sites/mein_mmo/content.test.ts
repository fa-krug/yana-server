import { describe, it, expect, vi, beforeEach } from "vitest";
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
