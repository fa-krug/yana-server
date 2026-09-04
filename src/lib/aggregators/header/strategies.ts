import { ArticleSkipError } from "../errors";
import { ImageExtractor } from "../images/extractor";
import { fetchSingleImage } from "../images/fetcher";
import { storeImageBytes } from "../images/store";
import { thumbnailUrlFor, youtubeIdFrom } from "../embeds/youtube-url";
import type { HeaderElementContext, HeaderElementData } from "./context";

export interface HeaderElementStrategy {
  canHandle(url: string): boolean;
  create(context: HeaderElementContext): Promise<HeaderElementData | null>;
}

export function isRedditEmbedUrl(url: string): boolean {
  if (!url) return false;
  return (
    url.includes("vxreddit.com") ||
    (url.includes("/embed") && (url.includes("reddit.com") || url.includes("v.redd.it")))
  );
}

export function extractPostInfoFromUrl(url: string): {
  subreddit: string | null;
  postId: string | null;
} {
  if (!url) return { subreddit: null, postId: null };
  const match = /\/r\/(\w+)\/comments\/([a-zA-Z0-9]+)/.exec(url);
  if (match) {
    return { subreddit: match[1], postId: match[2] };
  }
  return { subreddit: null, postId: null };
}

export function fixRedditMediaUrl(url: string): string {
  if (!url) return url;
  return url.replace(/&amp;/g, "&");
}

export async function fetchSubredditIcon(subreddit: string): Promise<string | null> {
  if (!subreddit) return null;
  try {
    const res = await fetch(`https://www.reddit.com/r/${subreddit}/about.json`, {
      headers: { "User-Agent": "Yana/1.0" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: {
        icon_img?: string;
        community_icon?: string;
        header_img?: string;
      };
    };
    const rawUrl = data?.data?.icon_img || data?.data?.community_icon || data?.data?.header_img;
    if (!rawUrl) return null;
    return fixRedditMediaUrl(rawUrl);
  } catch {
    return null;
  }
}

export class RedditPostStrategy implements HeaderElementStrategy {
  canHandle(url: string): boolean {
    if (isRedditEmbedUrl(url)) return false;
    const postInfo = extractPostInfoFromUrl(url);
    return postInfo.subreddit !== null;
  }

  async create(context: HeaderElementContext): Promise<HeaderElementData | null> {
    try {
      const postInfo = extractPostInfoFromUrl(context.url);
      const subreddit = postInfo.subreddit;
      if (!subreddit) return null;

      const iconUrl = await fetchSubredditIcon(subreddit);
      if (!iconUrl) return null;

      const imageResult = await fetchSingleImage(iconUrl);
      if (!imageResult) return null;

      const contentHash = await storeImageBytes(imageResult.imageData, imageResult.contentType);
      if (!contentHash) return null;

      return {
        imageBytes: imageResult.imageData,
        contentType: imageResult.contentType,
        contentHash,
      };
    } catch (e) {
      if (e instanceof ArticleSkipError) throw e;
      return null;
    }
  }
}

export class YouTubeStrategy implements HeaderElementStrategy {
  canHandle(url: string): boolean {
    return youtubeIdFrom(url) !== null;
  }

  async create(context: HeaderElementContext): Promise<HeaderElementData | null> {
    try {
      const videoId = youtubeIdFrom(context.url);
      if (!videoId) return null;

      let thumbnailUrl = thumbnailUrlFor(videoId, "maxresdefault");
      let imageResult = await fetchSingleImage(thumbnailUrl);

      if (!imageResult) {
        thumbnailUrl = thumbnailUrlFor(videoId, "hqdefault");
        imageResult = await fetchSingleImage(thumbnailUrl);
      }

      if (!imageResult) return null;

      const contentHash = await storeImageBytes(imageResult.imageData, imageResult.contentType);
      if (!contentHash) return null;

      return {
        imageBytes: imageResult.imageData,
        contentType: imageResult.contentType,
        contentHash,
      };
    } catch {
      return null;
    }
  }
}

export class GenericImageStrategy implements HeaderElementStrategy {
  canHandle(url: string): boolean {
    if (url.includes("v.redd.it") && !isRedditEmbedUrl(url)) {
      return false;
    }
    return true;
  }

  async create(context: HeaderElementContext): Promise<HeaderElementData | null> {
    try {
      const extractor = new ImageExtractor();
      const imageResult = await extractor.extractImageFromUrl(context.url, true, context.onLog);

      if (!imageResult) return null;

      const contentHash = await storeImageBytes(imageResult.imageData, imageResult.contentType, {
        isHeader: true,
      });
      if (!contentHash) return null;

      return {
        imageBytes: imageResult.imageData,
        contentType: imageResult.contentType,
        contentHash,
        imageUrl: imageResult.imageUrl,
      };
    } catch (e) {
      if (e instanceof ArticleSkipError) throw e;
      return null;
    }
  }
}
