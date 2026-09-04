import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FETCH_BYTES as HTTP_MAX_FETCH_BYTES, MAX_REDIRECTS } from "../http/fetcher";
import {
  fetchImageOutcome,
  fetchSingleImage,
  getImageHeaders,
  IMAGE_USER_AGENT,
  isImageContentType,
  MAX_IMAGE_FETCH_BYTES,
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

  // 7d: the two fetchers used to export `USER_AGENT` and `MAX_FETCH_BYTES`
  // each, with different values -- an import auto-completed from the wrong
  // module was a silent 32-fold change in the byte cap that nothing could
  // typecheck against. The names are disjoint now, so such an import does
  // not resolve at all.
  describe("constants", () => {
    it("does not share a name with the http fetcher's differing constants", () => {
      expect(MAX_IMAGE_FETCH_BYTES).toBe(64 * 1024 * 1024);
      expect(MAX_IMAGE_FETCH_BYTES).not.toBe(HTTP_MAX_FETCH_BYTES);
      expect(IMAGE_USER_AGENT).toContain("Chrome");
    });
  });

  describe("fetchImageOutcome resource bounds", () => {
    /**
     * A stream that yields `chunkCount` one-megabyte chunks lazily, counting
     * how many were pulled and whether the consumer cancelled.
     */
    function countingStream(chunkCount: number) {
      const state = { pulls: 0, cancelled: false };
      const chunk = new Uint8Array(1024 * 1024);
      const stream = new ReadableStream({
        pull(controller) {
          if (state.pulls >= chunkCount) {
            controller.close();
            return;
          }
          state.pulls += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          state.cancelled = true;
        },
      });
      return { stream, state };
    }

    it("stops reading at the byte cap instead of buffering the whole body", async () => {
      // No Content-Length: a server free to ignore its own declaration is
      // exactly the case a declared-size check cannot cover. Buffering first
      // and checking afterwards costs 64 MB of RSS per in-flight image, and
      // feeds.concurrency (4) x WORKER_CONCURRENCY (4) of those is ~1 GB.
      const { stream, state } = countingStream(70);
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(stream, { status: 200, headers: { "Content-Type": "image/gif" } }),
      );

      expect(await fetchImageOutcome("https://example.com/endless.gif")).toBeNull();
      expect(state.cancelled).toBe(true);
      // 64 pulls to reach the cap, plus the one that trips it and the
      // stream's own one-chunk read-ahead. Far short of the 70 on offer.
      expect(state.pulls).toBeLessThanOrEqual(MAX_IMAGE_FETCH_BYTES / (1024 * 1024) + 2);
    });

    it("follows redirects itself, bounded by MAX_REDIRECTS", async () => {
      const png = await sharp({
        create: { width: 50, height: 50, channels: 3, background: { r: 9, g: 9, b: 9 } },
      })
        .png()
        .toBuffer();

      const inits: RequestInit[] = [];
      const fetchMock = vi.fn((url: string, init: RequestInit) => {
        inits.push(init);
        return Promise.resolve(
          url.endsWith("/redirected.png")
            ? new Response(null, {
                status: 302,
                headers: { location: "https://cdn.example.com/hop.png" },
              })
            : url.endsWith("/hop.png")
              ? new Response(null, {
                  status: 302,
                  headers: { location: "https://cdn.example.com/final.png" },
                })
              : new Response(new Uint8Array(png), {
                  status: 200,
                  headers: { "Content-Type": "image/png" },
                }),
        );
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

      const result = await fetchImageOutcome("https://example.com/redirected.png");
      expect(result).not.toBeNull();
      expect(result).not.toBe(NON_IMAGE_RESPONSE);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(inits[0]).toMatchObject({ redirect: "manual" });
    });

    it("refuses an unbounded redirect chain", async () => {
      // Image URLs come from the source page, so they are attacker-chosen;
      // `redirect: "follow"` handed the redirect budget to undici with no
      // ceiling of our own, where fetchBinary() has bounded hops.
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://example.com/loop.png" },
          }),
        ),
      );
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

      expect(await fetchImageOutcome("https://example.com/loop.png")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
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
