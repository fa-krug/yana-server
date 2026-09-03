/**
 * Dailymotion video ID/thumbnail support.
 *
 * Extracted from old/core/aggregators/mein_mmo/embed_processors.py.
 *
 * `dailymotionIdFrom` recognises a Dailymotion video URL and pulls its id
 * out; `localizeThumbnail` fetches that video's thumbnail through the image
 * store and returns a `yana-img://` ref. There is no generic embed-provider
 * registry here (one used to exist across this directory: a
 * `detect`/`convert` pair per provider behind a first-match-wins dispatch
 * table, but every production embed actually goes through
 * `blocks/parser.ts`'s own `embedFacade()`/`tweetEmbed()`, so the registry
 * and its four provider pairs — including this module's own
 * `detectDailymotion`/`convertDailymotion` — had zero production callers
 * and were deleted; see
 * `.superpowers/sdd/2026-09-03-pipeline-review-4-cleanup-and-hardening/task-1-brief.md`).
 * If a real multi-provider registry is ever wanted again, model it as a
 * declaration — `defineEmbedProvider({ key, detect, convert })` returning a
 * `{ detect, convert }` pair, in the shape `src/lib/integrations/define.ts`
 * uses for credential providers — rather than resurrecting the
 * import-side-effect registration this module used to do.
 */

import { storeImageRefFromUrl } from "../images/store";

/** Patterns for extracting Dailymotion video IDs. */
const DAILYMOTION_ID_PATTERNS: RegExp[] = [
  /dailymotion\.com\/video\/([A-Za-z0-9]+)/,
  /dailymotion\.com\/embed\/video\/([A-Za-z0-9]+)/,
  /dai\.ly\/([A-Za-z0-9]+)/,
];

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
 * Localize a Dailymotion thumbnail. Returns a `yana-img://<hash>` ref, or an
 * empty string on failure.
 */
export async function localizeThumbnail(videoId: string): Promise<string> {
  const ref = await storeImageRefFromUrl(thumbnailUrlFor(videoId), { isHeader: true });
  return ref ?? "";
}
