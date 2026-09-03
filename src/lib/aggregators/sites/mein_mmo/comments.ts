import * as cheerio from "cheerio";
import type { ChromeLabels } from "../../chrome-labels";
import { buildCommentsSection, type CommentSpec } from "../../comments/section";

/** One already-extracted Mein-MMO comment -- see `extractComments()`'s
 * `list()` for how these are read off the DOM. */
interface WpdCommentItem {
  author: string;
  timestamp: string;
  bodyHtml: string;
  anchorUrl: string;
}

/**
 * Extract wpDiscuz comments from a Mein-MMO article page.
 *
 * @param html - Full article page HTML
 * @param articleUrl - Article URL for building anchor links
 * @param maxComments - Maximum number of comments to extract
 * @param labels - Localized chrome labels (Comments, source)
 * @param onLog - Forwarded to the shared builder so a selector-extraction
 *   failure is logged to the triggering job's own output rather than
 *   swallowed silently -- see `buildCommentsSection()`'s doc comment.
 * @returns HTML string with formatted comments, or null if no comments found
 */
export function extractComments(
  html: string,
  articleUrl: string,
  maxComments: number,
  labels: ChromeLabels,
  onLog?: (message: string) => void,
): string | null {
  if (maxComments <= 0) {
    return null;
  }

  const spec: CommentSpec<string, WpdCommentItem> = {
    list: (source) => {
      const $ = cheerio.load(source);

      const thread = $("div.wpd-thread-list").first();
      if (thread.length === 0) {
        return [];
      }

      const comments = thread.find("div.wpd-comment");
      // Sliced to `maxComments` *before* filtering out comments with no body
      // below -- matching the previous implementation, which only ever
      // considered the first `maxComments` raw elements and could therefore
      // end up with fewer than `maxComments` items in the output.
      const limit = Math.min(comments.length, maxComments);
      const items: WpdCommentItem[] = [];

      for (let i = 0; i < limit; i++) {
        const commentEl = $(comments.get(i)!);

        let author = labels.unknownAuthor;
        const authorEl = commentEl.find("div.wpd-comment-author").first();
        if (authorEl.length > 0) {
          const link = authorEl.find("a").first();
          const text = link.length > 0 ? link.text().trim() : authorEl.text().trim();
          if (text) {
            author = text;
          }
        }

        let timestamp = "";
        const dateEl = commentEl.find("div.wpd-comment-date").first();
        if (dateEl.length > 0) {
          const titleAttr = dateEl.attr("title");
          timestamp = titleAttr ? titleAttr.trim() : dateEl.text().trim();
        }

        const textEl = commentEl.find("div.wpd-comment-text").first();
        if (textEl.length === 0) {
          continue;
        }

        const bodyHtml = textEl.html() || "";
        if (!bodyHtml.trim()) {
          continue;
        }

        let anchorUrl = `${articleUrl}#comments`;
        const rightEl = commentEl.find("div.wpd-comment-right").first();
        if (rightEl.length > 0) {
          const commentId = rightEl.attr("id");
          if (commentId) {
            anchorUrl = `${articleUrl}#${commentId}`;
          }
        }

        items.push({ author, timestamp, bodyHtml, anchorUrl });
      }

      return items;
    },
    author: (c) => c.author,
    timestamp: (c) => c.timestamp,
    bodyHtml: (c) => c.bodyHtml,
    anchorUrl: (c) => c.anchorUrl,
    wrapTag: "section",
  };

  return buildCommentsSection(spec, html, `${articleUrl}#comments`, maxComments, labels, onLog);
}
