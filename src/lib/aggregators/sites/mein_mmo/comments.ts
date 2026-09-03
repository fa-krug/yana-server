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
  _$: cheerio.CheerioAPI,
  labels: ChromeLabels,
): string | null {
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
    return null;
  }

  const commentText = textEl.html() || "";
  if (!commentText.trim()) {
    return null;
  }

  let anchorUrl = `${articleUrl}#comments`;
  const rightEl = commentEl.find("div.wpd-comment-right").first();
  if (rightEl.length > 0) {
    const commentId = rightEl.attr("id");
    if (commentId) {
      anchorUrl = `${articleUrl}#${commentId}`;
    }
  }

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
 * Extract wpDiscuz comments from a Mein-MMO article page.
 *
 * @param html - Full article page HTML
 * @param articleUrl - Article URL for building anchor links
 * @param maxComments - Maximum number of comments to extract
 * @param labels - Localized chrome labels (Comments, source)
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

  const thread = $("div.wpd-thread-list").first();
  if (thread.length === 0) {
    return null;
  }

  const comments = thread.find("div.wpd-comment");
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

  const commentsUrl = `${articleUrl}#comments`;
  const header = `<h3>${commentLink(commentsUrl, labels.comments)}</h3>`;
  return `<section>${header}${commentParts.join("")}</section>`;
}
