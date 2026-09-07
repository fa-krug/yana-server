import * as cheerio from "cheerio";
import sharp from "sharp";
import { eq } from "drizzle-orm";

import { MAX_DECODE_PIXELS, SHARP_TIMEOUT_SECONDS } from "../aggregators/images/compression";
import { storeImageBytes } from "../aggregators/images/store";
import { writeTransaction } from "../db/client";
import { feeds } from "../db/schema";

/**
 * Every sharp pipeline in this module goes through here, so no call site can
 * omit either resource limit -- the same helper `compression.ts` has, and for
 * the same reason `processAvatar()` states: a caller cannot forget what it
 * never had to remember.
 *
 * **This module needed it.** `storeLogo()`'s resize ran on a bare `sharp()`
 * with sharp's 268 MP default -- which `CLAUDE.md` correctly calls no
 * protection -- on bytes fetched by `fetchIconBytes()` from a URL a site's own
 * `<link rel="icon">` or web manifest declared, under nothing but a 2 MB byte
 * cap. A ~1 MB flat 36 MP PNG decodes to hundreds of megabytes, on the
 * worker-executed `feed.logo` path where `WORKER_CONCURRENCY` peers are
 * running too. `removeWhiteBackground()` above it was only *accidentally*
 * safe: its `MAX_FILL_PIXELS` bail returns before the flood fill decodes
 * anything -- and returning the full-size original is precisely what handed
 * `storeLogo()` the unbounded buffer.
 *
 * The limits went unnoticed because the tripwire in
 * `../aggregators/images/compression.test.ts` scanned only that directory.
 * It scans this file now.
 *
 * The decode limit is right here rather than `MAX_MEASURE_PIXELS`: this module
 * really does decode. What a refusal costs is a feed with no logo -- the
 * `feed.logo` handler already treats `null` as "keep none", and rediscovery is
 * one job away -- never article content.
 */
function sharpInput(input: Buffer, options?: sharp.SharpOptions) {
  return sharp(input, { ...options, limitInputPixels: MAX_DECODE_PIXELS }).timeout({
    seconds: SHARP_TIMEOUT_SECONDS,
  });
}

const WHITE_THRESHOLD = 240;
const BORDER_WHITE_FRACTION = 0.85;
const MAX_FILL_PIXELS = 512 * 512;

export function pickBestIcon(icons: { href: string; sizes?: string; rel: string }[]) {
  let bestIcon = null;
  let bestScore = -1;

  for (const icon of icons) {
    if (!icon.rel || !icon.href) continue;
    const rels = icon.rel.toLowerCase().split(/\s+/);
    if (!rels.includes("icon") && !rels.includes("apple-touch-icon")) {
      continue;
    }

    const isApple = rels.includes("apple-touch-icon");
    let area = 0;

    if (icon.sizes && icon.sizes.toLowerCase() === "any") {
      area = Infinity;
    } else if (icon.sizes) {
      const match = icon.sizes.match(/(\d+)\s*[xX]\s*(\d+)/);
      if (match) {
        area = parseInt(match[1]) * parseInt(match[2]);
      }
    }

    const score = area + (isApple ? 1e12 : 0);

    if (score > bestScore) {
      bestScore = score;
      bestIcon = icon;
    }
  }

  return bestIcon;
}

export async function removeWhiteBackground(buffer: Buffer): Promise<Buffer> {
  try {
    const image = sharpInput(buffer);
    const metadata = await image.metadata();

    if (!metadata.width || !metadata.height || metadata.width < 2 || metadata.height < 2) {
      return buffer;
    }

    if (metadata.width * metadata.height > MAX_FILL_PIXELS) {
      return buffer;
    }

    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;

    const isWhite = (idx: number) => {
      return (
        data[idx] >= WHITE_THRESHOLD &&
        data[idx + 1] >= WHITE_THRESHOLD &&
        data[idx + 2] >= WHITE_THRESHOLD
      );
    };

    let whiteBorderCount = 0;
    let totalBorderCount = 0;

    const borderPixels: { x: number; y: number }[] = [];

    for (let x = 0; x < width; x++) {
      borderPixels.push({ x, y: 0 });
      borderPixels.push({ x, y: height - 1 });
    }
    for (let y = 1; y < height - 1; y++) {
      borderPixels.push({ x: 0, y });
      borderPixels.push({ x: width - 1, y });
    }

    const startQueue: { x: number; y: number }[] = [];

    for (const p of borderPixels) {
      totalBorderCount++;
      const idx = (p.y * width + p.x) * 4;
      if (isWhite(idx)) {
        whiteBorderCount++;
        startQueue.push(p);
      }
    }

    if (whiteBorderCount / totalBorderCount < BORDER_WHITE_FRACTION) {
      return buffer;
    }

    const queue = startQueue;
    const seen = new Uint8Array(width * height);
    for (const p of queue) {
      seen[p.y * width + p.x] = 1;
    }

    let head = 0;
    while (head < queue.length) {
      const { x, y } = queue[head++];
      const idx = (y * width + x) * 4;

      data[idx + 3] = 0;

      const neighbors = [
        { x: x + 1, y },
        { x: x - 1, y },
        { x, y: y + 1 },
        { x, y: y - 1 },
      ];

      for (const n of neighbors) {
        if (n.x >= 0 && n.x < width && n.y >= 0 && n.y < height) {
          const nFlat = n.y * width + n.x;
          if (!seen[nFlat]) {
            seen[nFlat] = 1;
            const nIdx = nFlat * 4;
            if (isWhite(nIdx)) {
              queue.push(n);
            }
          }
        }
      }
    }

    // Raw pixels, already bounded by the MAX_FILL_PIXELS bail above, so this
    // one call needs no protection of its own -- it goes through the helper
    // anyway, because an exception here is an exception the tripwire would
    // have to encode too.
    return await sharpInput(data, {
      raw: { width, height, channels: 4 },
    })
      .png()
      .toBuffer();
  } catch {
    return buffer;
  }
}

const MAX_ICON_BYTES = 2 * 1024 * 1024;

/**
 * Fetches `url` directly, capped at {@link MAX_ICON_BYTES}. Used for both the generic
 * favicon discovery's final download and an aggregator-provided image URL (a subreddit
 * icon, a YouTube channel avatar) that is already a direct image link -- no HTML/manifest
 * discovery makes sense there, unlike a bare site homepage.
 */
export async function fetchIconBytes(url: string): Promise<Buffer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_ICON_BYTES) {
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_ICON_BYTES) {
      return null;
    }
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverLogo(
  siteUrl: string,
): Promise<{ url: string; bytes: Buffer } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let html = "";
    try {
      const response = await fetch(siteUrl, { signal: controller.signal });
      if (response.ok) {
        html = await response.text();
      }
    } catch {
      // ignore
    } finally {
      clearTimeout(timeout);
    }

    let declaredUrl: string | null = null;
    if (html) {
      const $ = cheerio.load(html);
      const links = $("link")
        .map((_, el) => ({
          href: $(el).attr("href") || "",
          rel: $(el).attr("rel") || "",
          sizes: $(el).attr("sizes") || "",
        }))
        .get();

      const manifestLink = links.find(
        (l) => l.rel.toLowerCase().split(/\s+/).includes("manifest") && l.href,
      );
      if (manifestLink) {
        try {
          const manifestUrl = new URL(manifestLink.href, siteUrl).href;
          const manifestController = new AbortController();
          const manifestTimeout = setTimeout(() => manifestController.abort(), 5000);
          try {
            const manifestRes = await fetch(manifestUrl, { signal: manifestController.signal });
            if (manifestRes.ok) {
              const manifestJson = await manifestRes.json();
              if (manifestJson && Array.isArray(manifestJson.icons)) {
                for (const icon of manifestJson.icons) {
                  if (icon.src) {
                    links.push({
                      href: new URL(icon.src, manifestUrl).href,
                      sizes: icon.sizes || "",
                      rel: "icon",
                    });
                  }
                }
              }
            }
          } finally {
            clearTimeout(manifestTimeout);
          }
        } catch {
          // ignore
        }
      }

      const best = pickBestIcon(links);
      if (best) {
        try {
          declaredUrl = new URL(best.href, siteUrl).href;
        } catch {
          // invalid url
        }
      }
    }

    const iconUrl = declaredUrl || new URL("/favicon.ico", siteUrl).href;
    const bytes = await fetchIconBytes(iconUrl);
    return bytes ? { url: iconUrl, bytes } : null;
  } catch {
    return null;
  }
}

export async function storeLogo(
  feedId: number,
  bytes: Buffer,
  sourceUrl: string,
): Promise<string | null> {
  const backgroundRemoved = await removeWhiteBackground(bytes);

  let processed: Buffer;
  try {
    processed = await sharpInput(backgroundRemoved)
      .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp()
      .toBuffer();
  } catch {
    // A discovered icon is not guaranteed to be a format sharp/libvips can decode -- a bare
    // `/favicon.ico` fallback is the common case, since libvips has no ICO codec. Skip storing a
    // logo rather than failing the job: the feed just keeps none.
    return null;
  }

  // `compress: false` because this function has already resized/re-encoded to
  // a 128x128 WebP itself -- storeImageBytes's own compression path exists for
  // raw fetched bytes, not for output that has already been through it, and
  // running it again would double-process the image for no benefit.
  const contentHash = await storeImageBytes(processed, "image/webp", { compress: false });
  if (!contentHash) {
    throw new Error(`storeLogo: storeImageBytes refused feed ${feedId}'s logo bytes`);
  }

  writeTransaction((tx) => {
    tx.update(feeds)
      .set({ logoImageHash: contentHash, logoSourceUrl: sourceUrl })
      .where(eq(feeds.id, feedId))
      .run();
  });

  return contentHash;
}
