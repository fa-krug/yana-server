import { describe, it, expect } from "vitest";
import { dailymotionIdFrom, thumbnailUrlFor } from "./dailymotion";

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
