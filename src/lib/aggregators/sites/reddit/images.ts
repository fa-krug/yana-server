/**
 * Reddit image extraction utilities.
 *
 * Ported from old/core/aggregators/reddit/images.py.
 */

import { extractYoutubeVideoId, isTwitterUrl } from "../../extract/format";
import { extractImages, getOverrideImageUrl } from "../../images/extractor";
import { RedditPostData } from "./types";
import { decodeHtmlEntitiesInUrl, extractUrlsFromText, fixRedditMediaUrl } from "./urls";

export function extractThumbnailUrl(post: RedditPostData): string | null {
  try {
    // Priority 1: Try preview images (high-resolution source)
    const images = post.preview?.images;
    if (images && images.length > 0) {
      const sourceUrl = images[0]?.source?.url;
      if (sourceUrl) {
        const decoded = decodeHtmlEntitiesInUrl(sourceUrl);
        return fixRedditMediaUrl(decoded);
      }
    }

    // Priority 2: Try post URL if it's an image
    if (post.url) {
      const decodedUrl = decodeHtmlEntitiesInUrl(post.url);
      const urlLower = decodedUrl.toLowerCase();
      if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].some((ext) => urlLower.endsWith(ext))) {
        return decodedUrl;
      }
      if (urlLower.includes("v.redd.it")) {
        return extractRedditVideoPreview(post);
      }
    }

    // Priority 3: Fall back to post thumbnail property
    if (post.thumbnail && !["self", "default", "nsfw", "spoiler"].includes(post.thumbnail)) {
      if (post.thumbnail.startsWith("http")) {
        return decodeHtmlEntitiesInUrl(post.thumbnail);
      }
      if (post.thumbnail.startsWith("/")) {
        return decodeHtmlEntitiesInUrl(`https://reddit.com${post.thumbnail}`);
      }
    }

    return null;
  } catch {
    return null;
  }
}

export function extractRedditVideoPreview(post: RedditPostData): string | null {
  try {
    const images = post.preview?.images;
    if (!images || images.length === 0) return null;
    const sourceUrl = images[0]?.source?.url;
    if (!sourceUrl) return null;
    const decoded = decodeHtmlEntitiesInUrl(sourceUrl);
    return fixRedditMediaUrl(decoded);
  } catch {
    return null;
  }
}

export function extractAnimatedGifUrl(post: RedditPostData): string | null {
  try {
    const images = post.preview?.images;
    if (!images || images.length === 0) return null;

    const imageData = images[0];
    const variants = imageData?.variants;

    if (variants?.gif?.source?.url) {
      const decoded = decodeHtmlEntitiesInUrl(variants.gif.source.url);
      return fixRedditMediaUrl(decoded);
    }

    if (variants?.mp4?.source?.url) {
      const decoded = decodeHtmlEntitiesInUrl(variants.mp4.source.url);
      return fixRedditMediaUrl(decoded);
    }

    return null;
  } catch {
    return null;
  }
}

export async function extractHeaderImageUrl(post: RedditPostData): Promise<string | null> {
  try {
    // Priority -1: domain image overrides take precedence over everything else.
    if (post.url) {
      const overrideUrl = getOverrideImageUrl(decodeHtmlEntitiesInUrl(post.url));
      if (overrideUrl) return overrideUrl;
    }

    // Priority 0: Check for video embeds (YouTube / v.redd.it)
    const videoUrl = extractVideoEmbedUrl(post);
    if (videoUrl && !videoUrl.includes("vxreddit.com")) {
      return videoUrl;
    }

    // Priority 0.5: Twitter/X link posts
    if (post.url && isTwitterUrl(post.url)) {
      return decodeHtmlEntitiesInUrl(post.url);
    }

    // Priority 0.6: Twitter/X in selftext
    if (post.is_self && post.selftext) {
      const selftextUrls = extractUrlsFromText(post.selftext);
      for (const url of selftextUrls) {
        if (isTwitterUrl(url)) {
          return decodeHtmlEntitiesInUrl(url);
        }
      }
    }

    // Priority 1: Gallery posts
    const galleryUrl = extractGalleryImageUrl(post);
    if (galleryUrl) {
      return galleryUrl;
    }

    // Priority 2: Direct image posts
    if (post.url) {
      const decodedUrl = decodeHtmlEntitiesInUrl(post.url);
      const urlLower = decodedUrl.toLowerCase();

      if (!isRedditCommentsUrl(decodedUrl)) {
        const isDirectImage =
          [".jpg", ".jpeg", ".png", ".webp", ".gif", ".gifv"].some((ext) =>
            urlLower.includes(ext),
          ) ||
          urlLower.includes("i.redd.it") ||
          (urlLower.includes("preview.redd.it") && urlLower.includes(".gif"));

        if (isDirectImage) {
          return decodedUrl;
        }
      }
    }

    // Priority 3: extract an image URL from selftext, or scrape its first link's page.
    const selftextImage = await extractImageUrlFromSelftext(post);
    if (selftextImage) {
      return selftextImage;
    }

    // Priority 4: Thumbnail fallback
    const thumbnailUrl = extractThumbnailUrl(post);
    if (thumbnailUrl) {
      if (post.url && post.url.includes("v.redd.it")) {
        const previewUrl = extractRedditVideoPreview(post);
        if (previewUrl) return previewUrl;
      }
      return thumbnailUrl;
    }

    // Priority 5: link post with no Reddit-supplied image -- scrape the linked page's og:image.
    if (post.url && !post.is_self) {
      const decodedUrl = decodeHtmlEntitiesInUrl(post.url);
      if (!isRedditCommentsUrl(decodedUrl)) {
        const pageImage = await extractImages(decodedUrl, true);
        if (pageImage?.imageUrl) return pageImage.imageUrl;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** True for a Reddit post permalink -- an internal link, never a header image. */
function isRedditCommentsUrl(url: string): boolean {
  return /https?:\/\/[^\s]*reddit\.com\/r\/[^/\s]+\/comments\/[a-zA-Z0-9]+\/[^/\s]+\/?$/i.test(url);
}

function extractVideoEmbedUrl(post: RedditPostData): string | null {
  if (post.url) {
    const decodedUrl = decodeHtmlEntitiesInUrl(post.url);

    if (decodedUrl.includes("v.redd.it")) {
      const decodedPermalink = decodeHtmlEntitiesInUrl(post.permalink);
      const normalizedPermalink = decodedPermalink.replace(/\/$/, "");
      return `https://vxreddit.com${normalizedPermalink}`;
    }

    if (extractYoutubeVideoId(decodedUrl)) {
      return decodedUrl;
    }
  }

  if (post.is_self && post.selftext) {
    const urls = extractUrlsFromText(post.selftext);
    for (const url of urls) {
      if (url.includes("v.redd.it")) {
        const decodedPermalink = decodeHtmlEntitiesInUrl(post.permalink);
        const normalizedPermalink = decodedPermalink.replace(/\/$/, "");
        return `https://vxreddit.com${normalizedPermalink}`;
      }
      if (extractYoutubeVideoId(url)) {
        return url;
      }
    }
  }

  return null;
}

function extractGalleryImageUrl(post: RedditPostData): string | null {
  if (!post.is_gallery || !post.media_metadata || !post.gallery_data) {
    return null;
  }

  const items = post.gallery_data.items || [];
  if (items.length === 0) return null;

  const mediaId = items[0]?.media_id;
  if (!mediaId) return null;

  const mediaInfo = post.media_metadata[mediaId];
  if (!mediaInfo) return null;

  if (mediaInfo.e === "AnimatedImage") {
    const animatedUrl = mediaInfo.s?.gif || mediaInfo.s?.mp4;
    if (animatedUrl) {
      return fixRedditMediaUrl(decodeHtmlEntitiesInUrl(animatedUrl));
    }
  }

  if (mediaInfo.e === "Image" && mediaInfo.s?.u) {
    return fixRedditMediaUrl(decodeHtmlEntitiesInUrl(mediaInfo.s.u));
  }

  return null;
}

async function extractImageUrlFromSelftext(post: RedditPostData): Promise<string | null> {
  if (!post.is_self || !post.selftext) return null;

  let selftextToProcess = post.selftext;
  const commentUrlMatch = selftextToProcess.match(
    /https?:\/\/[^\s]*\/comments\/[a-zA-Z0-9]+\/[^/\s]+\/[a-zA-Z0-9]+/,
  );
  if (commentUrlMatch && commentUrlMatch.index !== undefined) {
    selftextToProcess = selftextToProcess.slice(0, commentUrlMatch.index);
  }

  const urls = extractUrlsFromText(selftextToProcess);
  if (urls.length === 0) return null;

  let firstLink: string | null = null;
  for (const url of urls) {
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    const urlLower = url.toLowerCase();
    if (
      urlLower.includes("preview.redd.it") ||
      [".jpg", ".jpeg", ".png", ".webp", ".gif"].some((ext) => urlLower.includes(ext))
    ) {
      return url;
    }
    if (firstLink === null && !isTwitterUrl(url)) {
      firstLink = url;
    }
  }

  if (firstLink) {
    const pageImage = await extractImages(firstLink, true);
    if (pageImage?.imageUrl) return pageImage.imageUrl;
  }

  return null;
}
