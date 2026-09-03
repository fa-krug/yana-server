/**
 * YouTube embed provider.
 *
 * Ported from old/core/aggregators/utils/youtube.py.
 *
 * Detects YouTube embeds via class names and data attributes, extracts
 * the video ID, builds a canonical URL, and localizes the thumbnail
 * through the image store.
 */

import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import type { EmbedBlock } from "../blocks/types";
import { storeImageRefFromUrl } from "../images/store";
import { registerEmbedProvider, type ExtractionContext } from "./registry";
import { isYoutubeUrl, thumbnailUrlFor, youtubeIdFrom } from "./youtube-url";
export { proxyYoutubeEmbeds } from "../website";
// Re-exported so every existing server-side importer of this module (which
// pulls in cheerio and the image store below) keeps working unchanged. See
// ./youtube-url.ts for why the id extractor, the domain check and the
// thumbnail builder now live in their own dependency-free module.
export {
  isYoutubeUrl,
  thumbnailUrlFor,
  youtubeIdFrom,
  YOUTUBE_EMBED_DOMAIN_ALTERNATION,
} from "./youtube-url";

/**
 * YouTube thumbnail quality fallback order.
 * maxresdefault (1280x720) is not always available; hqdefault (480x360) always is.
 */
const THUMBNAIL_QUALITIES = ["maxresdefault", "hqdefault"] as const;

/** Class markers that identify a YouTube embed container. */
const YOUTUBE_CLASS_MARKERS = [
  "youtube-embed",
  "wp-block-embed-youtube",
  "is-provider-youtube",
  "embed-youtube",
];

/** Data attributes that carry embed markup with video IDs. */
const EMBED_ATTRS = ["data-sanitized-data-embed-content", "data-embed", "data-sanitized-embed"];

/**
 * Detect whether a cheerio element is a YouTube embed.
 * Checks class names, data attributes, and child anchors for YouTube URLs.
 */
export function detectYoutube(element: Element, $: CheerioAPI): boolean {
  const el = $(element);
  const classStr = (el.attr("class") || "") + " " + (el.attr("data-sanitized-class") || "");

  if (YOUTUBE_CLASS_MARKERS.some((marker) => classStr.includes(marker))) {
    return true;
  }

  // Check data attributes for YouTube URLs
  for (const attr of EMBED_ATTRS) {
    const val = el.attr(attr) || "";
    if (val && isYoutubeUrl(val)) return true;
  }

  // Check child anchors
  const anchors = el.find("a[href]").toArray() as Element[];
  for (const a of anchors) {
    const href = $(a).attr("href") || "";
    if (isYoutubeUrl(href) && youtubeIdFrom(href)) return true;
  }

  // Check child iframes
  const iframes = el.find("iframe[src]").toArray() as Element[];
  for (const iframe of iframes) {
    const src = $(iframe).attr("src") || "";
    if (isYoutubeUrl(src)) return true;
  }

  return false;
}

/**
 * Extract the video ID from any YouTube embed element.
 * Scans data attributes, anchors, and iframes.
 */
function extractVideoId(element: Element, $: CheerioAPI): string | null {
  const el = $(element);

  // Try data attributes first
  for (const attr of EMBED_ATTRS) {
    const val = el.attr(attr) || "";
    if (val) {
      const id = youtubeIdFrom(val);
      if (id) return id;
    }
  }

  // Try anchors
  const anchors = el.find("a[href]").toArray() as Element[];
  for (const a of anchors) {
    const href = $(a).attr("href") || "";
    const id = youtubeIdFrom(href);
    if (id) return id;
  }

  // Try iframes
  const iframes = el.find("iframe[src]").toArray() as Element[];
  for (const iframe of iframes) {
    const src = $(iframe).attr("src") || "";
    const id = youtubeIdFrom(src);
    if (id) return id;
  }

  return null;
}

/**
 * Localize a YouTube thumbnail by trying qualities in order.
 * Returns a `yana-img://<hash>` ref, or an empty string on failure.
 */
export async function localizeThumbnail(videoId: string): Promise<string> {
  for (const quality of THUMBNAIL_QUALITIES) {
    const url = thumbnailUrlFor(videoId, quality);
    const ref = await storeImageRefFromUrl(url, { isHeader: true });
    if (ref) return ref;
  }
  // Every call site (a fresh aggregation, a reload, an embedded-video
  // facade) treats "" as "render the facade with no image" and moves on
  // silently -- there was previously no signal anywhere that this had
  // happened, which is exactly why a persistently-imageless facade (e.g.
  // this video's own thumbnail genuinely being unreachable from this host)
  // looked indistinguishable from "reload didn't do anything."
  console.warn(
    `[youtube] localizeThumbnail(${videoId}): both ${THUMBNAIL_QUALITIES.join(" and ")} thumbnail fetches failed or were rejected`,
  );
  return "";
}

/**
 * Convert a YouTube embed element into a typed EmbedBlock.
 *
 * The canonical URL is always `https://www.youtube.com/watch?v=<id>`,
 * regardless of which input form was found.
 */
export async function convertYoutube(
  element: Element,
  $: CheerioAPI,
  _context: ExtractionContext,
): Promise<EmbedBlock | null> {
  const videoId = extractVideoId(element, $);
  if (!videoId) return null;

  const thumbnailRef = await localizeThumbnail(videoId);

  return {
    kind: "embed",
    provider: "youtube",
    externalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnailRef,
    title: "",
  };
}

// Self-register in the provider registry
registerEmbedProvider({
  key: "youtube",
  detect: detectYoutube,
  convert: convertYoutube,
});
