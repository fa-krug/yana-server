import { describe, expect, it } from "vitest";

import { DEFAULT_TAG_COLOR, TAG_COLOR_KEYS, hexForTagColor, isTagColorKey } from "./colors";

describe("the tag color palette", () => {
  it("has twelve distinct keys", () => {
    expect(TAG_COLOR_KEYS.length).toBe(12);
    expect(new Set(TAG_COLOR_KEYS).size).toBe(12);
  });

  it("includes the default among the keys", () => {
    expect(TAG_COLOR_KEYS).toContain(DEFAULT_TAG_COLOR);
  });

  it("resolves every key to a distinct, well-formed color", () => {
    const colors = TAG_COLOR_KEYS.map((key) => hexForTagColor(key));
    expect(new Set(colors).size).toBe(TAG_COLOR_KEYS.length);
    for (const color of colors) {
      expect(color).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
    }
  });

  it("is stable for the same key", () => {
    expect(hexForTagColor("blue")).toBe(hexForTagColor("blue"));
  });
});

describe("isTagColorKey", () => {
  it("accepts every palette key", () => {
    for (const key of TAG_COLOR_KEYS) expect(isTagColorKey(key)).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isTagColorKey("mauve")).toBe(false);
    expect(isTagColorKey("")).toBe(false);
  });
});

describe("hexForTagColor", () => {
  it("falls back to the default color for an unrecognized value", () => {
    expect(hexForTagColor("mauve")).toBe(hexForTagColor(DEFAULT_TAG_COLOR));
  });
});
