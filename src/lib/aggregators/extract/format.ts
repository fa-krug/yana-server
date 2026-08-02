/**
 * Content formatting utilities.
 */

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

export function buildYoutubeFacadeHtml(videoId: string): string {
  return (
    `<div class="youtube-embed-container" ` +
    `data-embed="https://www.youtube.com/embed/${videoId}">` +
    `<a href="https://www.youtube.com/watch?v=${videoId}" ` +
    `target="_blank" rel="noopener">Watch on YouTube</a>` +
    `</div>`
  );
}

export function createYoutubeEmbedHtml(videoId: string, caption = ""): string {
  const facade = buildYoutubeFacadeHtml(videoId);
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
export function buildDailymotionFacadeHtml(videoId: string): string {
  return (
    `<div class="dailymotion-embed-container" ` +
    `data-embed="https://www.dailymotion.com/embed/video/${videoId}">` +
    `<a href="https://www.dailymotion.com/video/${videoId}" ` +
    `target="_blank" rel="noopener">Watch on Dailymotion</a>` +
    `</div>`
  );
}

/**
 * Build the article's lead-media header, or null when none can be rendered.
 */
export function buildHeaderHtml(
  headerImageUrl?: string | null,
  title = "",
  headerCaptionHtml?: string | null
): string | null {
  if (!headerImageUrl) {
    return null;
  }

  const youtubeVideoId = extractYoutubeVideoId(headerImageUrl);
  if (youtubeVideoId) {
    const youtubeEmbed = createYoutubeEmbedHtml(youtubeVideoId, headerCaptionHtml || "");
    return [
      '<header style="margin-bottom: 1.5em; text-align: center;">',
      youtubeEmbed,
      "</header>",
    ].join("\n");
  }

  if (isTwitterUrl(headerImageUrl)) {
    // Synchronously, without remote data fetch, Twitter embeds cannot be built
    return null;
  }

  const headerParts = [
    '<header style="margin-bottom: 1.5em; text-align: center;">',
    `<img src="${escapeHtml(headerImageUrl)}" alt="${escapeHtml(
      title
    )}" style="max-width: 100%; height: auto; border-radius: 8px;">`,
  ];
  if (headerCaptionHtml) {
    headerParts.push(headerCaptionHtml);
  }
  headerParts.push("</header>");
  return headerParts.join("\n");
}

/**
 * Format article content with an optional header, the main content, and optional comments.
 */
export function formatArticleContent(
  content: string,
  title: string,
  url: string,
  headerImageUrl?: string | null,
  headerCaptionHtml?: string | null,
  commentsContent?: string | null,
  headerHtml?: string | null
): string {
  const parts: string[] = [];

  const header =
    headerHtml !== undefined && headerHtml !== null
      ? headerHtml
      : buildHeaderHtml(headerImageUrl, title, headerCaptionHtml);

  if (header) {
    parts.push(header);
  }

  parts.push(`<section data-sanitized-class="article-content">${content}</section>`);

  if (commentsContent) {
    parts.push(
      `<section data-sanitized-class="article-comments">${commentsContent}</section>`
    );
  }

  return parts.join("\n\n");
}
