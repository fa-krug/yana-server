import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractImages, getOverrideImageUrl, ImageExtractor } from "./extractor";
import {
  DirectImageStrategy,
  extractTweetId,
  extractYoutubeVideoId,
  isTwitterUrl,
  TwitterImageStrategy,
  YouTubeThumbnailStrategy,
} from "./strategies";

describe("Image Extraction Strategies", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("DirectImageStrategy", () => {
    it("handles direct image URLs", () => {
      const strategy = new DirectImageStrategy();
      expect(strategy.canHandle({ url: "https://example.com/photo.jpg" })).toBe(true);
      expect(strategy.canHandle({ url: "https://example.com/graphic.png" })).toBe(true);
      expect(strategy.canHandle({ url: "https://example.com/article.html" })).toBe(false);
    });
  });

  describe("YouTubeThumbnailStrategy", () => {
    it("extracts YouTube video IDs and handles YouTube URLs", () => {
      expect(extractYoutubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
        "dQw4w9WgXcQ",
      );
      expect(extractYoutubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
      expect(extractYoutubeVideoId("https://youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");

      const strategy = new YouTubeThumbnailStrategy();
      expect(strategy.canHandle({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })).toBe(true);
      expect(strategy.canHandle({ url: "https://example.com/other" })).toBe(false);
    });
  });

  describe("TwitterImageStrategy", () => {
    it("identifies Twitter/X URLs and tweet IDs", () => {
      expect(isTwitterUrl("https://twitter.com/jack/status/20")).toBe(true);
      expect(isTwitterUrl("https://x.com/user/status/12345")).toBe(true);
      expect(extractTweetId("https://twitter.com/jack/status/20")).toBe("20");

      const strategy = new TwitterImageStrategy();
      expect(strategy.canHandle({ url: "https://x.com/user/status/12345" })).toBe(true);
      expect(strategy.canHandle({ url: "https://example.com" })).toBe(false);
    });
  });

  describe("Domain Overrides", () => {
    it("resolves Nintendo support URL to Wikimedia Nintendo logo", () => {
      const url = "https://en-americas-support.nintendo.com/app/answers/detail/a_id/1234";
      const override = getOverrideImageUrl(url);
      expect(override).toBe("https://upload.wikimedia.org/wikipedia/commons/0/0d/Nintendo.svg");
    });
  });

  describe("ImageExtractor", () => {
    it("extracts direct image using DirectImageStrategy", async () => {
      const validPng = await sharp({
        create: { width: 300, height: 300, channels: 3, background: { r: 100, g: 100, b: 100 } },
      })
        .png()
        .toBuffer();

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(new Uint8Array(validPng), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );

      const extractor = new ImageExtractor();
      const result = await extractor.extractImageFromUrl("https://example.com/photo.png");
      expect(result).not.toBeNull();
      expect(result?.imageUrl).toBe("https://example.com/photo.png");
      expect(result?.contentType).toBe("image/png");
    });

    it("falls back to MetaTagImageStrategy when page HTML has og:image", async () => {
      const pageHtml = `
        <html>
          <head>
            <meta property="og:image" content="https://example.com/og-banner.jpg" />
          </head>
        </html>
      `;

      const validJpeg = await sharp({
        create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 50, b: 50 } },
      })
        .jpeg()
        .toBuffer();

      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(pageHtml, { status: 200, headers: { "Content-Type": "text/html" } }),
        )
        .mockResolvedValueOnce(
          new Response(new Uint8Array(validJpeg), {
            status: 200,
            headers: { "Content-Type": "image/jpeg" },
          }),
        );

      const result = await extractImages("https://example.com/news/article-1");
      expect(result).not.toBeNull();
      expect(result?.imageUrl).toBe("https://example.com/og-banner.jpg");
    });
  });
});
