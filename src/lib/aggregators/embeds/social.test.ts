import { describe, it, expect, vi } from "vitest";
import { isBlueskyUrl, extractBlueskyPostInfo, detectBluesky, convertBluesky } from "./bluesky";
import { isTwitterUrl, extractTweetId, detectTwitter, convertTwitter } from "./twitter";
import * as cheerio from "cheerio";

// Mock image store and fetch for both providers
vi.mock("../images/store", () => ({
  storeImageRefFromUrl: vi.fn(async () => "yana-img://socialhash"),
}));

// Mock global fetch for API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("bluesky", () => {
  describe("isBlueskyUrl", () => {
    it("detects bsky.app URL", () => {
      expect(isBlueskyUrl("https://bsky.app/profile/user.bsky.social/post/abc123")).toBe(true);
    });
    it("rejects non-Bluesky", () => {
      expect(isBlueskyUrl("https://example.com")).toBe(false);
    });
    it("rejects empty", () => {
      expect(isBlueskyUrl("")).toBe(false);
    });
  });

  describe("extractBlueskyPostInfo", () => {
    it("extracts actor and rkey", () => {
      const result = extractBlueskyPostInfo(
        "https://bsky.app/profile/user.bsky.social/post/abc123",
      );
      expect(result).toEqual({ actor: "user.bsky.social", rkey: "abc123" });
    });
    it("returns null for non-post URL", () => {
      expect(extractBlueskyPostInfo("https://bsky.app/profile/user.bsky.social")).toBeNull();
    });
    it("returns null for empty", () => {
      expect(extractBlueskyPostInfo("")).toBeNull();
    });
  });

  describe("detectBluesky", () => {
    it("detects element with Bluesky anchor", () => {
      const $ = cheerio.load(
        '<div><a href="https://bsky.app/profile/user/post/abc">View</a></div>',
      );
      expect(detectBluesky($("div").get(0)!, $)).toBe(true);
    });
    it("rejects element without Bluesky", () => {
      const $ = cheerio.load('<div><a href="https://example.com">View</a></div>');
      expect(detectBluesky($("div").get(0)!, $)).toBe(false);
    });
  });

  describe("convertBluesky", () => {
    it("produces a tweet block from Bluesky URL", async () => {
      // Mock the API calls
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ did: "did:plc:test123" }),
      });

      const $ = cheerio.load(
        '<div><a href="https://bsky.app/profile/user.bsky.social/post/abc123">View on Bluesky</a></div>',
      );
      const result = await convertBluesky($("div").get(0)!, $, {});
      expect(result).not.toBeNull();
      expect(result!.provider).toBe("tweet");
      expect(result!.externalUrl).toBe("https://bsky.app/profile/user.bsky.social/post/abc123");
    });

    it("returns null without Bluesky URL", async () => {
      const $ = cheerio.load('<div><a href="https://example.com">Link</a></div>');
      const result = await convertBluesky($("div").get(0)!, $, {});
      expect(result).toBeNull();
    });
  });
});

describe("twitter", () => {
  describe("isTwitterUrl", () => {
    it("detects twitter.com", () => {
      expect(isTwitterUrl("https://twitter.com/user/status/123")).toBe(true);
    });
    it("detects x.com", () => {
      expect(isTwitterUrl("https://x.com/user/status/123")).toBe(true);
    });
    it("rejects non-Twitter", () => {
      expect(isTwitterUrl("https://example.com")).toBe(false);
    });
    it("rejects empty", () => {
      expect(isTwitterUrl("")).toBe(false);
    });
  });

  describe("extractTweetId", () => {
    it("extracts ID from twitter.com", () => {
      expect(extractTweetId("https://twitter.com/user/status/1234567890")).toBe("1234567890");
    });
    it("extracts ID from x.com", () => {
      expect(extractTweetId("https://x.com/user/status/1234567890")).toBe("1234567890");
    });
    it("returns null for non-tweet URL", () => {
      expect(extractTweetId("https://twitter.com/user")).toBeNull();
    });
  });

  describe("detectTwitter", () => {
    it("detects element with Twitter anchor", () => {
      const $ = cheerio.load('<div><a href="https://twitter.com/user/status/123">View</a></div>');
      expect(detectTwitter($("div").get(0)!, $)).toBe(true);
    });
    it("detects element with X.com anchor", () => {
      const $ = cheerio.load('<div><a href="https://x.com/user/status/123">View</a></div>');
      expect(detectTwitter($("div").get(0)!, $)).toBe(true);
    });
    it("rejects element without Twitter", () => {
      const $ = cheerio.load('<div><a href="https://example.com">View</a></div>');
      expect(detectTwitter($("div").get(0)!, $)).toBe(false);
    });
  });

  describe("convertTwitter", () => {
    it("produces a tweet block", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          tweet: {
            text: "Hello world",
            author: { name: "Test User", screen_name: "testuser" },
            media: {},
          },
        }),
      });

      const $ = cheerio.load(
        '<div><a href="https://twitter.com/user/status/123456">Tweet</a></div>',
      );
      const result = await convertTwitter($("div").get(0)!, $, {});
      expect(result).not.toBeNull();
      expect(result!.provider).toBe("tweet");
      expect(result!.externalUrl).toBe("https://twitter.com/user/status/123456");
    });

    it("returns null without Twitter URL", async () => {
      const $ = cheerio.load('<div><a href="https://example.com">Link</a></div>');
      const result = await convertTwitter($("div").get(0)!, $, {});
      expect(result).toBeNull();
    });
  });
});

describe("privacy guards", () => {
  it("thumbnailRef must be localized (yana-img://) not a remote URL", async () => {
    // When storeImageRefFromUrl returns a ref, it must be yana-img://
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tweet: {
          text: "photo",
          author: { name: "User" },
          media: { photos: [{ url: "https://pbs.twimg.com/media/photo.jpg" }] },
        },
      }),
    });

    const $ = cheerio.load('<div><a href="https://twitter.com/user/status/789">Tweet</a></div>');
    const result = await convertTwitter($("div").get(0)!, $, {});
    if (result && result.thumbnailRef) {
      expect(result.thumbnailRef).toMatch(/^yana-img:\/\//);
      expect(result.thumbnailRef).not.toMatch(/^https?:\/\//);
    }
  });
});
