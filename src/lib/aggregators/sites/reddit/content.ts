/**
 * Reddit content building utilities.
 *
 * Ported from old/core/aggregators/reddit/content.py.
 */

import { ArticleSkipError } from "../../errors";
import { fetchPostComments, formatCommentHtml } from "./comments";
import { extractAnimatedGifUrl, extractGiphyGifUrl } from "./images";
import { convertRedditMarkdown, escapeHtml, safeImgHtml, safeLinkHtml } from "./markdown";
import { RedditComment, RedditGalleryItem, RedditPostData } from "./types";
import { decodeHtmlEntitiesInUrl, fixRedditMediaUrl } from "./urls";

export async function buildPostContent(
  post: RedditPostData,
  commentLimit: number,
  subreddit: string,
  userId?: number | string | null,
  isCrossPost = false,
  commentsList?: RedditComment[],
): Promise<string> {
  const contentParts: string[] = [];

  // 1. Selftext
  if (post.selftext) {
    const selftextHtml = convertRedditMarkdown(post.selftext);
    contentParts.push(`<div>${selftextHtml}</div>`);
  }

  // 2. Gallery media
  addGalleryMedia(post, contentParts);

  // 3. Link media
  addLinkMedia(post, contentParts, isCrossPost);

  // 4. Comments section
  await addCommentsSection(post, commentLimit, subreddit, userId, contentParts, commentsList);

  return contentParts.join("");
}

function processGalleryItem(item: RedditGalleryItem, post: RedditPostData): string | null {
  const mediaId = item.media_id;
  if (!mediaId || !post.media_metadata) return null;

  const mediaInfo = post.media_metadata[mediaId];
  if (!mediaInfo) return null;

  const isAnimated = mediaInfo.e === "AnimatedImage";
  let mediaUrl: string | null = null;
  if (isAnimated) {
    mediaUrl = mediaInfo.s?.gif || mediaInfo.s?.mp4 || null;
  } else if (mediaInfo.e === "Image") {
    mediaUrl = mediaInfo.s?.u || null;
  }

  if (!mediaUrl) return null;

  const fixedUrl = fixRedditMediaUrl(decodeHtmlEntitiesInUrl(mediaUrl));
  const caption = item.caption || "";
  const alt = caption || (isAnimated ? "Animated GIF" : "Gallery image");

  const imgHtml = safeImgHtml(fixedUrl, alt);
  if (!imgHtml) return null;

  if (caption) {
    return `<figure>${imgHtml}<figcaption>${escapeHtml(alt)}</figcaption></figure>`;
  }
  return `<p>${imgHtml}</p>`;
}

function addGalleryMedia(post: RedditPostData, contentParts: string[]): void {
  if (!post.is_gallery || !post.media_metadata || !post.gallery_data) {
    return;
  }

  const items = post.gallery_data.items || [];
  for (const item of items) {
    const html = processGalleryItem(item, post);
    if (html) {
      contentParts.push(html);
    }
  }
}

function addLinkMedia(post: RedditPostData, contentParts: string[], isCrossPost: boolean): void {
  if (!post.url || post.is_gallery) return;

  const url = decodeHtmlEntitiesInUrl(post.url);

  if (processLinkMedia(post, url, contentParts)) {
    return;
  }

  if (!isCrossPost && !post.is_self) {
    contentParts.push(`<p>${safeLinkHtml(url, url)}</p>`);
  }
}

function processLinkMedia(post: RedditPostData, url: string, contentParts: string[]): boolean {
  const urlLower = url.toLowerCase();

  const giphyUrl = extractGiphyGifUrl(url);
  if (giphyUrl) {
    const imgHtml = safeImgHtml(giphyUrl, "Giphy");
    if (imgHtml) contentParts.push(`<p>${imgHtml}</p>`);
    return true;
  }

  // GIF media
  if (urlLower.endsWith(".gif") || urlLower.endsWith(".gifv")) {
    const gifUrl =
      extractAnimatedGifUrl(post) || (urlLower.endsWith(".gifv") ? url.slice(0, -1) : url);
    const fixedUrl = fixRedditMediaUrl(gifUrl);
    const imgHtml = safeImgHtml(fixedUrl, "Animated GIF");
    if (imgHtml) {
      contentParts.push(`<p>${imgHtml}</p>`);
    }
    return true;
  }

  // Direct image media
  const isImage =
    [".jpg", ".jpeg", ".png", ".webp"].some((ext) => urlLower.includes(ext)) ||
    urlLower.includes("i.redd.it");
  if (isImage) {
    const fixedUrl = fixRedditMediaUrl(url);
    if (fixedUrl) {
      contentParts.push(`<p>${safeLinkHtml(fixedUrl, fixedUrl)}</p>`);
    }
    return true;
  }

  // Video media
  if (urlLower.includes("v.redd.it")) {
    return true;
  }

  if (urlLower.includes("youtube.com") || urlLower.includes("youtu.be")) {
    contentParts.push(`<p>${safeLinkHtml(url, "▶ View Video on YouTube")}</p>`);
    return true;
  }

  // Twitter/X links
  return urlLower.includes("twitter.com") || urlLower.includes("x.com");
}

async function addCommentsSection(
  post: RedditPostData,
  commentLimit: number,
  subreddit: string,
  userId: number | string | null | undefined,
  contentParts: string[],
  providedComments?: RedditComment[],
): Promise<void> {
  const decodedPermalink = decodeHtmlEntitiesInUrl(post.permalink);
  const permalink = `https://reddit.com${decodedPermalink}`;
  const commentSectionParts: string[] = [`<h3>${safeLinkHtml(permalink, "Comments")}</h3>`];

  if (commentLimit > 0) {
    try {
      const comments =
        providedComments !== undefined
          ? providedComments
          : await fetchPostComments(subreddit, post.id, commentLimit, userId);

      if (comments && comments.length > 0) {
        const commentHtmls = comments.map(formatCommentHtml);
        commentSectionParts.push(commentHtmls.join(""));
      } else {
        commentSectionParts.push("<p><em>No comments yet.</em></p>");
      }
    } catch (err) {
      // A 403/404 from the comments endpoint means the post itself is private,
      // removed or gone -- `fetchPostComments()` reports that as an
      // `ArticleSkipError` and the caller drops the article. Swallowing it here
      // would silently reinstate the bug that fix by degrading a skipped post
      // into one whose body says "Comments unavailable." Production always
      // pre-fetches (`aggregator.ts` passes `commentsList`), so this path is
      // reachable only from a future caller that does not -- which is exactly
      // when the guard has to already be here.
      if (err instanceof ArticleSkipError) throw err;
      commentSectionParts.push("<p><em>Comments unavailable.</em></p>");
    }
  } else {
    commentSectionParts.push("<p><em>Comments disabled.</em></p>");
  }

  contentParts.push(`<section>${commentSectionParts.join("")}</section>`);
}
