import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_HTML_BYTES, MAX_REDIRECTS } from "../http/fetcher";
import { countingStream, settledAfterFakeTime, stallingBodyResponse } from "../http/test-support";
import {
  extractImages,
  getOverrideImageUrl,
  ImageExtractor,
  PAGE_FETCH_TIMEOUT_MS,
} from "./extractor";
import { youtubeIdFrom } from "../embeds/youtube-url";
import { isTwitterUrl } from "../extract/format";
import {
  DirectImageStrategy,
  extractTweetId,
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
      expect(youtubeIdFrom("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
      expect(youtubeIdFrom("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
      expect(youtubeIdFrom("https://youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");

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

/**
 * `fetchAndParsePage()` is private, so these drive it through
 * `extractImageFromUrl()`. A plain article URL is handled by none of the first
 * three strategies, and the HTML served below carries no `og:image` and no
 * `<img>`, so the page fetch is the only fetch in the run -- which is what
 * makes the call counts below meaningful.
 */
describe("ImageExtractor.fetchAndParsePage bounds", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stops reading the page at the byte cap instead of buffering the whole body", async () => {
    // `res.text()` had no cap at all, and the URL comes off a source page, so
    // its size was the source's choice.
    const { stream, state } = countingStream(20);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(stream, { status: 200, headers: { "content-type": "text/html" } }),
    );

    expect(
      await new ImageExtractor().extractImageFromUrl("https://example.com/article"),
    ).toBeNull();
    expect(state.cancelled).toBe(true);
    // The cap plus the chunk that trips it plus the stream's own read-ahead --
    // short of the 20 on offer.
    expect(state.pulls).toBeLessThanOrEqual(MAX_HTML_BYTES / (1024 * 1024) + 2);
  });

  it("keeps a deadline over the body, not only the headers", async () => {
    // The timer used to be cleared on the line above `res.text()`, so a server
    // that sent headers and then stalled held this call -- and its worker
    // loop -- open forever. Fake time is what makes the 30s deadline testable.
    vi.spyOn(globalThis, "fetch").mockImplementation(((_url: string, init: RequestInit) =>
      Promise.resolve(stallingBodyResponse(init.signal))) as unknown as typeof fetch);
    vi.useFakeTimers();

    const outcome = await settledAfterFakeTime(
      new ImageExtractor().extractImageFromUrl("https://example.com/article"),
      PAGE_FETCH_TIMEOUT_MS,
      (ms) => vi.advanceTimersByTimeAsync(ms),
    );

    expect(outcome).toBe("settled");
  });

  it("follows page redirects itself, bounded by MAX_REDIRECTS", async () => {
    const inits: RequestInit[] = [];
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      inits.push(init);
      return Promise.resolve(
        url.endsWith("/article")
          ? new Response(null, { status: 302, headers: { location: "/hop" } })
          : new Response("<html><head><title>t</title></head><body></body></html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            }),
      );
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    await new ImageExtractor().extractImageFromUrl("https://example.com/article");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(inits[0]).toMatchObject({ redirect: "manual" });
  });

  it("refuses an unbounded page redirect chain", async () => {
    // `redirect: "follow"` handed the whole budget to undici with no ceiling
    // of our own, on a URL taken from a source page.
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: "/loop" } })),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    expect(await new ImageExtractor().extractImageFromUrl("https://example.com/loop")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });
});
