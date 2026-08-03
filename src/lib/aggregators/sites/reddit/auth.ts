/**
 * Reddit authentication utilities.
 *
 * Ported from old/core/aggregators/reddit/auth.py.
 */

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

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

export async function getRedditAccessToken(
  clientId: string,
  clientSecret: string,
  userAgent = "Yana/1.0",
): Promise<string | null> {
  if (!clientId || !clientSecret) return null;

  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt) {
    return cachedAccessToken.token;
  }

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent,
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;

    const token = data.access_token;
    const expiresIn = (data.expires_in || 3600) - 60;
    cachedAccessToken = {
      token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    return token;
  } catch {
    return null;
  }
}
