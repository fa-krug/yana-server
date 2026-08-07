import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { compressImage } from "./compression";

describe("compressImage", () => {
  it("skips compression for small images (<5KB) while measuring dimensions", async () => {
    // 10x10 small PNG
    const smallPng = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    expect(smallPng.length).toBeLessThan(5000);

    const result = await compressImage(smallPng, "image/png", false);
    expect(result).not.toBeNull();
    expect(result?.contentType).toBe("image/png");
    expect(result?.size).toBe(smallPng.length);
    expect(result?.width).toBe(10);
    expect(result?.height).toBe(10);
    expect(result?.data).toBe(smallPng);
  });

  it("resizes normal images to max 600x600 and converts to webp", async () => {
    // 1200x900 image with raw uncompressed pixels to exceed 5KB
    const largeJpeg = await sharp({
      create: {
        width: 1200,
        height: 900,
        channels: 3,
        background: { r: 100, g: 150, b: 200 },
      },
    })
      .jpeg({ quality: 100, progressive: false })
      .toBuffer();

    expect(largeJpeg.length).toBeGreaterThan(5000);

    const result = await compressImage(largeJpeg, "image/jpeg", false);
    expect(result).not.toBeNull();
    expect(result?.contentType).toBe("image/webp");
    expect(result?.width).toBe(600);
    expect(result?.height).toBe(450);
  });

  it("resizes header images to max 1200x1200", async () => {
    const largeJpeg = await sharp({
      create: {
        width: 1600,
        height: 1200,
        channels: 3,
        background: { r: 120, g: 180, b: 240 },
      },
    })
      .jpeg({ quality: 100 })
      .toBuffer();

    expect(largeJpeg.length).toBeGreaterThan(5000);

    const result = await compressImage(largeJpeg, "image/jpeg", true);
    expect(result).not.toBeNull();
    expect(result?.contentType).toBe("image/webp");
    expect(result?.width).toBe(1200);
    expect(result?.height).toBe(900);
  });

  it("does not upscale images smaller than max dimensions", async () => {
    // 400x300 PNG padded to > 5KB
    const rawPixels = Buffer.alloc(400 * 300 * 3, 128);
    const png = await sharp(rawPixels, {
      raw: { width: 400, height: 300, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    expect(png.length).toBeGreaterThan(5000);

    const result = await compressImage(png, "image/png", false);
    expect(result).not.toBeNull();
    expect(result?.width).toBe(400);
    expect(result?.height).toBe(300);
  });

  it("uses explicit maxDimensions over the isHeader defaults", async () => {
    const tallJpeg = await sharp({
      create: {
        width: 1000,
        height: 3000,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .jpeg({ quality: 100 })
      .toBuffer();

    expect(tallJpeg.length).toBeGreaterThan(5000);

    const result = await compressImage(tallJpeg, "image/jpeg", false, {
      width: 1600,
      height: 4800,
    });
    expect(result).not.toBeNull();
    expect(result?.contentType).toBe("image/webp");
    expect(result?.width).toBe(1000);
    expect(result?.height).toBe(3000);
  });

  it("returns null for invalid/corrupt image bytes > 5KB", async () => {
    const invalid = Buffer.alloc(6000, 65); // 6KB of ASCII 'A'
    const result = await compressImage(invalid, "image/png", false);
    expect(result).toBeNull();
  });
});
