import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { pickBestIcon, removeWhiteBackground } from "./logo";

async function solidWhitePng() {
  return await sharp({
    create: {
      width: 10,
      height: 10,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  }).png().toBuffer();
}

async function transparentPng() {
  return await sharp({
    create: {
      width: 10,
      height: 10,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).png().toBuffer();
}

async function hasTransparency(buffer: Buffer) {
  const { data } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

describe("pickBestIcon", () => {
  it("prefers a larger declared size", () => {
    const chosen = pickBestIcon([
      { href: "/small.png", sizes: "16x16", rel: "icon" },
      { href: "/large.png", sizes: "180x180", rel: "apple-touch-icon" },
    ]);
    expect(chosen?.href).toBe("/large.png");
  });

  it("treats sizes=any as best", () => {
    const chosen = pickBestIcon([
      { href: "/png.png", sizes: "48x48", rel: "icon" },
      { href: "/svg.svg", sizes: "any", rel: "icon" },
    ]);
    expect(chosen?.href).toBe("/svg.svg");
  });

  it("returns null when there is nothing to pick", () => {
    expect(pickBestIcon([])).toBeNull();
  });
});

describe("removeWhiteBackground", () => {
  it("makes near-white pixels transparent", async () => {
    const output = await removeWhiteBackground(await solidWhitePng());
    expect(await hasTransparency(output)).toBe(true);
  });

  it("leaves an image that is already transparent alone", async () => {
    const input = await transparentPng();
    expect(await removeWhiteBackground(input)).toEqual(input);
  });
});
