/**
 * Native inline playback for Reddit-hosted video, mirroring the iOS app's
 * `RedditAggregator.swift::makeVideoHTML` -- the Django oracle and the
 * original TS port both deliberately avoid embedding a `vxreddit.com` link
 * for `v.redd.it` posts and fall back to a static preview image instead, so
 * the video itself never plays in the web reader. This builds a real
 * `<video>` element from Reddit's own HLS/MP4 stream instead.
 */
import { isSafeUrl } from "../../blocks/parser";
import { escapeHtml } from "../../extract/format";
import { storeImageRefFromUrl } from "../../images/store";
import type { RedditPostData, RedditVideoInfo } from "./types";

export interface RedditVideoSource {
  hlsUrl?: string;
  fallbackUrl?: string;
}

/**
 * Best available Reddit-hosted video for a post: `media`/`secure_media`
 * carry it for native `v.redd.it` posts; `preview.reddit_video_preview`
 * carries it for link posts whose target Reddit transcoded into a preview
 * video (e.g. a gfycat/imgur GIF).
 */
export function extractRedditVideo(post: RedditPostData): RedditVideoSource | null {
  const info: RedditVideoInfo | undefined =
    post.media?.reddit_video ??
    post.secure_media?.reddit_video ??
    post.preview?.reddit_video_preview;
  if (!info || (!info.hls_url && !info.fallback_url)) return null;
  return { hlsUrl: info.hls_url, fallbackUrl: info.fallback_url };
}

function sourceType(url: string): string {
  return url.toLowerCase().includes(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4";
}

/**
 * Builds an inline HTML5 player. Returns null when there is no playable
 * source at all.
 *
 * **The MP4 (`fallbackUrl`) is emitted first, on purpose.** HLS is not
 * universally playable: only Safari has native `.m3u8` support -- Chrome and
 * Firefox need a JS player (hls.js) that this reader does not ship -- while a
 * plain MP4 URL plays in any browser. And in this repository nothing plays the
 * `<video>` inline at all yet: the block parser's `videoEmbed`
 * (`../../blocks/parser.ts`) reads only the **first** `<source>`'s `src` and
 * turns the element into a link-out card, which
 * `src/components/articles/block-node.tsx` renders as a thumbnail plus an
 * external link. So whichever URL comes first is the URL the reader clicks --
 * and an `.m3u8` playlist downloads as a text file in Chrome/Firefox where the
 * `.mp4` just plays. The HLS URL is still emitted as a second `<source>` so a
 * real inline player added later gets the muxed-audio stream for free.
 */
export async function buildVideoHeaderHtml(
  video: RedditVideoSource,
  posterUrl: string | null,
): Promise<string | null> {
  const candidates = [video.fallbackUrl, video.hlsUrl].filter(
    (url): url is string => typeof url === "string" && url.length > 0 && isSafeUrl(url),
  );
  if (candidates.length === 0) return null;

  let posterAttr = "";
  if (posterUrl) {
    // `storeImageRefFromUrl` can throw (an `ImageHashCollisionError`, a
    // filesystem failure), and since the aggregation pipeline stopped
    // swallowing errors that would fail the whole feed run over one bad
    // poster. A poster is decoration: degrade to none, exactly as for a
    // falsy ref. Same defensive shape as `_storeHeaderImage()` in
    // `./aggregator.ts`.
    try {
      const ref = await storeImageRefFromUrl(posterUrl, { isHeader: true });
      // The ref is a `yana-img://` URL, so it is escaped but not run through
      // `isSafeUrl()` (which knows only http/https/mailto) -- the same
      // treatment `buildHeaderHtml()` in `../../extract/format.ts` gives it.
      if (ref) posterAttr = ` poster="${escapeHtml(ref)}"`;
    } catch {
      // No poster.
    }
  }

  const sources = candidates
    .map((url) => `<source src="${escapeHtml(url)}" type="${sourceType(url)}">`)
    .join("");

  return (
    `<header style="margin-bottom: 1.5em;">` +
    `<video controls playsinline preload="metadata"${posterAttr} style="width: 100%; height: auto;">` +
    `${sources}` +
    `Your browser does not support the video element.</video></header>`
  );
}
