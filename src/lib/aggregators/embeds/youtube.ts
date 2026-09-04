/**
 * YouTube thumbnail localization.
 *
 * Ported from old/core/aggregators/utils/youtube.py.
 *
 * The id extraction, the domain check and the thumbnail-URL builder live in
 * `./youtube-url.ts`, a dependency-free module a client component
 * (`src/components/articles/block-node.tsx`) imports directly — see that
 * module's own doc comment. This module re-exports them for every existing
 * server-side importer (which already pulls in the image store below), and
 * adds `localizeThumbnail`, which fetches a video's thumbnail through the
 * image store and returns a `yana-img://` ref.
 *
 * There is no generic embed-provider registry here (one used to exist
 * across this directory: a `detect`/`convert` pair per provider behind a
 * first-match-wins dispatch table, but every production embed actually
 * goes through `blocks/parser.ts`'s own `embedFacade()`/`tweetEmbed()`, so
 * the registry and its four provider pairs — including this module's own
 * `detectYoutube`/`convertYoutube` — had zero production callers and were
 * deleted; see
 * `.superpowers/sdd/2026-09-03-pipeline-review-4-cleanup-and-hardening/task-1-brief.md`).
 * If a real multi-provider registry is ever wanted again, model it as a
 * declaration — `defineEmbedProvider({ key, detect, convert })` returning a
 * `{ detect, convert }` pair, in the shape `src/lib/integrations/define.ts`
 * uses for credential providers — rather than resurrecting the
 * import-side-effect registration this module used to do.
 */

import { storeImageRefFromUrl } from "../images/store";
import { thumbnailUrlFor } from "./youtube-url";
// Re-exported so every existing server-side importer of this module (which
// pulls in the image store below) keeps working unchanged. See
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

/**
 * Localize a YouTube thumbnail by trying qualities in order.
 * Returns a `yana-img://<hash>` ref, or an empty string on failure.
 */
export async function localizeThumbnail(videoId: string): Promise<string> {
  for (const quality of THUMBNAIL_QUALITIES) {
    const url = thumbnailUrlFor(videoId, quality);
    // `isHeader: true` -- why a video thumbnail is sized to the 1200px header
    // cap rather than the 600px body one is written out on
    // `./dailymotion.ts`'s twin of this function.
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
