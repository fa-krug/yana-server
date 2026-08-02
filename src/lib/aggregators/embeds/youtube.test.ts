import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  youtubeIdFrom,
  thumbnailUrlFor,
  isYoutubeUrl,
  detectYoutube,
  convertYoutube,
} from "./youtube";
import * as cheerio from "cheerio";
import { clearEmbedProviders } from "./registry";

// Mock image store to avoid actual network calls
vi.mock("../images/store", () => ({
  storeImageRefFromUrl: vi.fn(async (url: string) => {
    if (url.includes("maxresdefault")) return "yana-img://abc123hash";
    if (url.includes("hqdefault")) return "yana-img://fallbackhash";
    return null;
  }),
}));

describe("youtubeIdFrom", () => {
  const cases: [string, string | null][] = [
    // Standard watch URL
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Short URL
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Embed URL
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Nocookie embed
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // /v/ URL
    ["https://www.youtube.com/v/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Shorts
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Live
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Watch URL with extra params
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120", "dQw4w9WgXcQ"],
    // Mobile URL
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Invalid: empty
    ["", null],
    // Invalid: not a YouTube URL
    ["https://example.com/watch?v=dQw4w9WgXcQ", null],
    // Invalid: no ID
    ["https://www.youtube.com/", null],
    // Partial match: regex stops at space/special chars, extracts 'bad'
    ["https://www.youtube.com/watch?v=bad id!", "bad"],
  ];

  it.each(cases)("youtubeIdFrom(%s) → %s", (input, expected) => {
    expect(youtubeIdFrom(input)).toBe(expected);
  });
});

describe("thumbnailUrlFor", () => {
  it("returns maxresdefault URL by default", () => {
    expect(thumbnailUrlFor("abc123")).toBe("https://img.youtube.com/vi/abc123/maxresdefault.jpg");
  });

  it("returns the specified quality", () => {
    expect(thumbnailUrlFor("abc123", "hqdefault")).toBe(
      "https://img.youtube.com/vi/abc123/hqdefault.jpg",
    );
  });
});

describe("isYoutubeUrl", () => {
  it("detects youtube.com", () => {
    expect(isYoutubeUrl("https://www.youtube.com/watch?v=abc")).toBe(true);
  });
  it("detects youtu.be", () => {
    expect(isYoutubeUrl("https://youtu.be/abc")).toBe(true);
  });
  it("rejects non-YouTube", () => {
    expect(isYoutubeUrl("https://example.com")).toBe(false);
  });
  it("rejects empty", () => {
    expect(isYoutubeUrl("")).toBe(false);
  });
});

describe("detectYoutube", () => {
  it("detects element with youtube-embed class", () => {
    const $ = cheerio.load(
      '<div class="youtube-embed" data-embed="https://www.youtube.com/embed/abc123"><a href="https://www.youtube.com/watch?v=abc123">Watch</a></div>',
    );
    const el = $("div").get(0)!;
    expect(detectYoutube(el, $)).toBe(true);
  });

  it("detects element with data-embed YouTube URL", () => {
    const $ = cheerio.load('<div data-embed="https://www.youtube.com/embed/abc123"></div>');
    const el = $("div").get(0)!;
    expect(detectYoutube(el, $)).toBe(true);
  });

  it("detects element with YouTube anchor", () => {
    const $ = cheerio.load(
      '<div><a href="https://www.youtube.com/watch?v=abc1234abcd">Watch</a></div>',
    );
    const el = $("div").get(0)!;
    expect(detectYoutube(el, $)).toBe(true);
  });

  it("rejects element without YouTube markers", () => {
    const $ = cheerio.load('<div><a href="https://example.com">Link</a></div>');
    const el = $("div").get(0)!;
    expect(detectYoutube(el, $)).toBe(false);
  });
});

describe("convertYoutube", () => {
  beforeEach(() => {
    clearEmbedProviders();
    // Re-import to re-register
    vi.resetModules();
  });

  it("converts a YouTube embed with canonical URL", async () => {
    const $ = cheerio.load(
      '<div class="youtube-embed" data-embed="https://www.youtube.com/embed/dQw4w9WgXcQ"><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">Watch</a></div>',
    );
    const el = $("div").get(0)!;
    const result = await convertYoutube(el, $, {});
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("youtube");
    expect(result!.externalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    // Thumbnail should be localized
    expect(result!.thumbnailRef).toMatch(/^yana-img:\/\//);
  });

  it("returns null for element without video ID", async () => {
    const $ = cheerio.load('<div class="youtube-embed"></div>');
    const el = $("div").get(0)!;
    const result = await convertYoutube(el, $, {});
    expect(result).toBeNull();
  });

  it("extracts ID from youtu.be anchor", async () => {
    const $ = cheerio.load('<div><a href="https://youtu.be/dQw4w9WgXcQ">Watch</a></div>');
    const el = $("div").get(0)!;
    const result = await convertYoutube(el, $, {});
    expect(result).not.toBeNull();
    expect(result!.externalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("extracts ID from iframe src", async () => {
    const $ = cheerio.load(
      '<div><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe></div>',
    );
    const el = $("div").get(0)!;
    const result = await convertYoutube(el, $, {});
    expect(result).not.toBeNull();
    expect(result!.externalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});
