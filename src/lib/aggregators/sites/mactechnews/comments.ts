import * as cheerio from "cheerio";
import type { ChromeLabels } from "../../chrome-labels";
import { buildCommentsSection, type CommentSpec } from "../../comments/section";

/** One already-extracted MacTechNews comment -- see `extractComments()`'s
 * `list()` for how these are read off the DOM. */
interface MtnCommentItem {
  author: string;
  timestamp: string;
  bodyHtml: string;
  anchorUrl: string;
}

/**
 * Extract comments from MacTechNews article HTML.
 *
 * Comments are found within div.MtnCommentScroll containers. Each comment
 * has author name, timestamp, and text content.
 *
 * @param html - Full article HTML
 * @param articleUrl - Article URL for building anchor links
 * @param maxComments - Maximum number of comments to extract
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

  const spec: CommentSpec<string, MtnCommentItem> = {
    list: (source) => {
      const $ = cheerio.load(source);

      const commentScroll = $("div.MtnCommentScroll").first();
      if (commentScroll.length === 0) {
        return [];
      }

      const comments = commentScroll.find("div.MtnComment");
      // Sliced to `maxComments` *before* filtering out comments with no body
      // below -- matching the previous implementation, which only ever
      // considered the first `maxComments` raw elements and could therefore
      // end up with fewer than `maxComments` items in the output.
      const limit = Math.min(comments.length, maxComments);
      const items: MtnCommentItem[] = [];

      for (let i = 0; i < limit; i++) {
        const commentEl = $(comments.get(i)!);

        const authorEl = commentEl.find("span.MtnCommentAccountName").first();
        const author = authorEl.length > 0 ? authorEl.text().trim() : labels.unknownAuthor;

        const timeEl = commentEl.find("span.MtnCommentTime").first();
        let timestamp = "";
        if (timeEl.length > 0) {
          const timeSpans = timeEl.find("span");
          if (timeSpans.length > 0) {
            const parts: string[] = [];
            timeSpans.each((_, span) => {
              parts.push($(span).text().trim());
            });
            timestamp = parts.join(" ");
          }
        }

        const textEl = commentEl.find("div.MtnCommentText").first();
        if (textEl.length === 0) {
          continue;
        }

        const commentId = commentEl.attr("id") || "";
        const anchorUrl = commentId ? `${articleUrl}#${commentId}` : `${articleUrl}#comments`;

        items.push({ author, timestamp, bodyHtml: $.html(textEl), anchorUrl });
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
