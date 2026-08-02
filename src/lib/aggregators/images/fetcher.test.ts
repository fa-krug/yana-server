import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchImageOutcome,
  fetchSingleImage,
  getImageHeaders,
  isImageContentType,
  NON_IMAGE_RESPONSE,
} from "./fetcher";

describe("fetcher utilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isImageContentType", () => {
    it("identifies valid image mime types", () => {
      expect(isImageContentType("image/jpeg")).toBe(true);
      expect(isImageContentType("image/png; charset=utf-8")).toBe(true);
      expect(isImageContentType("image/webp")).toBe(true);
      expect(isImageContentType("text/html")).toBe(false);
      expect(isImageContentType("application/json")).toBe(false);
      expect(isImageContentType(null)).toBe(false);
    });
  });

  describe("getImageHeaders", () => {
    it("includes user agent and referer if URL provided", () => {
      const headers = getImageHeaders("https://example.com/article/1");
      expect(headers["User-Agent"]).toContain("Mozilla");
      expect(headers["Referer"]).toBe("https://example.com");
    });
  });

  describe("fetchImageOutcome", () => {
    it("returns FetchedImageResult on successful image fetch", async () => {
      const validPng = await sharp({
        create: {
          width: 200,
          height: 200,
          channels: 4,
          background: { r: 0, g: 255, b: 0, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

      expect(validPng.length).toBeGreaterThan(100);

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(new Uint8Array(validPng), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );

      const result = await fetchImageOutcome("https://example.com/image.png");
      expect(result).not.toBeNull();
      expect(result).not.toBe(NON_IMAGE_RESPONSE);
      if (typeof result === "object" && result !== null) {
        expect(result.contentType).toBe("image/png");
        expect(result.imageData).toEqual(validPng);
      }
    });

    it("returns NON_IMAGE_RESPONSE for non-image Content-Type", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("<html>Not an image</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );

      const result = await fetchImageOutcome("https://example.com/not-an-image");
      expect(result).toBe(NON_IMAGE_RESPONSE);
    });

    it("returns NON_IMAGE_RESPONSE for image body < 100 bytes", async () => {
      const tinyBuffer = Buffer.alloc(50, 0);
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(new Uint8Array(tinyBuffer), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );

      const result = await fetchImageOutcome("https://example.com/tiny.png");
      expect(result).toBe(NON_IMAGE_RESPONSE);
    });

    it("returns NON_IMAGE_RESPONSE for undecodable bytes", async () => {
      const corruptData = Buffer.alloc(200, 65);
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(new Uint8Array(corruptData), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );

      const result = await fetchImageOutcome("https://example.com/corrupt.png");
      expect(result).toBe(NON_IMAGE_RESPONSE);
    });

    it("returns null for HTTP 404/500 error status", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 404 }));

      const result = await fetchImageOutcome("https://example.com/404.png");
      expect(result).toBeNull();
    });

    it("returns null for network/timeout exceptions", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network failure"));

      const result = await fetchImageOutcome("https://example.com/error.png");
      expect(result).toBeNull();
    });

    it("returns null when Content-Length exceeds 64 MB cap", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            "Content-Type": "image/gif",
            "Content-Length": String(70 * 1024 * 1024),
          },
        }),
      );

      const result = await fetchImageOutcome("https://example.com/huge.gif");
      expect(result).toBeNull();
    });
  });

  describe("fetchSingleImage", () => {
    it("collapses NON_IMAGE_RESPONSE to null", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("<html>Html</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );

      const result = await fetchSingleImage("https://example.com/html");
      expect(result).toBeNull();
    });
  });
});
