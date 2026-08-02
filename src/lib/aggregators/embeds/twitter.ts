/**
 * Twitter/X embed provider.
 *
 * Ported from old/core/aggregators/utils/twitter.py.
 *
 * Detects Twitter/X URLs (twitter.com, x.com), fetches tweet data
 * from fxtwitter API, localizes images, and produces `provider: "tweet"` blocks.
 */

import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import type { EmbedBlock } from "../blocks/types";
import { storeImageRefFromUrl } from "../images/store";
import { registerEmbedProvider, type ExtractionContext } from "./registry";

/** fxtwitter API endpoint. */
const FXTWITTER_API_BASE = "https://api.fxtwitter.com";

/** Twitter/X domain fragments. */
const TWITTER_DOMAINS = ["twitter.com", "x.com", "mobile.twitter.com"];

/** Check if a URL is a Twitter/X URL. */
export function isTwitterUrl(url: string): boolean {
  if (!url) return false;
  return TWITTER_DOMAINS.some((domain) => url.includes(domain));
}

/**
 * Extract tweet ID from a Twitter/X URL.
 * Pattern: /status/{TWEET_ID}
 */
export function extractTweetId(url: string): string | null {
  if (!url) return null;
  const match = /\/status\/(\d+)/.exec(url);
  return match ? match[1]! : null;
}

/**
 * Fetch tweet data from fxtwitter API.
 */
async function fetchTweetData(tweetId: string): Promise<Record<string, unknown> | null> {
  if (!tweetId) return null;
  try {
    const url = `${FXTWITTER_API_BASE}/status/${tweetId}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Yana/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extract image URLs from fxtwitter tweet data.
 */
function extractImageUrls(data: Record<string, unknown>): string[] {
  const urls: string[] = [];
  try {
    const tweet = (data.tweet ?? {}) as Record<string, unknown>;
    const media = (tweet.media ?? {}) as Record<string, unknown>;

    // Try photos first
    const photos = media.photos as Array<Record<string, unknown>> | undefined;
    if (photos) {
      for (const photo of photos) {
        if (photo.url) urls.push(photo.url as string);
      }
    }

    // Try all media if no photos
    if (urls.length === 0) {
      const all = media.all as Array<Record<string, unknown>> | undefined;
      if (all) {
        for (const item of all) {
          if (item.type === "photo" && item.url) urls.push(item.url as string);
        }
      }
    }

    // Try article cover image
    if (urls.length === 0) {
      const article = (tweet.article ?? {}) as Record<string, unknown>;
      const coverMedia = (article.cover_media ?? {}) as Record<string, unknown>;
      const mediaInfo = (coverMedia.media_info ?? {}) as Record<string, unknown>;
      if (mediaInfo.original_img_url) urls.push(mediaInfo.original_img_url as string);
    }
  } catch {
    // ignore extraction errors
  }
  return urls;
}

/** Detect whether a cheerio element contains a Twitter/X URL. */
export function detectTwitter(element: Element, $: CheerioAPI): boolean {
  const anchors = $(element).find("a[href]").toArray() as Element[];
  for (const a of anchors) {
    const href = $(a).attr("href") || "";
    if (isTwitterUrl(href)) return true;
  }
  return false;
}

/**
 * Convert a Twitter/X embed element into a typed EmbedBlock.
 * Emits `provider: "tweet"`.
 */
export async function convertTwitter(
  element: Element,
  $: CheerioAPI,
  _context: ExtractionContext,
): Promise<EmbedBlock | null> {
  // Find Twitter URL
  const anchors = $(element).find("a[href]").toArray() as Element[];
  let twitterUrl = "";
  for (const a of anchors) {
    const href = $(a).attr("href") || "";
    if (isTwitterUrl(href)) {
      twitterUrl = href.split("?")[0]!;
      break;
    }
  }
  if (!twitterUrl) return null;

  // Try to enrich via API
  let thumbnailRef = "";
  const tweetId = extractTweetId(twitterUrl);
  if (tweetId) {
    const data = await fetchTweetData(tweetId);
    if (data) {
      const imageUrls = extractImageUrls(data);
      if (imageUrls.length > 0) {
        const ref = await storeImageRefFromUrl(imageUrls[0]!, { isHeader: true });
        if (ref) thumbnailRef = ref;
      }
    }
  }

  const title = $(element).text().replace(/\s+/g, " ").trim();

  return {
    kind: "embed",
    provider: "tweet",
    externalUrl: twitterUrl,
    thumbnailRef,
    title,
  };
}

// Self-register — after Bluesky (broader match on link URLs)
registerEmbedProvider({
  key: "tweet",
  detect: detectTwitter,
  convert: convertTwitter,
});
