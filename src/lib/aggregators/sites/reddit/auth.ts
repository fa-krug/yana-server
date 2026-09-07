/**
 * Reddit authentication utilities.
 *
 * Ported from old/core/aggregators/reddit/auth.py.
 */

import { fetchJsonThrottled } from "../../http/throttled-fetch";

export interface RedditUserSettings {
  reddit_enabled: boolean;
  reddit_client_id: string;
  reddit_client_secret: string;
  reddit_user_agent: string;
}

export function getRedditUserSettings(
  feedOptions?: Record<string, unknown> | null,
): RedditUserSettings {
  const enabled = Boolean(
    feedOptions?.reddit_enabled ?? process.env.REDDIT_ENABLED ?? process.env.REDDIT_CLIENT_ID,
  );
  const clientId = (feedOptions?.reddit_client_id as string) || process.env.REDDIT_CLIENT_ID || "";
  const clientSecret =
    (feedOptions?.reddit_client_secret as string) || process.env.REDDIT_CLIENT_SECRET || "";
  const userAgent =
    (feedOptions?.reddit_user_agent as string) || process.env.REDDIT_USER_AGENT || "Yana/1.0";

  return {
    reddit_enabled: enabled,
    reddit_client_id: clientId,
    reddit_client_secret: clientSecret,
    reddit_user_agent: userAgent,
  };
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getRedditAccessToken(
  clientId: string,
  clientSecret: string,
  userAgent = "Yana/1.0",
): Promise<string | null> {
  if (!clientId || !clientSecret) return null;

  const cacheKey = `${clientId}:${clientSecret}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) {
    if (Date.now() < cached.expiresAt) return cached.token;
    // Drop the stale entry rather than leaving it for the re-fetch below to
    // overwrite -- the map is then bounded by *live* credential pairs instead
    // of by every pair the process has ever seen.
    tokenCache.delete(cacheKey);
  }

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    // `attempts: 1` -- no 429 retry here, unlike every other Reddit call.
    // A 429 from the token endpoint is IP/edge-level load shedding returned
    // without looking at the Basic auth header (the same fact
    // `quotaMeansVerified: false` records for Reddit in
    // `src/lib/integrations/actions.ts`), so re-asking it does not become an
    // answer -- and every caller here already treats a missing token as
    // "fall back to the unauthenticated endpoint" rather than as a failure.
    // The host cooldown is still recorded, which is what protects the
    // unauthenticated calls that follow.
    const data = await fetchJsonThrottled<{ access_token?: string; expires_in?: number }>(
      "https://www.reddit.com/api/v1/access_token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": userAgent,
        },
        body: "grant_type=client_credentials",
        attempts: 1,
      },
    );

    if (!data?.access_token) return null;

    const token = data.access_token;
    const expiresIn = (data.expires_in || 3600) - 60;
    tokenCache.set(cacheKey, { token, expiresAt: Date.now() + expiresIn * 1000 });
    return token;
  } catch {
    return null;
  }
}
