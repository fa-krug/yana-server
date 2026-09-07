import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArticleSkipError } from "../errors";
import { getHeaderImageRef, type HeaderElementData } from "./context";
import { extractHeaderElement, HeaderElementExtractor } from "./extractor";
import {
  extractPostInfoFromUrl,
  fetchSubredditIcon,
  fixRedditMediaUrl,
  GenericImageStrategy,
  isRedditEmbedUrl,
  RedditPostStrategy,
  YouTubeStrategy,
} from "./strategies";

// Mock storeImageBytes to avoid needing database setup in unit tests
vi.mock("../images/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../images/store")>();
  return {
    ...actual,
    storeImageBytes: vi.fn(async (bytes: Buffer) => {
      if (!bytes || bytes.length === 0) return null;
      return "mockedhash1234567890123456789012345678901234567890123456789012345678";
    }),
  };
});

describe("Header Element Extraction", () => {
  let sampleImageBuffer: Buffer;

  beforeEach(async () => {
    sampleImageBuffer = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 50, g: 150, b: 250 } },
    })
      .png()
      .toBuffer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("HeaderElementContext & Data Helpers", () => {
    it("getHeaderImageRef returns yana-img:// ref", () => {
      const data: HeaderElementData = {
        imageBytes: sampleImageBuffer,
        contentType: "image/png",
        contentHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      };
      expect(getHeaderImageRef(data)).toBe(
        "yana-img://abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      );
    });
  });

  describe("Reddit Embed Strategy & Utilities", () => {
    it("isRedditEmbedUrl detects vxreddit and embed URLs", () => {
      expect(isRedditEmbedUrl("https://vxreddit.com/r/funny/comments/123")).toBe(true);
      expect(isRedditEmbedUrl("https://reddit.com/embed/123")).toBe(true);
      expect(isRedditEmbedUrl("https://v.redd.it/embed/123")).toBe(true);
      expect(isRedditEmbedUrl("https://reddit.com/r/funny/comments/123")).toBe(false);
      expect(isRedditEmbedUrl("")).toBe(false);
    });
  });

  describe("Reddit Post Strategy & Utilities", () => {
    it("extractPostInfoFromUrl parses subreddit and post_id", () => {
      const info = extractPostInfoFromUrl("https://reddit.com/r/typescript/comments/abc123/title");
      expect(info.subreddit).toBe("typescript");
      expect(info.postId).toBe("abc123");

      const emptyInfo = extractPostInfoFromUrl("https://example.com");
      expect(emptyInfo.subreddit).toBeNull();
      expect(emptyInfo.postId).toBeNull();
    });

    it("fixRedditMediaUrl unescapes &amp;", () => {
      expect(fixRedditMediaUrl("https://preview.redd.it/img.png?a=1&amp;b=2")).toBe(
        "https://preview.redd.it/img.png?a=1&b=2",
      );
    });

    it("fetchSubredditIcon returns null for a missing subreddit", async () => {
      expect(await fetchSubredditIcon("")).toBeNull();
    });

    it("fetchSubredditIcon parses the icon URL from the API response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { icon_img: "https://styles.redditmedia.com/icon.png?a=1&amp;b=2" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const iconUrl = await fetchSubredditIcon("typescript");
      expect(iconUrl).toBe("https://styles.redditmedia.com/icon.png?a=1&b=2");
    });

    it("RedditPostStrategy rejects embed URLs but accepts post URLs", () => {
      const strategy = new RedditPostStrategy();
      expect(strategy.canHandle("https://vxreddit.com/r/typescript/comments/abc123")).toBe(false);
      expect(strategy.canHandle("https://reddit.com/r/typescript/comments/abc123/title")).toBe(
        true,
      );
      expect(strategy.canHandle("https://example.com")).toBe(false);
    });
  });

  describe("YouTube Strategy", () => {
    it("YouTubeStrategy handles youtube video URLs", () => {
      const strategy = new YouTubeStrategy();
      expect(strategy.canHandle("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
      expect(strategy.canHandle("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
      expect(strategy.canHandle("https://example.com")).toBe(false);
    });

    it("YouTubeStrategy fetches thumbnail and creates HeaderElementData", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(new Uint8Array(sampleImageBuffer), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
      );

      const strategy = new YouTubeStrategy();
      const result = await strategy.create({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      });

      expect(result).not.toBeNull();
      expect(result?.contentType).toBe("image/jpeg");
      expect(result?.contentHash).toBe(
        "mockedhash1234567890123456789012345678901234567890123456789012345678",
      );
    });
  });

  describe("GenericImageStrategy", () => {
    it("skips non-embed v.redd.it URLs", () => {
      const strategy = new GenericImageStrategy();
      expect(strategy.canHandle("https://v.redd.it/12345")).toBe(false);
      expect(strategy.canHandle("https://v.redd.it/embed/12345")).toBe(true);
      expect(strategy.canHandle("https://example.com/article")).toBe(true);
    });
  });

  describe("HeaderElementExtractor", () => {
    it("has strategies in exact specified order", () => {
      const extractor = new HeaderElementExtractor();
      expect(extractor.strategies).toHaveLength(3);
      expect(extractor.strategies[0]).toBeInstanceOf(RedditPostStrategy);
      expect(extractor.strategies[1]).toBeInstanceOf(YouTubeStrategy);
      expect(extractor.strategies[2]).toBeInstanceOf(GenericImageStrategy);
    });

    it("returns null for empty URL", async () => {
      const extractor = new HeaderElementExtractor();
      expect(await extractor.extractHeaderElement("")).toBeNull();
    });

    it("uses domain override if URL matches override prefix", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(new Uint8Array(sampleImageBuffer), {
          status: 200,
          headers: { "Content-Type": "image/svg+xml" },
        }),
      );

      const result = await extractHeaderElement(
        "https://en-americas-support.nintendo.com/app/answers/detail/a_id/1234",
      );

      expect(result).not.toBeNull();
      expect(result?.imageUrl).toBe(
        "https://upload.wikimedia.org/wikipedia/commons/0/0d/Nintendo.svg",
      );
    });

    it("re-throws ArticleSkipError when encountered in strategy", async () => {
      const extractor = new HeaderElementExtractor();
      const mockStrategy = extractor.strategies[2]; // GenericImageStrategy
      vi.spyOn(mockStrategy, "canHandle").mockReturnValue(true);
      vi.spyOn(mockStrategy, "create").mockRejectedValue(
        new ArticleSkipError("Article skipped due to 404", 404),
      );

      await expect(extractor.extractHeaderElement("https://example.com/notfound")).rejects.toThrow(
        ArticleSkipError,
      );
    });

    it("returns null if all strategies fail or return null", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Not found", { status: 404 }));

      const extractor = new HeaderElementExtractor();
      // Disable network calls returning images
      for (const s of extractor.strategies) {
        vi.spyOn(s, "create").mockResolvedValue(null);
      }

      const result = await extractor.extractHeaderElement("https://example.com/no-image");
      expect(result).toBeNull();
    });
  });
});
