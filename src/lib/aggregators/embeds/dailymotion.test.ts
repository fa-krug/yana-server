import { afterEach, describe, it, expect, vi } from "vitest";
import { dailymotionIdFrom, localizeThumbnail, thumbnailUrlFor } from "./dailymotion";
import { storeImageRefFromUrl } from "../images/store";

// Mock the image store to avoid actual network calls, as youtube.test.ts does.
vi.mock("../images/store", () => ({
  storeImageRefFromUrl: vi.fn(async () => "yana-img://abc123hash"),
}));

describe("dailymotionIdFrom", () => {
  const cases: [string, string | null][] = [
    ["https://www.dailymotion.com/video/x8abc12", "x8abc12"],
    ["https://www.dailymotion.com/embed/video/x8abc12", "x8abc12"],
    ["https://dai.ly/x8abc12", "x8abc12"],
    ["", null],
    ["https://example.com/video/x8abc12", null],
  ];

  it.each(cases)("dailymotionIdFrom(%s) → %s", (input, expected) => {
    expect(dailymotionIdFrom(input)).toBe(expected);
  });
});

describe("thumbnailUrlFor", () => {
  it("returns Dailymotion thumbnail URL", () => {
    expect(thumbnailUrlFor("x8abc12")).toBe("https://www.dailymotion.com/thumbnail/video/x8abc12");
  });
});

describe("localizeThumbnail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the stored ref on success", async () => {
    expect(await localizeThumbnail("x8abc12")).toBe("yana-img://abc123hash");
  });

  it("logs a warning naming the video id when the fetch fails, instead of failing silently", async () => {
    // `youtube.ts`'s twin already warns here and explains why the silence was
    // the bug; this is the same function for the same failure.
    vi.mocked(storeImageRefFromUrl).mockResolvedValueOnce(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ref = await localizeThumbnail("x8deadbeef");

    expect(ref).toBe("");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("x8deadbeef"));
  });
});
