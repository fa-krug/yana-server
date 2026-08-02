/**
 * Dailymotion embed provider.
 *
 * Extracted from old/core/aggregators/mein_mmo/embed_processors.py.
 *
 * Detects Dailymotion embeds via class names and URLs, extracts the
 * video ID, builds a canonical URL, and localizes the thumbnail.
 */

import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import type { EmbedBlock } from "../blocks/types";
import { storeImageRefFromUrl } from "../images/store";
import { registerEmbedProvider, type ExtractionContext } from "./registry";

/** Patterns for extracting Dailymotion video IDs. */
const DAILYMOTION_ID_PATTERNS: RegExp[] = [
  /dailymotion\.com\/video\/([A-Za-z0-9]+)/,
  /dailymotion\.com\/embed\/video\/([A-Za-z0-9]+)/,
  /dai\.ly\/([A-Za-z0-9]+)/,
];

/** Class markers for Dailymotion embed containers. */
const DAILYMOTION_CLASS_MARKERS = ["dailymotion-embed", "wp-block-embed-dailymotion", "is-provider-dailymotion"];

/** Data attributes that carry embed markup. */
const EMBED_ATTRS = ["data-sanitized-data-embed-content", "data-embed", "data-sanitized-embed"];

/**
 * Extract a Dailymotion video ID from a URL string.
 */
export function dailymotionIdFrom(url: string): string | null {
  if (!url) return null;
  for (const pattern of DAILYMOTION_ID_PATTERNS) {
    const match = pattern.exec(url);
    if (match) {
      const id = match[1]!;
      if (/^[A-Za-z0-9]+$/.test(id)) return id;
    }
  }
  return null;
}

/** Build a thumbnail URL for a Dailymotion video. */
export function thumbnailUrlFor(id: string): string {
  return `https://www.dailymotion.com/thumbnail/video/${id}`;
}

/**
 * Detect whether a cheerio element is a Dailymotion embed.
 */
export function detectDailymotion(element: Element, $: CheerioAPI): boolean {
  const el = $(element);
  const classStr = (el.attr("class") || "") + " " + (el.attr("data-sanitized-class") || "");

  if (DAILYMOTION_CLASS_MARKERS.some((marker) => classStr.includes(marker))) {
    return true;
  }

  // Check data attributes for Dailymotion URLs
  for (const attr of EMBED_ATTRS) {
    const val = el.attr(attr) || "";
    if (val && dailymotionIdFrom(val)) return true;
  }

  // Check child anchors
  const anchors = el.find("a[href]").toArray() as Element[];
  for (const a of anchors) {
    const href = $(a).attr("href") || "";
    if (dailymotionIdFrom(href)) return true;
  }

  // Check child iframes
  const iframes = el.find("iframe[src]").toArray() as Element[];
  for (const iframe of iframes) {
    const src = $(iframe).attr("src") || "";
    if (dailymotionIdFrom(src)) return true;
  }

  return false;
}

/**
 * Extract the video ID from any Dailymotion embed element.
 */
function extractVideoId(element: Element, $: CheerioAPI): string | null {
  const el = $(element);

  for (const attr of EMBED_ATTRS) {
    const val = el.attr(attr) || "";
    if (val) {
      const id = dailymotionIdFrom(val);
      if (id) return id;
    }
  }

  const anchors = el.find("a[href]").toArray() as Element[];
  for (const a of anchors) {
    const href = $(a).attr("href") || "";
    const id = dailymotionIdFrom(href);
    if (id) return id;
  }

  const iframes = el.find("iframe[src]").toArray() as Element[];
  for (const iframe of iframes) {
    const src = $(iframe).attr("src") || "";
    const id = dailymotionIdFrom(src);
    if (id) return id;
  }

  return null;
}

/**
 * Convert a Dailymotion embed element into a typed EmbedBlock.
 */
export async function convertDailymotion(
  element: Element,
  $: CheerioAPI,
  _context: ExtractionContext,
): Promise<EmbedBlock | null> {
  const videoId = extractVideoId(element, $);
  if (!videoId) return null;

  const thumbUrl = thumbnailUrlFor(videoId);
  const thumbnailRef = (await storeImageRefFromUrl(thumbUrl, { isHeader: true })) ?? "";

  return {
    kind: "embed",
    provider: "dailymotion",
    externalUrl: `https://www.dailymotion.com/video/${videoId}`,
    thumbnailRef,
    title: "",
  };
}

// Self-register — after YouTube, before social providers
registerEmbedProvider({
  key: "dailymotion",
  detect: detectDailymotion,
  convert: convertDailymotion,
});
