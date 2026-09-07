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
 *
 * **`isHeader: true` is deliberate, and it is the only thing that flag does:**
 * `compressImage()` resizes to `MAX_HEADER_IMAGE_*` (1200x1200) instead of
 * `MAX_IMAGE_*` (600x600) -- see `../images/compression.ts`. A video
 * thumbnail is the poster of a click-through facade, which every client
 * renders at the article's full width, and when the embed is the article's
 * lead media it *is* the lead image (`ArticleBlockView` hoists block 0), so
 * the 600px body cap would visibly soften exactly the image an article is
 * most often recognised by. The cost is bounded: `fit: "inside"` with
 * `withoutEnlargement: true` makes 1200 a ceiling, not a target, so a
 * smaller source is stored at its own size and only a genuinely large
 * thumbnail pays anything. `youtube.ts`'s `localizeThumbnail` and Reddit's
 * video poster (`sites/reddit/video.ts`) set the same flag for the same kind
 * of asset. (Two other call sites the review flagged -- the Twitter and
 * Bluesky *photo* embeds, where "a header-resolution copy of every tweet's
 * first photo" was the real question -- no longer exist: both lived in the
 * dead embed-provider registry Task 1 deleted.)
 */
export async function localizeThumbnail(videoId: string): Promise<string> {
  const ref = await storeImageRefFromUrl(thumbnailUrlFor(videoId), { isHeader: true });
  if (!ref) {
    // Matches `youtube.ts`'s `localizeThumbnail`, which is the same function
    // for the same failure and already explains why silence was the bug:
    // every call site treats "" as "render the facade with no image" and
    // moves on, so without this line a persistently imageless facade (this
    // video's thumbnail genuinely being unreachable from this host) is
    // indistinguishable from the aggregator having done nothing.
    console.warn(
      `[dailymotion] localizeThumbnail(${videoId}): thumbnail fetch failed or was rejected`,
    );
    return "";
  }
  return ref;
}
