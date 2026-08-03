/**
 * Reddit post fetching utilities.
 *
 * Ported from old/core/aggregators/reddit/posts.py.
 */

import { RedditPostData } from "./types";

export async function fetchRedditPost(
  subreddit: string,
  postId: string,
  _userId?: number | string | null,
  accessToken?: string | null,
): Promise<RedditPostData | null> {
  if (!postId) return null;

  try {
    const url = accessToken
      ? `https://oauth.reddit.com/r/${subreddit || "all"}/comments/${postId}`
      : `https://www.reddit.com/r/${subreddit || "all"}/comments/${postId}.json`;

    const headers: Record<string, string> = {
      "User-Agent": "Yana/1.0",
    };
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as any;

    let postDict: Record<string, any> | null = null;
    if (Array.isArray(data) && data.length > 0 && data[0]?.data?.children?.[0]?.data) {
      postDict = data[0].data.children[0].data;
    } else if (data?.data?.children?.[0]?.data) {
      postDict = data.data.children[0].data;
    }

    if (!postDict) return null;
    return new RedditPostData(postDict);
  } catch {
    return null;
  }
}
