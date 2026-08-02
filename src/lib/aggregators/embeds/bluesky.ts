/**
 * Bluesky embed provider.
 *
 * Ported from old/core/aggregators/utils/bluesky.py.
 *
 * Detects Bluesky post URLs (bsky.app), fetches post data from the
 * public API, extracts images, and produces `provider: "tweet"` blocks
 * (same provider string as Twitter — the Python does this too).
 */

import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import type { EmbedBlock } from "../blocks/types";
import { storeImageRefFromUrl } from "../images/store";
import { registerEmbedProvider, type ExtractionContext } from "./registry";

/** Public (unauthenticated) Bluesky AppView API endpoint. */
const BSKY_API_BASE = "https://public.api.bsky.app";

/** Check if a URL is a Bluesky URL. */
export function isBlueskyUrl(url: string): boolean {
  return Boolean(url) && url.includes("bsky.app");
}

/**
 * Extract the actor (handle or DID) and record key from a Bluesky post URL.
 * Pattern: /profile/{handle_or_did}/post/{rkey}
 */
export function extractBlueskyPostInfo(url: string): { actor: string; rkey: string } | null {
  if (!url) return null;
  const match = /\/profile\/([^/]+)\/post\/([^/?#]+)/.exec(url);
  return match ? { actor: match[1]!, rkey: match[2]! } : null;
}

/**
 * Resolve a Bluesky handle to a DID.
 * If the actor is already a DID (starts with "did:"), it is returned as-is.
 */
async function resolveBlueskyDid(actor: string): Promise<string | null> {
  if (!actor) return null;
  if (actor.startsWith("did:")) return actor;

  try {
    const url = `${BSKY_API_BASE}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Yana/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { did?: string };
    return data.did ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch post data from the public Bluesky API.
 */
async function fetchBlueskyPost(
  actor: string,
  rkey: string,
): Promise<Record<string, unknown> | null> {
  const did = await resolveBlueskyDid(actor);
  if (!did) return null;

  const atUri = `at://${did}/app.bsky.feed.post/${rkey}`;
  try {
    const url = `${BSKY_API_BASE}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(atUri)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Yana/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { posts?: Record<string, unknown>[] };
    return data.posts?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract image URLs from a Bluesky post.
 * Handles both app.bsky.embed.images#view and recordWithMedia#view.
 */
function extractImageUrls(post: Record<string, unknown>): string[] {
  const urls: string[] = [];
  try {
    let embed = (post.embed ?? {}) as Record<string, unknown>;
    const embedType = (embed.$type ?? "") as string;
    if (embedType.includes("recordWithMedia")) {
      embed = (embed.media ?? {}) as Record<string, unknown>;
    }
    const images = (embed.images ?? []) as Array<Record<string, unknown>>;
    for (const img of images) {
      const url = (img.fullsize ?? img.thumb) as string | undefined;
      if (url) urls.push(url);
    }
  } catch {
    // ignore extraction errors
  }
  return urls;
}

/** Detect whether a cheerio element contains a Bluesky URL. */
export function detectBluesky(element: Element, $: CheerioAPI): boolean {
  const anchors = $(element).find("a[href]").toArray() as Element[];
  for (const a of anchors) {
    const href = $(a).attr("href") || "";
    if (isBlueskyUrl(href)) return true;
  }
  return false;
}

/**
 * Convert a Bluesky embed element into a typed EmbedBlock.
 * Emits `provider: "tweet"` — same as the Python implementation.
 */
export async function convertBluesky(
  element: Element,
  $: CheerioAPI,
  _context: ExtractionContext,
): Promise<EmbedBlock | null> {
  // Find Bluesky URL
  const anchors = $(element).find("a[href]").toArray() as Element[];
  let blueskyUrl = "";
  for (const a of anchors) {
    const href = $(a).attr("href") || "";
    if (isBlueskyUrl(href)) {
      blueskyUrl = href.split("?")[0]!;
      break;
    }
  }
  if (!blueskyUrl) return null;

  // Try to enrich via API
  let thumbnailRef = "";
  const postInfo = extractBlueskyPostInfo(blueskyUrl);
  if (postInfo) {
    const post = await fetchBlueskyPost(postInfo.actor, postInfo.rkey);
    if (post) {
      const imageUrls = extractImageUrls(post);
      if (imageUrls.length > 0) {
        const ref = await storeImageRefFromUrl(imageUrls[0]!, { isHeader: true });
        if (ref) thumbnailRef = ref;
      }
    }
  }

  const title = $(element).text().replace(/\s+/g, " ").trim();

  return {
    kind: "embed",
    provider: "tweet", // Python emits "tweet" for Bluesky too
    externalUrl: blueskyUrl,
    thumbnailRef,
    title,
  };
}

// Self-register — after Dailymotion, before Twitter
registerEmbedProvider({
  key: "tweet",
  detect: detectBluesky,
  convert: convertBluesky,
});
