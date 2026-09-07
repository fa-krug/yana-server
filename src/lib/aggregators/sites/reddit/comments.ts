/**
 * Reddit comment utilities.
 *
 * Ported from old/core/aggregators/reddit/comments.py.
 */

import { ArticleSkipError } from "../../errors";
import { fetchTextThrottled } from "../../http/throttled-fetch";
import type { ChromeLabels } from "../../chrome-labels";
import { convertRedditMarkdown, escapeHtml, safeLinkHtml } from "./markdown";
import { RedditComment, RedditCommentRaw, RedditListing, RedditPostRaw } from "./types";

/** `/comments/{postId}.json?...` always answers `[postListing, commentsListing]`. */
type RedditCommentsPageResponse = [
  RedditListing<"t3", RedditPostRaw>,
  RedditListing<string, RedditCommentRaw>,
];

export function formatCommentHtml(comment: RedditComment, labels: ChromeLabels): string {
  const author = comment.author || "[deleted]";
  const body = convertRedditMarkdown(comment.body || "");
  const commentUrl = `https://reddit.com${comment.permalink}`;

  return `\n<blockquote>\n<p><strong>${escapeHtml(author)}</strong> | ${safeLinkHtml(
    commentUrl,
    labels.source,
  )}</p>\n<div>${body}</div>\n</blockquote>\n`;
}

export function isBotAccount(author: string): boolean {
  if (!author) return false;
  const lower = author.toLowerCase();
  return lower.endsWith("_bot") || lower.endsWith("-bot") || lower === "automoderator";
}

export function isValidComment(comment: RedditComment): boolean {
  if (!comment.body || comment.body === "[deleted]" || comment.body === "[removed]") {
    return false;
  }
  return Boolean(comment.author) && !isBotAccount(comment.author);
}

export async function fetchPostComments(
  subreddit: string,
  postId: string,
  commentLimit: number,
  _userId?: number | string | null,
  accessToken?: string | null,
): Promise<RedditComment[]> {
  if (!postId || commentLimit <= 0) return [];

  const url = accessToken
    ? `https://oauth.reddit.com/r/${subreddit || "all"}/comments/${postId}?sort=best&limit=${commentLimit}`
    : `https://www.reddit.com/r/${subreddit || "all"}/comments/${postId}.json?sort=best&limit=${commentLimit}`;

  const headers: Record<string, string> = { "User-Agent": "Yana/1.0" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const res = await fetchTextThrottled(url, { headers });
  if (!res) return [];

  if (res.status === 403) {
    throw new ArticleSkipError("Post is private or removed", 403);
  }
  if (res.status === 404) {
    throw new ArticleSkipError("Post not found", 404);
  }
  if (res.status === 429) {
    // Logged rather than swallowed. This runs once per article under
    // `feed.concurrency`, and Reddit's limits are far tighter than a
    // website's -- so a throttled run used to return `[]` here and ship the
    // article with a silently empty comment section, indistinguishable from
    // a post that genuinely had no comments. `fetchTextThrottled()` has
    // already retried and recorded the host cooldown by this point, so
    // reaching here means Reddit refused every attempt.
    console.warn(`[reddit] rate limited fetching comments for ${subreddit}/${postId}`);
    return [];
  }
  if (!res.ok) return [];

  try {
    const data: unknown = JSON.parse(res.body);
    if (!Array.isArray(data) || data.length < 2) return [];

    const [, commentsListing] = data as RedditCommentsPageResponse;
    const commentListing = commentsListing?.data?.children || [];
    const comments: RedditComment[] = [];

    for (const item of commentListing) {
      if (item.kind === "t1" && item.data) {
        comments.push(new RedditComment(item.data));
      }
    }

    const filtered = comments.filter(isValidComment);
    filtered.sort((a, b) => (b.score || 0) - (a.score || 0));
    return filtered.slice(0, commentLimit);
  } catch {
    return [];
  }
}
