import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  compressImage,
  MAX_DECODE_PIXELS,
  MAX_MEASURE_PIXELS,
  SHARP_TIMEOUT_SECONDS,
} from "./compression";

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

  // 7c: a decompression bomb -- tiny on the wire, enormous in memory. These
  // bytes come from an arbitrary remote host by way of a source article's
  // markup, so the byte cap the fetcher applies bounds neither the decoded
  // raster nor the time spent producing it.
  it("refuses an image whose pixel count exceeds the input limit", async () => {
    // 36 MP of flat colour: ~1 MB of PNG, ~108 MB decoded. Well past
    // MAX_DECODE_PIXELS, and well under any byte cap on the fetch.
    const bomb = await sharp({
      create: {
        width: 6000,
        height: 6000,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .png({ compressionLevel: 1 })
      .toBuffer();

    expect(6000 * 6000).toBeGreaterThan(MAX_DECODE_PIXELS);
    expect(bomb.length).toBeGreaterThan(5000);
    expect(bomb.length).toBeLessThan(64 * 1024 * 1024);

    // Without `limitInputPixels` sharp resizes this happily -- that is exactly
    // what makes it a bomb, and what this assertion is the absence of.
    expect(await compressImage(bomb, "image/png", false)).toBeNull();
  });

  // The wall-clock half of the same pair cannot be exercised in-process (it
  // would take a genuinely pathological image and ten real seconds), so it is
  // pinned to the source instead: both limits must be applied to every sharp
  // pipeline fed caller-supplied bytes, inside the module rather than at a
  // call site that can forget them -- the rule `processAvatar()` states.
  //
  // The scan matches a call by *shape* rather than by the argument's spelling,
  // and it has now been widened twice, each time because a real unguarded call
  // was sitting outside it. Its first version looked only at
  // `compression.ts` and only for the literal `sharp(imageData`, so it could
  // not see `validateImageDataWithSharp()`'s bare `sharp(imageData)` one file
  // over -- the first sharp call every fetched image hits -- and a new
  // unguarded call under any other variable name would have been invisible to
  // it too. Its second version fixed both of those and still scanned only this
  // *directory*, which is how `storeLogo()` in `src/lib/feeds/logo.ts` kept a
  // completely unprotected `sharp(backgroundRemoved).resize(128, 128)` on
  // remote, site-declared icon bytes -- sharp's 268 MP default, on the
  // worker-executed `feed.logo` path. A tripwire is only ever as wide as its
  // file list, so the file list is the part to distrust.
  //
  // It accepts *either* named pixel limit, because there are two: a call that
  // only measures reads `MAX_MEASURE_PIXELS` and one that decodes reads
  // `MAX_DECODE_PIXELS` (see both constants). What is enforced is that a
  // pixel limit and a timeout are applied at all, never which number -- the
  // numbers themselves are pinned separately at the bottom of this test.
  it("applies both sharp resource limits to every call fed caller-supplied bytes", () => {
    /** Comments name these calls in prose; only real code counts. */
    function stripComments(source: string): string {
      return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    }

    const files = [
      "src/lib/aggregators/images/compression.ts",
      "src/lib/aggregators/images/fetcher.ts",
      "src/lib/feeds/logo.ts",
    ];
    for (const file of files) {
      const code = stripComments(fs.readFileSync(path.join(process.cwd(), file), "utf8"));

      // Any `sharp(<identifier>` -- a buffer, whatever it is called. A
      // `sharp({ create: ... })` literal builds an image from scratch and has
      // no caller-supplied bytes to bound, so it is not matched.
      const calls = [...code.matchAll(/\bsharp\(\s*[A-Za-z_$][\w$]*[^)]*\)/g)];
      expect(calls.length, `${file} has no sharp() call to check`).toBeGreaterThan(0);

      for (const call of calls) {
        expect(call[0], `unguarded sharp() call in ${file}`).toMatch(
          /limitInputPixels: MAX_(DECODE|MEASURE)_PIXELS/,
        );
        const tail = code.slice(call.index + call[0].length, call.index + call[0].length + 120);
        expect(tail, `sharp() call in ${file} without a timeout`).toMatch(
          /^\s*\.timeout\(\{\s*seconds: SHARP_TIMEOUT_SECONDS,?\s*\}\)/,
        );
      }
    }

    expect(SHARP_TIMEOUT_SECONDS).toBe(10);
    expect(MAX_DECODE_PIXELS).toBe(25_000_000);
    expect(MAX_MEASURE_PIXELS).toBe(1_000_000_000);
  });
});
