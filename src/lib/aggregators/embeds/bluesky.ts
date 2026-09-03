/**
 * Bluesky post support.
 *
 * Ported from old/core/aggregators/utils/bluesky.py.
 *
 * `isBlueskyUrl`/`extractBlueskyPostInfo` recognise a Bluesky post URL and
 * pull its actor/rkey apart; `buildBlueskyEmbedHtml` fetches the post from
 * the public API and renders it as a styled blockquote. Consumed today by
 * `sites/mein_mmo/embeds.ts`, which finds a Bluesky link in a mein_mmo
 * article's own markup and asks this module to render the replacement HTML
 * directly — there is no generic embed-provider registry here (one used to
 * exist across this directory: a `detect`/`convert` pair per provider behind
 * a first-match-wins dispatch table, but every production embed actually
 * goes through `blocks/parser.ts`'s own `embedFacade()`/`tweetEmbed()`, so
 * the registry and its four provider pairs — including this module's own
 * `detectBluesky`/`convertBluesky` — had zero production callers and were
 * deleted; see `.superpowers/sdd/2026-09-03-pipeline-review-4-cleanup-and-hardening/task-1-brief.md`).
 * If a real multi-provider registry is ever wanted again, model it as a
 * declaration — `defineEmbedProvider({ key, detect, convert })` returning a
 * `{ detect, convert }` pair, in the shape `src/lib/integrations/define.ts`
 * uses for credential providers — rather than resurrecting the
 * import-side-effect registration this module used to do.
 */

import type { ChromeLabels } from "../chrome-labels";
import { escapeHtml } from "../extract/format";
import { isSafeUrl } from "../blocks/parser";

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
 * Accepted risk: unbounded serial network I/O under the job timeout.
 *
 * A single buildBlueskyEmbedHtml() call can take up to ~20s on transport
 * failure (resolveBlueskyDid() and fetchBlueskyPost() each carry their own
 * 10s AbortSignal.timeout, and mein_mmo's processEmbeds() awaits them one
 * figure at a time, never in parallel). A feed with many Bluesky-embedding
 * articles hit during a Bluesky outage could therefore push a single
 * aggregation run close to or past src/lib/jobs/worker.ts's 300s job-level
 * timeout (`timeoutMs`).
 *
 * This is accepted for now rather than fixed here: it matches the Python
 * origin's equally unbounded synchronous design (old/core's
 * BlueskyEmbedProcessor has no equivalent job-level wall-clock cap either),
 * Bluesky embeds are a minority embed type within any given feed's articles,
 * and a real fix -- a run-scoped circuit breaker that stops attempting
 * further Bluesky lookups for the rest of a run after the first transport
 * failure -- needs shared state threaded through
 * extractMeinMmoContent -> processEmbeds -> BlueskyEmbedProcessor, which is a
 * real architecture change deserving its own design/test cycle, not a rushed
 * addition here. Revisit if this proves problematic in practice.
 */

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

/** Format an engagement count for display (e.g. 1234 -> "1.2K"). */
export function formatBlueskyCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Format an ISO 8601 Bluesky date string for display, or null if unparseable.
 * Uses UTC getters and a fixed month-name table rather than Intl: the input
 * is always UTC ("...Z"), and this avoids the display depending on the
 * server process's locale.
 */
export function formatBlueskyPostDate(createdAt: string): string | null {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  const month = MONTH_ABBREVIATIONS[date.getUTCMonth()]!;
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month} ${day}, ${date.getUTCFullYear()}`;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === "string" ? value : "";
}

function numberField(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === "number" ? value : 0;
}

/**
 * Build a rich HTML embed for a Bluesky post.
 *
 * Ported from old/core/aggregators/utils/bluesky.py's build_bluesky_embed_html.
 * Fetches post data from the public Bluesky API and renders it as a styled
 * blockquote with author info, post text, images, and engagement stats.
 *
 * Returns null when the URL isn't a post URL or the API fetch fails. The
 * caller (mein_mmo's BlueskyEmbedProcessor) removes the figure entirely in
 * that case -- matching the Python original, which never falls back to a
 * bare link.
 */
export async function buildBlueskyEmbedHtml(
  url: string,
  labels: ChromeLabels,
): Promise<string | null> {
  const info = extractBlueskyPostInfo(url);
  if (!info) return null;

  const post = await fetchBlueskyPost(info.actor, info.rkey);
  if (!post) return null;

  const record = (post.record ?? {}) as Record<string, unknown>;
  const author = (post.author ?? {}) as Record<string, unknown>;
  const text = stringField(record, "text");
  const displayName = stringField(author, "displayName");
  const handle = stringField(author, "handle");
  const likes = numberField(post, "likeCount");
  const reposts = numberField(post, "repostCount");
  const replies = numberField(post, "replyCount");
  const createdAt = stringField(record, "createdAt");

  const cleanUrl = url.split("?")[0]!;

  const parts: string[] = [
    '<blockquote style="border-left: 3px solid #0085ff; padding: 12px 16px; ' +
      'margin: 1em 0; background: #f7f9fa;">',
  ];

  // clean_url and every image URL below are attacker-reachable (they come
  // from the source page), so each needs both an escape (for the attribute
  // context) and a scheme check via isSafeUrl -- escaping alone doesn't stop
  // a well-formed but unescaped javascript: URL.
  const authorDisplay = displayName || (handle ? `@${handle}` : "");
  const handleSuffix = displayName && handle ? ` (@${handle})` : "";
  const linkHtml = isSafeUrl(cleanUrl)
    ? `<a href="${escapeHtml(cleanUrl)}" target="_blank" rel="noopener">${labels.viewOnBluesky}</a>`
    : labels.viewOnBluesky;
  parts.push(
    `<p style="margin: 0 0 8px 0;"><strong>${escapeHtml(authorDisplay)}</strong>` +
      `${escapeHtml(handleSuffix)} · ${linkHtml}</p>`,
  );

  if (text) {
    parts.push(`<p style="margin: 0 0 8px 0; white-space: pre-wrap;">${escapeHtml(text)}</p>`);
  }

  for (const imageUrl of extractImageUrls(post)) {
    if (!isSafeUrl(imageUrl)) continue;
    parts.push(
      `<p><img src="${escapeHtml(imageUrl)}" alt="Bluesky image" ` +
        `style="max-width: 100%; border-radius: 8px;"></p>`,
    );
  }

  const statsParts: string[] = [];
  if (likes) statsParts.push(`&#9829; ${formatBlueskyCount(likes)}`);
  if (reposts) statsParts.push(`&#128257; ${formatBlueskyCount(reposts)}`);
  if (replies) statsParts.push(`&#128172; ${formatBlueskyCount(replies)}`);
  const formattedDate = createdAt ? formatBlueskyPostDate(createdAt) : null;
  if (formattedDate) statsParts.push(formattedDate);

  if (statsParts.length > 0) {
    parts.push(
      `<p style="margin: 0; color: #536471; font-size: 0.9em;">${statsParts.join(" · ")}</p>`,
    );
  }

  parts.push("</blockquote>");

  return parts.join("\n");
}
