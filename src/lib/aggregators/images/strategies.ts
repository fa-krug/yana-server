import type * as cheerio from "cheerio";
import { fetchSingleImage, type FetchedImageResult } from "./fetcher";

export interface ImageExtractionContext {
  url: string;
  isHeaderImage?: boolean;
  $?: cheerio.CheerioAPI;
}

export interface FetchedImageResultWithUrl extends FetchedImageResult {
  imageUrl: string;
}

export interface ImageStrategy {
  canHandle(context: ImageExtractionContext): boolean;
  extract(context: ImageExtractionContext): Promise<FetchedImageResultWithUrl | null>;
}

export function extractYoutubeVideoId(url: string): string | null {
  if (!url) return null;
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]+)/,
    /youtube\.com\/watch\?.*v=([A-Za-z0-9_-]+)/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]+)/,
    /youtube\.com\/v\/([A-Za-z0-9_-]+)/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(url);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

export function getYoutubeThumbnailUrl(videoId: string, quality = "maxresdefault"): string {
  return `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
}

export function isTwitterUrl(url: string): boolean {
  if (!url) return false;
  const twitterDomains = ["twitter.com", "x.com", "mobile.twitter.com"];
  return twitterDomains.some((domain) => url.includes(domain));
}

export function extractTweetId(url: string): string | null {
  if (!url) return null;
  const match = /\/status\/(\d+)/.exec(url);
  return match ? match[1] : null;
}

export async function fetchTweetData(
  tweetId: string,
  timeoutMs = 10000,
): Promise<Record<string, any> | null> {
  if (!tweetId) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`https://api.fxtwitter.com/status/${tweetId}`, {
      headers: { "User-Agent": "Yana/1.0" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, any>;
  } catch {
    return null;
  }
}

export function getFirstTweetImage(data: Record<string, any>): string | null {
  if (!data) return null;
  try {
    const tweet = data.tweet || {};
    const media = tweet.media || {};

    if (Array.isArray(media.photos)) {
      for (const photo of media.photos) {
        if (photo && typeof photo.url === "string") {
          return photo.url;
        }
      }
    }

    if (Array.isArray(media.all)) {
      for (const item of media.all) {
        if (item && item.type === "photo" && typeof item.url === "string") {
          return item.url;
        }
      }
    }

    const article = tweet.article || {};
    const coverMedia = article.cover_media || {};
    const mediaInfo = coverMedia.media_info || {};
    if (typeof mediaInfo.original_img_url === "string") {
      return mediaInfo.original_img_url;
    }
  } catch {}
  return null;
}

function resolveUrl(relativeUrl: string, baseUrl: string): string {
  if (!relativeUrl) return "";
  if (relativeUrl.startsWith("http://") || relativeUrl.startsWith("https://")) {
    return relativeUrl;
  }
  try {
    return new URL(relativeUrl, baseUrl).toString();
  } catch {
    return relativeUrl;
  }
}

export class DirectImageStrategy implements ImageStrategy {
  private static EXTENSIONS = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
    ".svg",
    ".ico",
  ]);

  canHandle(context: ImageExtractionContext): boolean {
    try {
      const pathname = new URL(context.url).pathname.toLowerCase();
      return Array.from(DirectImageStrategy.EXTENSIONS).some((ext) => pathname.endsWith(ext));
    } catch {
      return false;
    }
  }

  async extract(context: ImageExtractionContext): Promise<FetchedImageResultWithUrl | null> {
    const res = await fetchSingleImage(context.url);
    if (res) {
      return { ...res, imageUrl: context.url };
    }
    return null;
  }
}

export class YouTubeThumbnailStrategy implements ImageStrategy {
  canHandle(context: ImageExtractionContext): boolean {
    return extractYoutubeVideoId(context.url) !== null;
  }

  async extract(context: ImageExtractionContext): Promise<FetchedImageResultWithUrl | null> {
    const videoId = extractYoutubeVideoId(context.url);
    if (!videoId) return null;

    for (const quality of ["maxresdefault", "hqdefault"]) {
      const thumbnailUrl = getYoutubeThumbnailUrl(videoId, quality);
      const res = await fetchSingleImage(thumbnailUrl);
      if (res) {
        return { ...res, imageUrl: thumbnailUrl };
      }
    }
    return null;
  }
}

export class TwitterImageStrategy implements ImageStrategy {
  canHandle(context: ImageExtractionContext): boolean {
    return isTwitterUrl(context.url);
  }

  async extract(context: ImageExtractionContext): Promise<FetchedImageResultWithUrl | null> {
    const tweetId = extractTweetId(context.url);
    if (!tweetId) return null;

    const tweetData = await fetchTweetData(tweetId);
    if (!tweetData) return null;

    const imageUrl = getFirstTweetImage(tweetData);
    if (!imageUrl) return null;

    const res = await fetchSingleImage(imageUrl);
    if (res) {
      return { ...res, imageUrl };
    }
    return null;
  }
}

export class MetaTagImageStrategy implements ImageStrategy {
  canHandle(context: ImageExtractionContext): boolean {
    return context.$ !== undefined;
  }

  async extract(context: ImageExtractionContext): Promise<FetchedImageResultWithUrl | null> {
    if (!context.$) return null;
    const $ = context.$;

    let imageUrl: string | null = null;
    const ogImage = $('meta[property="og:image"]').attr("content");
    if (ogImage) {
      imageUrl = ogImage;
    }

    if (!imageUrl) {
      const twitterImage = $('meta[name="twitter:image"]').attr("content");
      if (twitterImage) {
        imageUrl = twitterImage;
      }
    }

    if (!imageUrl) return null;

    const resolved = resolveUrl(imageUrl, context.url);
    if (!resolved) return null;

    const res = await fetchSingleImage(resolved);
    if (res) {
      return { ...res, imageUrl: resolved };
    }
    return null;
  }
}

export class PageImagesStrategy implements ImageStrategy {
  private static MIN_IMAGE_SIZE = 100;
  private static MIN_HEADER_IMAGE_SIZE = 200;

  canHandle(context: ImageExtractionContext): boolean {
    return context.$ !== undefined;
  }

  async extract(context: ImageExtractionContext): Promise<FetchedImageResultWithUrl | null> {
    if (!context.$) return null;
    const $ = context.$;

    const imgElements = $("img").slice(0, 20).toArray();
    if (imgElements.length === 0) return null;

    const minSize = context.isHeaderImage
      ? PageImagesStrategy.MIN_HEADER_IMAGE_SIZE
      : PageImagesStrategy.MIN_IMAGE_SIZE;

    for (const el of imgElements) {
      const rawSrc = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-lazy-src");
      if (!rawSrc) continue;

      const resolved = resolveUrl(rawSrc, context.url);
      if (!resolved) continue;

      const widthAttr = this.parseDimension($(el).attr("width"));
      const heightAttr = this.parseDimension($(el).attr("height"));

      if (widthAttr && heightAttr && (widthAttr < minSize || heightAttr < minSize)) {
        continue;
      }

      const res = await fetchSingleImage(resolved);
      if (res) {
        return { ...res, imageUrl: resolved };
      }
    }

    return null;
  }

  private parseDimension(val?: string): number | null {
    if (!val) return null;
    const clean = val.replace("px", "").trim();
    const parsed = parseInt(clean, 10);
    return isNaN(parsed) ? null : parsed;
  }
}
