import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { isSafeUrl } from "../../blocks/parser";
import { sanitizeUntrustedFragment } from "../../extract/clean";
import { escapeHtml } from "../../extract/format";
import type { ChromeLabels } from "../../chrome-labels";

function commentLink(url: string, label: string): string {
  if (isSafeUrl(url)) {
    return `<a href="${escapeHtml(url)}">${label}</a>`;
  }
  return label;
}

function processComment(
  commentEl: cheerio.Cheerio<Element>,
  articleUrl: string,
  $: cheerio.CheerioAPI,
  labels: ChromeLabels,
): string | null {
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
    return null;
  }

  const commentText = $.html(textEl);
  const commentId = commentEl.attr("id") || "";
  const anchorUrl = commentId ? `${articleUrl}#${commentId}` : `${articleUrl}#comments`;
  const tsDisplay = timestamp ? ` (${escapeHtml(timestamp)})` : "";

  return (
    `<blockquote>` +
    `<p><strong>${escapeHtml(author)}</strong>${tsDisplay} | ` +
    `${commentLink(anchorUrl, labels.source)}</p>` +
    `<div>${sanitizeUntrustedFragment(commentText)}</div>` +
    `</blockquote>`
  );
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
 * @returns HTML string with formatted comments, or null if no comments found
 */
export function extractComments(
  html: string,
  articleUrl: string,
  maxComments: number,
  labels: ChromeLabels,
): string | null {
  if (maxComments <= 0) {
    return null;
  }

  const $ = cheerio.load(html);

  // Find the comments container
  const commentScroll = $("div.MtnCommentScroll").first();
  if (commentScroll.length === 0) {
    return null;
  }

  // Find individual comments
  const comments = commentScroll.find("div.MtnComment");
  if (comments.length === 0) {
    return null;
  }

  const commentParts: string[] = [];
  const limit = Math.min(comments.length, maxComments);

  for (let i = 0; i < limit; i++) {
    const commentEl = $(comments.get(i)!);
    const commentHtml = processComment(commentEl, articleUrl, $, labels);
    if (commentHtml) {
      commentParts.push(commentHtml);
    }
  }

  if (commentParts.length === 0) {
    return null;
  }

  // Build comments section with header
  const commentsUrl = `${articleUrl}#comments`;
  const header = `<h3>${commentLink(commentsUrl, labels.comments)}</h3>`;
  return `<section>${header}${commentParts.join("")}</section>`;
}
