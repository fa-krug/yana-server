/**
 * Native inline playback for Reddit-hosted video, mirroring the iOS app's
 * `RedditAggregator.swift::makeVideoHTML` -- the Django oracle and the
 * original TS port both deliberately avoid embedding a `vxreddit.com` link
 * for `v.redd.it` posts and fall back to a static preview image instead, so
 * the video itself never plays in the web reader. This builds a real
 * `<video>` element from Reddit's own HLS/MP4 stream instead.
 */
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

/**
 * Builds an inline HTML5 player. Prefers the HLS stream (muxes audio and
 * plays inline in every modern browser); falls back to the plain MP4 (often
 * video-only). Returns null when there is no playable source at all.
 */
export async function buildVideoHeaderHtml(
  video: RedditVideoSource,
  posterUrl: string | null,
): Promise<string | null> {
  const src = video.hlsUrl || video.fallbackUrl;
  if (!src) return null;

  const type = src.toLowerCase().includes(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4";

  let posterAttr = "";
  if (posterUrl) {
    const ref = await storeImageRefFromUrl(posterUrl, { isHeader: true });
    if (ref) posterAttr = ` poster="${ref}"`;
  }

  return (
    `<header style="margin-bottom: 1.5em;">` +
    `<video controls playsinline preload="metadata"${posterAttr} style="width: 100%; height: auto;">` +
    `<source src="${src}" type="${type}">` +
    `Your browser does not support the video element.</video></header>`
  );
}
