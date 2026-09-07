/**
 * Shared building blocks for the three comic aggregators (explosm.ts,
 * dark_legacy.ts, oglaf.ts). Each finds the comic `<img>` its own way --
 * `src="static.explosm.net"` sniffing, a page-wide loop, a selector cascade
 * plus a CDN-prefix rule -- but what happens *after* the image is found is
 * identical: resolve it through the image store, and optionally render its
 * alt/title text as an italic caption beneath it.
 */
import { isSafeUrl } from "../blocks/parser";
import type { FeedLike } from "../base";
import { storeImageRefFromUrl } from "../images/store";

/**
 * Comics here are tall vertical strips; the default 600x600 body-image cap
 * (src/lib/aggregators/images/compression.ts) crushes them down to an
 * unreadable width. dark_legacy.ts and oglaf.ts both need this taller
 * ceiling; explosm.ts's strips don't and deliberately omits it (see its own
 * call to resolveComicImageSrc()).
 */
export const COMIC_MAX_DIMENSIONS = { width: 1600, height: 4800 };

/** The caption/alt-text style shared by every comic aggregator's caption. */
export const COMIC_CAPTION_STYLE = "font-style: italic; margin-top: 1em; color: #666;";

/** `show_alt_text` defaults to on; only an explicit `false` turns it off. */
export function wantsComicAltText(feed: FeedLike): boolean {
  const options = (feed.options as Record<string, unknown> | null) || {};
  return options.show_alt_text !== false;
}

/**
 * Resolve a comic panel's image through the image store, same as any other
 * body image: `isSafeUrl()` first, then `storeImageRefFromUrl()`, falling
 * back to the original src if either the safety check or the store call
 * comes back empty. Used by explosm.ts and dark_legacy.ts.
 *
 * oglaf.ts does **not** use this: when its image fails `isSafeUrl()`, it
 * renders no `<img>` at all rather than falling back to the unsafe src --
 * a real difference from the other two, kept rather than unified away, so
 * it still calls `isSafeUrl()`/`storeImageRefFromUrl()` inline.
 */
export async function resolveComicImageSrc(
  src: string,
  options?: { maxDimensions?: { width: number; height: number } },
): Promise<string> {
  if (!isSafeUrl(src)) return src;
  const ref = await storeImageRefFromUrl(src, options);
  return ref || src;
}
