import * as cheerio from "cheerio";

import { fetchTextThrottled } from "../http/throttled-fetch";
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
    onLog?: (message: string) => void,
    html?: string,
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

    // Parse the page HTML for the meta tag & page image strategies -- reusing
    // the caller's copy when it has one, so the aggregator does not fetch the
    // same article page a second time just to read its og:image.
    try {
      const $ = html ? cheerio.load(html) : await this.fetchAndParsePage(url);
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

    // Every strategy either could not handle this URL, threw (swallowed
    // above), or found nothing -- log the definitive failure so it is
    // visible instead of looking like an unrelated no-op elsewhere. `onLog`,
    // when given, is the caller's job-output channel (see
    // reload.ts/aggregate.ts) -- console.warn alone only ever reached the
    // server log, never the job the operator is actually looking at.
    const message = `[images] could not extract an image from ${url}`;
    console.warn(message);
    onLog?.(message);
    return null;
  }

  private async fetchAndParsePage(url: string): Promise<cheerio.CheerioAPI | null> {
    // Through `fetchTextThrottled()` rather than a local `fetch` + timer,
    // because the abort signal has to be created *inside* the throttle slot:
    // built outside it, the timeout counts down while the request is still
    // queued behind the host's cooldown, and a cooldown longer than the
    // timeout aborts every request before it is ever sent.
    const res = await fetchTextThrottled(url, {
      headers: getImageHeaders(url),
      redirect: "follow",
    });
    if (!res || !res.ok) return null;
    return cheerio.load(res.body);
  }
}

export async function extractImages(
  url: string,
  isHeaderImage = false,
  onLog?: (message: string) => void,
  html?: string,
): Promise<FetchedImageResultWithUrl | null> {
  const extractor = new ImageExtractor();
  return extractor.extractImageFromUrl(url, isHeaderImage, onLog, html);
}
