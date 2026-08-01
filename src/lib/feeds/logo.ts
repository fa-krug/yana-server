import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import sharp from "sharp";
import { eq } from "drizzle-orm";

import { mediaRoot } from "../avatar-storage";
import { db } from "../db/client";
import { feeds } from "../db/schema";

const WHITE_THRESHOLD = 240;
const BORDER_WHITE_FRACTION = 0.85;
const MAX_FILL_PIXELS = 512 * 512;

export function pickBestIcon(icons: {href: string, sizes?: string, rel: string}[]) {
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
    const image = sharp(buffer);
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
      return data[idx] >= WHITE_THRESHOLD && data[idx + 1] >= WHITE_THRESHOLD && data[idx + 2] >= WHITE_THRESHOLD;
    };
    
    let whiteBorderCount = 0;
    let totalBorderCount = 0;
    
    const borderPixels: {x: number, y: number}[] = [];
    
    for (let x = 0; x < width; x++) {
      borderPixels.push({x, y: 0});
      borderPixels.push({x, y: height - 1});
    }
    for (let y = 1; y < height - 1; y++) {
      borderPixels.push({x: 0, y});
      borderPixels.push({x: width - 1, y});
    }
    
    const startQueue: {x: number, y: number}[] = [];
    
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
      const {x, y} = queue[head++];
      const idx = (y * width + x) * 4;
      
      data[idx + 3] = 0;
      
      const neighbors = [
        {x: x + 1, y}, {x: x - 1, y}, {x, y: y + 1}, {x, y: y - 1}
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
    
    return await sharp(data, {
      raw: { width, height, channels: 4 }
    }).png().toBuffer();
  } catch {
    return buffer;
  }
}

export async function discoverLogo(siteUrl: string): Promise<{ url: string; bytes: Buffer } | null> {
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
      const links = $("link").map((_, el) => ({
        href: $(el).attr("href") || "",
        rel: $(el).attr("rel") || "",
        sizes: $(el).attr("sizes") || "",
      })).get();
      
      const manifestLink = links.find(l => l.rel.toLowerCase().split(/\s+/).includes("manifest") && l.href);
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
                      rel: "icon"
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
    
    const iconController = new AbortController();
    const iconTimeout = setTimeout(() => iconController.abort(), 10000);
    try {
      const response = await fetch(iconUrl, { signal: iconController.signal });
      if (response.ok) {
        const contentLength = response.headers.get("content-length");
        if (contentLength && parseInt(contentLength) > 2 * 1024 * 1024) {
          return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > 2 * 1024 * 1024) { // 2MB cap
          return null;
        }
        return { url: iconUrl, bytes: Buffer.from(arrayBuffer) };
      }
    } catch {
      return null;
    } finally {
      clearTimeout(iconTimeout);
    }
  } catch {
    return null;
  }
  
  return null;
}

export async function storeLogo(feedId: number, bytes: Buffer, sourceUrl: string): Promise<string> {
  let processed = await removeWhiteBackground(bytes);
  
  processed = await sharp(processed)
    .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp()
    .toBuffer();

  const logosDir = path.join(mediaRoot(), "feed_logos");
  await fs.mkdir(logosDir, { recursive: true });
  
  const filename = `${feedId}.webp`;
  const filePath = path.join(logosDir, filename);
  await fs.writeFile(filePath, processed);
  
  const relativePath = `feed_logos/${filename}`;
  
  await db.update(feeds)
    .set({ 
      logo: relativePath, 
      logoSourceUrl: sourceUrl 
    })
    .where(eq(feeds.id, feedId));
    
  return relativePath;
}
