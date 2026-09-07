import * as cheerio from "cheerio";
import { MAX_HTML_BYTES, MAX_REDIRECTS } from "../http/fetcher";
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

/**
 * Deadline for one page fetch, covering every redirect hop and the body drain.
 * Widened from 10s when it stopped covering only the headers.
 */
export const PAGE_FETCH_TIMEOUT_MS = 30_000;

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

  /**
   * Fetch a page and parse it, so the meta-tag and page-image strategies have
   * a DOM to read. Bounded three ways, and each bound closes a defect this
   * call had:
   *
   * - **The body is drained through `readCappedText()`**, not `res.text()`,
   *   which has no cap at all. This URL comes off a source page, so its size
   *   is the source's choice, and a body buffered before it is measured is not
   *   measured.
   * - **The deadline covers the body**, not just the headers -- the timer used
   *   to be cleared on the line above `res.text()`, so a server that sent
   *   headers and then stalled held this call open forever. See
   *   `withDeadline()` for why that deadlocks the worker rather than merely
   *   delaying one feed. It is 30s rather than the old 10s for the same reason
   *   `../images/fetcher.ts`'s was widened: one deadline now spans the
   *   redirect hops and the drain, where it used to span the headers alone.
   * - **Redirects are followed here, bounded by `MAX_REDIRECTS`**, rather than
   *   handed to undici with `redirect: "follow"` and no ceiling of our own.
   *
   * Every refusal is still a `null`, never a throw: `ResponseTooLarge` and a
   * chain that runs out of hops both land where a network error already did.
   */
  private async fetchAndParsePage(url: string): Promise<cheerio.CheerioAPI | null> {
    // Through `fetchTextThrottled()` rather than a local `fetch` + timer,
    // because the abort signal has to be created *inside* the throttle slot:
    // built outside it, the timeout counts down while the request is still
    // queued behind the host's cooldown, and a cooldown longer than the
    // timeout aborts every request before it is ever sent. The helper is
    // itself built on `withDeadline()` and `readCappedText()`, so the
    // placement guarantee and the body cap both still hold.
    //
    // Redirects are followed by hand rather than by undici, for the same
    // reason `fetchBinary()` does it: a chain can cross hosts, and the
    // throttle slot belongs to whichever host is being asked *next* -- and
    // `MAX_REDIRECTS` is a tighter bound than undici's own default of 20.
    let target = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetchTextThrottled(target, {
        headers: getImageHeaders(target),
        redirect: "manual",
        timeoutMs: PAGE_FETCH_TIMEOUT_MS,
        maxBytes: MAX_HTML_BYTES,
      });
      if (!res) return null;

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return null;
        target = new URL(location, target).toString();
        continue;
      }

      if (!res.ok) return null;
      return cheerio.load(res.body);
    }

    return null;
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
