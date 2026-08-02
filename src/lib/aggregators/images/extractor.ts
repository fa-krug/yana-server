import * as cheerio from "cheerio";
import { fetchSingleImage, getImageHeaders } from "./fetcher";
import {
  DirectImageStrategy,
  MetaTagImageStrategy,
  PageImagesStrategy,
  TwitterImageStrategy,
  YouTubeThumbnailStrategy,
  type FetchedImageResultWithUrl,
  type ImageExtractionContext,
  type ImageStrategy,
} from "./strategies";

export const DOMAIN_IMAGE_OVERRIDES: Record<string, string> = {
  "https://en-americas-support.nintendo.com/":
    "https://upload.wikimedia.org/wikipedia/commons/0/0d/Nintendo.svg",
};

export function getOverrideImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let longestMatch: string | null = null;
  let longestLength = 0;
  for (const [prefix, imageUrl] of Object.entries(DOMAIN_IMAGE_OVERRIDES)) {
    if (url.startsWith(prefix) && prefix.length > longestLength) {
      longestMatch = imageUrl;
      longestLength = prefix.length;
    }
  }
  return longestMatch;
}

export class ImageExtractor {
  private strategies: ImageStrategy[];

  constructor() {
    this.strategies = [
      new DirectImageStrategy(),
      new YouTubeThumbnailStrategy(),
      new TwitterImageStrategy(),
      new MetaTagImageStrategy(),
      new PageImagesStrategy(),
    ];
  }

  async extractImageFromUrl(
    url: string,
    isHeaderImage = false,
  ): Promise<FetchedImageResultWithUrl | null> {
    if (!url) return null;

    // Check domain override first
    const overrideUrl = getOverrideImageUrl(url);
    if (overrideUrl) {
      const overrideResult = await fetchSingleImage(overrideUrl);
      if (overrideResult) {
        return { ...overrideResult, imageUrl: overrideUrl };
      }
    }

    const context: ImageExtractionContext = { url, isHeaderImage };

    // Try strategies that don't require HTML page fetching first
    for (const strategy of this.strategies.slice(0, 3)) {
      if (!strategy.canHandle(context)) continue;
      try {
        const result = await strategy.extract(context);
        if (result) return result;
      } catch {}
    }

    // Fetch and parse page HTML for meta tag & page image strategies
    try {
      const $ = await this.fetchAndParsePage(url);
      if ($) {
        context.$ = $;
        for (const strategy of this.strategies.slice(3)) {
          if (!strategy.canHandle(context)) continue;
          try {
            const result = await strategy.extract(context);
            if (result) return result;
          } catch {}
        }
      }
    } catch {}

    return null;
  }

  private async fetchAndParsePage(url: string): Promise<cheerio.CheerioAPI | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        headers: getImageHeaders(url),
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);

      if (!res.ok) return null;
      const html = await res.text();
      return cheerio.load(html);
    } catch {
      return null;
    }
  }
}

export async function extractImages(
  url: string,
  isHeaderImage = false,
): Promise<FetchedImageResultWithUrl | null> {
  const extractor = new ImageExtractor();
  return extractor.extractImageFromUrl(url, isHeaderImage);
}
