/**
 * Content formatting utilities.
 */

import type { ChromeLabels } from "../chrome-labels";

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function extractYoutubeVideoId(url: string): string | null {
  if (!url) {
    return null;
  }

  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]+)/,
    /youtube\.com\/watch\?.*v=([A-Za-z0-9_-]+)/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]+)/,
    /youtube\.com\/v\/([A-Za-z0-9_-]+)/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      const videoId = match[1];
      if (/^[A-Za-z0-9_-]+$/.test(videoId)) {
        return videoId;
      }
    }
  }

  return null;
}

export function buildYoutubeFacadeHtml(
  videoId: string,
  labels: ChromeLabels,
  thumbnailRef?: string | null,
): string {
  // facadeThumbnail() in blocks/parser.ts (and therefore articleBlocks.embedThumbnailRef,
  // served via /api/v1/images/:hash) reads this <img>'s src -- with no <img> here, every
  // YouTube-embedded video has no preview thumbnail at all.
  const thumbnailImg = thumbnailRef ? `<img src="${escapeHtml(thumbnailRef)}" alt="">` : "";
  return (
    `<div class="youtube-embed-container" ` +
    `data-embed="https://www.youtube.com/embed/${videoId}">` +
    thumbnailImg +
    `<a href="https://www.youtube.com/watch?v=${videoId}" ` +
    `target="_blank" rel="noopener">${labels.watchOnYoutube}</a>` +
    `</div>`
  );
}

export function createYoutubeEmbedHtml(
  videoId: string,
  labels: ChromeLabels,
  caption = "",
  thumbnailRef?: string | null,
): string {
  const facade = buildYoutubeFacadeHtml(videoId, labels, thumbnailRef);
  if (!caption) {
    return facade;
  }
  return facade.replace("</div>", `${caption}</div>`);
}

export function isTwitterUrl(url: string): boolean {
  if (!url) {
    return false;
  }
  const twitterDomains = ["twitter.com", "x.com", "mobile.twitter.com"];
  return twitterDomains.some((domain) => url.includes(domain));
}

export function extractTweetId(url: string): string | null {
  if (!url) {
    return null;
  }
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Build a click-through Dailymotion facade -- the markup the block parser reads.
 */
export function buildDailymotionFacadeHtml(
  videoId: string,
  labels: ChromeLabels,
  thumbnailRef?: string | null,
): string {
  const thumbnailImg = thumbnailRef ? `<img src="${escapeHtml(thumbnailRef)}" alt="">` : "";
  return (
    `<div class="dailymotion-embed-container" ` +
    `data-embed="https://www.dailymotion.com/embed/video/${videoId}">` +
    thumbnailImg +
    `<a href="https://www.dailymotion.com/video/${videoId}" ` +
    `target="_blank" rel="noopener">${labels.watchOnDailymotion}</a>` +
    `</div>`
  );
}

/**
 * Build the article's lead-media header, or null when none can be rendered.
 */
export function buildHeaderHtml(
  labels: ChromeLabels,
  headerImageUrl?: string | null,
  title = "",
  headerCaptionHtml?: string | null,
  youtubeThumbnailRef?: string | null,
): string | null {
  if (!headerImageUrl) {
    return null;
  }

  const youtubeVideoId = extractYoutubeVideoId(headerImageUrl);
  if (youtubeVideoId) {
    const youtubeEmbed = createYoutubeEmbedHtml(
      youtubeVideoId,
      labels,
      headerCaptionHtml || "",
      youtubeThumbnailRef,
    );
    return [
      '<header class="media-header" style="margin-bottom: 1.5em; text-align: center;">',
      youtubeEmbed,
      "</header>",
    ].join("\n");
  }

  if (isTwitterUrl(headerImageUrl)) {
    // Synchronously, without remote data fetch, Twitter embeds cannot be built
    return null;
  }

  const headerParts = [
    // `media-header` marks this as the article's real lead image for
    // blocks/parser.ts's headerBlocks(): without it, a generic `<header>` is
    // treated as decorative chrome (byline, date, site logo) and its images
    // are dropped -- which silently stripped the header image from every
    // FullWebsiteAggregator-based site's reading view.
    '<header class="media-header" style="margin-bottom: 1.5em; text-align: center;">',
    `<img src="${escapeHtml(headerImageUrl)}" alt="${escapeHtml(
      title,
    )}" style="max-width: 100%; height: auto; border-radius: 8px;">`,
  ];
  if (headerCaptionHtml) {
    headerParts.push(headerCaptionHtml);
  }
  headerParts.push("</header>");
  return headerParts.join("\n");
}

/**
 * The `data-sanitized-class` values on the two wrappers this module builds.
 *
 * **`ARTICLE_COMMENTS_CLASS` is imported by the source fingerprint**
 * (`../source-fingerprint`), which strips that section so a new comment does
 * not count as the article changing. The wrapper is written here and read
 * there, and nothing but this constant ties the two together: renaming the
 * value in a template literal would silently stop the stripping, and every
 * commented article would start rewriting itself on every cycle again.
 */
export const ARTICLE_CONTENT_CLASS = "article-content";
export const ARTICLE_COMMENTS_CLASS = "article-comments";

/**
 * Format article content with an optional header, the main content, and optional comments.
 */
export function formatArticleContent(
  content: string,
  title: string,
  url: string,
  labels: ChromeLabels,
  headerImageUrl?: string | null,
  headerCaptionHtml?: string | null,
  commentsContent?: string | null,
  headerHtml?: string | null,
): string {
  const parts: string[] = [];

  const header =
    headerHtml !== undefined && headerHtml !== null
      ? headerHtml
      : buildHeaderHtml(labels, headerImageUrl, title, headerCaptionHtml);

  if (header) {
    parts.push(header);
  }

  parts.push(`<section data-sanitized-class="${ARTICLE_CONTENT_CLASS}">${content}</section>`);

  if (commentsContent) {
    parts.push(
      `<section data-sanitized-class="${ARTICLE_COMMENTS_CLASS}">${commentsContent}</section>`,
    );
  }

  return parts.join("\n\n");
}
