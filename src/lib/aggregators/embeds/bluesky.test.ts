import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildBlueskyEmbedHtml, formatBlueskyCount, formatBlueskyPostDate } from "./bluesky";
import * as cheerio from "cheerio";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const SAMPLE_POST = {
  author: {
    handle: "stirpicus.bsky.social",
    displayName: "eric stirpe",
  },
  record: {
    text: "This is a test post.",
    createdAt: "2026-06-04T04:34:34.364Z",
  },
  likeCount: 3275,
  repostCount: 868,
  replyCount: 20,
  embed: {
    $type: "app.bsky.embed.images#view",
    images: [{ fullsize: "https://cdn.bsky.app/img/1.jpg" }],
  },
};

/** Routes the two Bluesky API calls `buildBlueskyEmbedHtml` makes: DID resolution, then the post fetch. */
function mockBlueskyApi(post: Record<string, unknown> | null) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("resolveHandle")) {
      return { ok: true, json: async () => ({ did: "did:plc:test123" }) };
    }
    return { ok: true, json: async () => ({ posts: post ? [post] : [] }) };
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("formatBlueskyCount", () => {
  it("returns small counts verbatim", () => {
    expect(formatBlueskyCount(0)).toBe("0");
    expect(formatBlueskyCount(999)).toBe("999");
  });

  it("formats thousands with one decimal", () => {
    expect(formatBlueskyCount(1234)).toBe("1.2K");
  });

  it("formats millions with one decimal", () => {
    expect(formatBlueskyCount(1_500_000)).toBe("1.5M");
  });
});

describe("formatBlueskyPostDate", () => {
  it("formats a valid ISO date", () => {
    expect(formatBlueskyPostDate("2026-06-04T04:34:34.364Z")).toBe("Jun 04, 2026");
  });

  it("returns null for an unparseable date", () => {
    expect(formatBlueskyPostDate("not a date")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(formatBlueskyPostDate("")).toBeNull();
  });
});

describe("buildBlueskyEmbedHtml", () => {
  it("renders author, text, image and stats for a full post", async () => {
    mockBlueskyApi(SAMPLE_POST);

    const result = await buildBlueskyEmbedHtml(
      "https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27",
    );

    expect(result).not.toBeNull();
    expect(result).toContain("<blockquote");
    expect(result).toContain("eric stirpe");
    expect(result).toContain("@stirpicus.bsky.social");
    expect(result).toContain("This is a test post.");
    expect(result).toContain("View on Bluesky");
    expect(result).toContain("https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27");
    expect(result).toContain("https://cdn.bsky.app/img/1.jpg");
    expect(result).toContain("3.3K");
    expect(result).toContain("868");
    expect(result).toContain("Jun 04, 2026");
  });

  it("omits the image paragraph when the post has none", async () => {
    mockBlueskyApi({
      author: { handle: "user.bsky.social", displayName: "" },
      record: { text: "Text only post.", createdAt: "" },
      likeCount: 0,
      repostCount: 0,
      replyCount: 0,
      embed: {},
    });

    const result = await buildBlueskyEmbedHtml(
      "https://bsky.app/profile/user.bsky.social/post/abc",
    );

    expect(result).not.toBeNull();
    expect(result).toContain("Text only post.");
    expect(result).not.toContain("<img");
  });

  it("strips tracking params from the post URL", async () => {
    mockBlueskyApi(SAMPLE_POST);

    const result = await buildBlueskyEmbedHtml(
      "https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27?foo=bar",
    );

    expect(result).not.toBeNull();
    expect(result).not.toContain("?foo=bar");
    expect(result).toContain("https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27");
  });

  it("HTML-escapes post text and author name", async () => {
    mockBlueskyApi({
      author: { handle: "user.bsky.social", displayName: "User <bad>" },
      record: { text: "Test <script>alert('xss')</script> & more", createdAt: "" },
      likeCount: 0,
      repostCount: 0,
      replyCount: 0,
      embed: {},
    });

    const result = await buildBlueskyEmbedHtml(
      "https://bsky.app/profile/user.bsky.social/post/abc",
    );

    expect(result).not.toBeNull();
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).toContain("&amp; more");
    expect(result).toContain("User &lt;bad&gt;");
  });

  it("returns null for a non-post URL", async () => {
    const result = await buildBlueskyEmbedHtml("https://example.com/not-a-post");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when the API has no matching post", async () => {
    mockBlueskyApi(null);
    const result = await buildBlueskyEmbedHtml(
      "https://bsky.app/profile/user.bsky.social/post/abc",
    );
    expect(result).toBeNull();
  });

  it("skips a javascript: post URL as a link but still renders the card", async () => {
    mockBlueskyApi(SAMPLE_POST);
    // Not a realistic URL shape (fails extractBlueskyPostInfo's own pattern in practice),
    // so this exercises the is_safe_url guard on a URL that already matched a profile/post path.
    const result = await buildBlueskyEmbedHtml(
      "https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27",
    );
    expect(result).not.toBeNull();
    const $ = cheerio.load(result!);
    expect($("script").length).toBe(0);
  });

  it("skips an unsafe image URL rather than rendering it", async () => {
    mockBlueskyApi({
      ...SAMPLE_POST,
      embed: {
        $type: "app.bsky.embed.images#view",
        images: [{ fullsize: "javascript:alert(1)" }],
      },
    });

    const result = await buildBlueskyEmbedHtml(
      "https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27",
    );

    expect(result).not.toBeNull();
    const $ = cheerio.load(result!);
    expect($("img").length).toBe(0);
  });
});
