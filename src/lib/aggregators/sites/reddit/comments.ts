/**
 * Reddit comment utilities.
 *
 * Ported from old/core/aggregators/reddit/comments.py.
 */

import { convertRedditMarkdown, escapeHtml, safeLinkHtml } from "./markdown";
import { RedditComment } from "./types";

export function formatCommentHtml(comment: RedditComment): string {
  const author = comment.author || "[deleted]";
  const body = convertRedditMarkdown(comment.body || "");
  const commentUrl = `https://reddit.com${comment.permalink}`;

  return `\n<blockquote>\n<p><strong>${escapeHtml(author)}</strong> | ${safeLinkHtml(
    commentUrl,
    "source",
  )}</p>\n<div>${body}</div>\n</blockquote>\n`;
}

export function isBotAccount(author: string): boolean {
  if (!author) return false;
  const lower = author.toLowerCase();
  return (
    lower.endsWith("_bot") || lower.endsWith("-bot") || lower === "automoderator"
  );
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

  try {
    const url = accessToken
      ? `https://oauth.reddit.com/r/${subreddit || "all"}/comments/${postId}?sort=best&limit=${commentLimit}`
      : `https://www.reddit.com/r/${subreddit || "all"}/comments/${postId}.json?sort=best&limit=${commentLimit}`;

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

    if (!res.ok) return [];
    const data = (await res.json()) as any;
    if (!Array.isArray(data) || data.length < 2) return [];

    const commentListing = data[1]?.data?.children || [];
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
