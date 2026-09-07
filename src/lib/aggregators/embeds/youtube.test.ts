import { describe, it, expect, vi, afterEach } from "vitest";
import { youtubeIdFrom, thumbnailUrlFor, isYoutubeUrl, localizeThumbnail } from "./youtube";
import { storeImageRefFromUrl } from "../images/store";

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

describe("localizeThumbnail failure visibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a warning naming the video id when every quality fetch fails, instead of failing silently", async () => {
    vi.mocked(storeImageRefFromUrl).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ref = await localizeThumbnail("deadbeef123");

    expect(ref).toBe("");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("deadbeef123"));
  });
});
