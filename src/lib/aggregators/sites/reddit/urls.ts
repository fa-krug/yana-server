/**
 * Reddit URL utilities.
 *
 * Ported from old/core/aggregators/reddit/urls.py.
 */

/** The subset of `/r/{subreddit}/about.json`'s response `fetchSubredditInfo` reads. */
interface RedditSubredditAboutResponse {
  data?: {
    icon_img?: string;
    community_icon?: string;
    header_img?: string;
  };
}

export function decodeHtmlEntitiesInUrl(url: string): string {
  if (!url) return "";
  return (
    url
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // `String.fromCodePoint` throws `RangeError` above 0x10FFFF (`&#1114112;`),
      // so a malformed ref must leave the matched text alone rather than take the
      // whole aggregation run down.
      .replace(/&#x([0-9a-fA-F]+);/g, (match, hex: string) => {
        try {
          return String.fromCodePoint(parseInt(hex, 16));
        } catch {
          return match;
        }
      })
      .replace(/&#(\d+);/g, (match, dec: string) => {
        try {
          return String.fromCodePoint(Number(dec));
        } catch {
          return match;
        }
      })
  );
}

export function fixRedditMediaUrl(url?: string | null): string | null {
  if (!url) return null;
  let decoded = decodeHtmlEntitiesInUrl(url);
  if (decoded.includes("&")) {
    decoded = decodeHtmlEntitiesInUrl(decoded);
  }
  return decoded;
}

export function normalizeSubreddit(identifier: string): string {
  if (!identifier) return "";
  let iden = identifier.trim();

  const match = iden.match(/(?:reddit\.com)?\/?r\/(\w+)/i);
  if (match && match[1]) {
    return match[1];
  }

  if (iden.startsWith("/r/")) {
    iden = iden.slice(3);
  } else if (iden.startsWith("r/")) {
    iden = iden.slice(2);
  }

  iden = iden.split("/")[0] || "";
  iden = iden.split(/[:\s]/)[0] || "";
  return iden;
}

export function extractPostInfoFromUrl(url: string): {
  subreddit: string | null;
  postId: string | null;
} {
  if (!url) return { subreddit: null, postId: null };
  const match = url.match(/\/r\/(\w+)\/comments\/([a-zA-Z0-9]+)/);
  if (match && match[1] && match[2]) {
    return { subreddit: match[1], postId: match[2] };
  }
  return { subreddit: null, postId: null };
}

export function validateSubreddit(subreddit: string): { valid: boolean; error?: string } {
  if (!subreddit) {
    return { valid: false, error: "Subreddit is required" };
  }

  if (!/^\w{2,21}$/.test(subreddit)) {
    return {
      valid: false,
      error: "Invalid subreddit name. Use 2-21 alphanumeric characters or underscores.",
    };
  }

  return { valid: true };
}

export async function fetchSubredditInfo(
  subreddit: string,
  _userId?: number | string | null,
  accessToken?: string | null,
): Promise<{ iconUrl: string | null }> {
  if (!subreddit) return { iconUrl: null };
  try {
    const url = accessToken
      ? `https://oauth.reddit.com/r/${subreddit}/about.json`
      : `https://www.reddit.com/r/${subreddit}/about.json`;
    const headers: Record<string, string> = { "User-Agent": "Yana/1.0" };
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { iconUrl: null };
    const data = (await res.json()) as RedditSubredditAboutResponse;
    const rawIcon =
      data?.data?.icon_img || data?.data?.community_icon || data?.data?.header_img || null;
    return { iconUrl: fixRedditMediaUrl(rawIcon) };
  } catch {
    return { iconUrl: null };
  }
}

export function extractUrlsFromText(text: string): string[] {
  if (!text) return [];
  const urls: string[] = [];

  const markdownLinkPattern = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdownLinkPattern.exec(text)) !== null) {
    if (match[2]) {
      urls.push(decodeHtmlEntitiesInUrl(match[2]));
    }
  }

  const plainUrlPattern = /(?:^|[\s(])(https?:\/\/[^\s)]+)/g;
  while ((match = plainUrlPattern.exec(text)) !== null) {
    if (match[1]) {
      const cleanUrl = match[1].replace(/[.,;:!?)]+$/, "");
      const decoded = decodeHtmlEntitiesInUrl(cleanUrl);
      if (!urls.includes(decoded)) {
        urls.push(decoded);
      }
    }
  }

  return urls;
}
