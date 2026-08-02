import { describe, it, expect, vi } from "vitest";
import { dailymotionIdFrom, thumbnailUrlFor, detectDailymotion, convertDailymotion } from "./dailymotion";
import * as cheerio from "cheerio";

vi.mock("../images/store", () => ({
  storeImageRefFromUrl: vi.fn(async () => "yana-img://dmhash123"),
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

describe("detectDailymotion", () => {
  it("detects dailymotion-embed class", () => {
    const $ = cheerio.load('<div class="dailymotion-embed" data-embed="https://www.dailymotion.com/embed/video/x8abc12"></div>');
    expect(detectDailymotion($("div").get(0)!, $)).toBe(true);
  });

  it("detects data-embed with Dailymotion URL", () => {
    const $ = cheerio.load('<div data-embed="https://www.dailymotion.com/embed/video/x8abc12"></div>');
    expect(detectDailymotion($("div").get(0)!, $)).toBe(true);
  });

  it("rejects non-Dailymotion element", () => {
    const $ = cheerio.load('<div><a href="https://example.com">Link</a></div>');
    expect(detectDailymotion($("div").get(0)!, $)).toBe(false);
  });
});

describe("convertDailymotion", () => {
  it("converts a Dailymotion embed with canonical URL", async () => {
    const $ = cheerio.load('<div class="dailymotion-embed" data-embed="https://www.dailymotion.com/embed/video/x8abc12"></div>');
    const result = await convertDailymotion($("div").get(0)!, $, {});
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("dailymotion");
    expect(result!.externalUrl).toBe("https://www.dailymotion.com/video/x8abc12");
    expect(result!.thumbnailRef).toMatch(/^yana-img:\/\//);
  });

  it("returns null without a video ID", async () => {
    const $ = cheerio.load('<div class="dailymotion-embed"></div>');
    const result = await convertDailymotion($("div").get(0)!, $, {});
    expect(result).toBeNull();
  });
});
