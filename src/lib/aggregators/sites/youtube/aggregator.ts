/**
 * YouTube aggregator implementation.
 *
 * Ported from old/core/aggregators/youtube/aggregator.py.
 */

import crypto from "node:crypto";
import * as cheerio from "cheerio";
import { BaseAggregator, FeedLike, RawArticle } from "../../base";
import { isSafeUrl } from "../../blocks/parser";
import { cleanHtml, removeSanitizedAttributes, sanitizeHtmlAttributes } from "../../extract/clean";
import { createYoutubeEmbedHtml, escapeHtml, formatArticleContent } from "../../extract/format";
import { buildImageRef, storeImageRefFromUrl } from "../../images/store";
import {
  YouTubeAPIError,
  YouTubeChannelData,
  YouTubeClient,
  YouTubeCommentThread,
  YouTubeVideoItem,
} from "./client";

export interface YouTubeSourceData {
  videos: YouTubeVideoItem[];
  channel_id: string | null;
  channel_title: string;
}

export function safeCommentAuthorHtml(name?: string | null, channelUrl?: string | null): string {
  const escapedName = escapeHtml(name || "Unknown");
  if (channelUrl && isSafeUrl(channelUrl)) {
    return `<a href="${escapeHtml(channelUrl)}">${escapedName}</a>`;
  }
  return escapedName;
}

export function safeCommentAvatarHtml(avatarUrl?: string | null): string {
  if (avatarUrl && isSafeUrl(avatarUrl)) {
    return `<img src="${escapeHtml(avatarUrl)}" alt="" class="youtube-comment-avatar">`;
  }
  return "";
}

export function sanitizeCommentBodyHtml(contentHtml: string): string {
  const $ = cheerio.load(cleanHtml(contentHtml));
  sanitizeHtmlAttributes($);
  removeSanitizedAttributes($);

  $("a").each((_, tag) => {
    const href = $(tag).attr("href");
    if (href && !isSafeUrl(href)) {
      $(tag).removeAttr("href");
    }
  });

  $("img").each((_, tag) => {
    const src = $(tag).attr("src");
    if (src && !isSafeUrl(src)) {
      $(tag).remove();
    }
  });

  const body = $("body");
  return body.length > 0 ? body.html() || "" : $.html();
}

export class YouTubeAggregator extends BaseAggregator {
  static identifierField = "youtube_channel";
  static supportsIdentifierSearch = true;

  static getIdentifierFromRelated(relatedObj: unknown): string {
    if (typeof relatedObj === "object" && relatedObj !== null && "channel_id" in relatedObj) {
      return String((relatedObj as Record<string, unknown>).channel_id);
    }
    return String(relatedObj);
  }

  static getConfigurationFields(): Record<string, unknown> {
    return {
      comment_limit: {
        type: "number",
        initial: 10,
        label: "Comment Limit",
        help_text: "Number of top comments to include below the video.",
        required: false,
        min_value: 0,
        max_value: 50,
      },
    };
  }

  private _client: YouTubeClient | null = null;
  private _channel_id: string | null = null;
  private _last_reloaded_video: YouTubeVideoItem | null = null;
  private _last_reloaded_comments: YouTubeCommentThread[] = [];

  constructor(feed: FeedLike) {
    super(feed);
  }

  override getAggregatorType(): string {
    return "youtube";
  }

  override getSourceUrl(): string {
    if (this.identifier) {
      if (this.identifier.startsWith("UC")) {
        return `https://www.youtube.com/channel/${this.identifier}`;
      }
      if (this.identifier.startsWith("@")) {
        return `https://www.youtube.com/${this.identifier}`;
      }
    }
    return "https://www.youtube.com";
  }

  protected getClient(): YouTubeClient {
    if (this._client) {
      return this._client;
    }

    const apiKey =
      (this.feed.options?.youtube_api_key as string) ||
      process.env.YOUTUBE_API_KEY ||
      process.env.YOUTUBE_DATA_API_KEY;

    if (!apiKey) {
      throw new YouTubeAPIError(
        "YouTube API is not enabled or API key is missing in user settings",
      );
    }

    this._client = new YouTubeClient(apiKey);
    return this._client;
  }

  override logoImageUrl(): string | null {
    return null;
  }

  override validate(): void {
    super.validate();
  }

  override normalizeIdentifier(identifier: string): string {
    const iden = identifier.trim();
    if (iden.includes("(") && iden.endsWith(")")) {
      const start = iden.lastIndexOf("(") + 1;
      return iden.slice(start, -1).trim();
    }
    return iden;
  }

  override getIdentifierLabel(identifier: string): string {
    if (this.feed && this.feed.name) {
      return `${this.feed.name} (${identifier})`;
    }
    return identifier;
  }

  async fetchSourceData(limit?: number): Promise<YouTubeSourceData> {
    const client = this.getClient();
    let channelId = this._channel_id;

    if (!channelId && this.identifier) {
      const [resolvedId] = await client.resolveChannelId(this.identifier);
      if (resolvedId) {
        channelId = resolvedId;
        this._channel_id = resolvedId;
      }
    }

    if (!channelId) {
      channelId = this.identifier;
    }

    let channelData: YouTubeChannelData | null = null;
    try {
      if (channelId) {
        channelData = await client.fetchChannelData(channelId);
      }
    } catch {
      // Ignore fallback
    }

    const uploadsPlaylistId = channelData?.uploads_playlist_id;
    const desiredCount = limit || this.dailyLimit;

    let videos: YouTubeVideoItem[] = [];
    if (uploadsPlaylistId) {
      videos = await client.fetchVideosFromPlaylist(uploadsPlaylistId, desiredCount);
    } else if (channelId) {
      videos = await client.fetchVideosViaSearch(channelId, desiredCount);
    }

    return {
      videos,
      channel_id: channelId,
      channel_title: channelData?.custom_url || channelData?.title || "",
    };
  }

  async parseToRawArticles(sourceData: YouTubeSourceData): Promise<RawArticle[]> {
    const videos: YouTubeVideoItem[] = sourceData?.videos || [];
    const articles: RawArticle[] = [];

    for (const video of videos) {
      const snippet = video.snippet || {};
      let videoId = video.id;
      if (typeof videoId === "object" && videoId !== null && "videoId" in videoId) {
        videoId = (videoId as { videoId: string }).videoId;
      }

      const publishedAt = snippet.publishedAt;
      const date = publishedAt ? new Date(publishedAt) : new Date();

      const thumbnails = snippet.thumbnails || {};
      const iconUrl =
        thumbnails.maxres?.url || thumbnails.high?.url || thumbnails.medium?.url || null;

      const article: RawArticle = {
        name: snippet.title || "",
        identifier: `https://www.youtube.com/watch?v=${videoId}`,
        raw_content: snippet.description || "",
        content: snippet.description || "",
        date,
        author: sourceData?.channel_title || "",
        icon: iconUrl,
        _youtube_video_id: videoId,
      };
      articles.push(article);
    }

    return articles;
  }

  override async enrichArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    let client: YouTubeClient | null = null;
    try {
      client = this.getClient();
    } catch {
      // Client optional if no key available
    }

    const commentLimit = (this.feed.options?.comment_limit as number) ?? 10;

    for (const article of articles) {
      const videoId = article._youtube_video_id;
      const description = article.content || "";

      let comments: YouTubeCommentThread[] = [];
      if (typeof videoId === "string" && client) {
        comments = await client.fetchVideoComments(videoId, commentLimit);
      }

      const contentHtml = this.buildContentHtml(
        description,
        comments,
        typeof videoId === "string" ? videoId : "",
      );
      article.content = contentHtml;
      article.raw_content = contentHtml;
    }

    return articles;
  }

  buildContentHtml(description: string, comments: YouTubeCommentThread[], videoId: string): string {
    // The description is plain text from the API and channel-owner-controlled, so it must be
    // escaped before splicing it into HTML -- a raw `<script>`/`onerror=` payload here would be
    // a stored XSS served verbatim through GET /api/v1/articles/[id]/content.
    const formattedDescription = escapeHtml(description).replace(/\n/g, "<br>");
    let htmlContent = `<div class="youtube-description">${formattedDescription}</div>`;

    if (comments && comments.length > 0) {
      htmlContent += `<div class="youtube-comments"><h3>Comments</h3>`;
      for (const comment of comments) {
        const topLevel = comment.snippet?.topLevelComment;
        const snippet = topLevel?.snippet;
        const author = snippet?.authorDisplayName;
        const channelUrl = snippet?.authorChannelUrl;
        const avatarUrl = snippet?.authorProfileImageUrl;
        const body = snippet?.textDisplay || "";
        const commentId = comment.id || "";

        const commentUrl = `https://www.youtube.com/watch?v=${videoId}&lc=${escapeHtml(String(commentId))}`;

        const authorHtml = safeCommentAuthorHtml(author, channelUrl);
        const avatarHtml = safeCommentAvatarHtml(avatarUrl);
        const sanitizedBody = sanitizeCommentBodyHtml(body);

        htmlContent += `\n<blockquote>\n${avatarHtml}<p><strong>${authorHtml}</strong> | <a href="${commentUrl}" target="_blank" rel="noopener">source</a></p>\n<div>${sanitizedBody}</div>\n</blockquote>\n`;
      }
      htmlContent += `</div>`;
    }

    return htmlContent;
  }

  override async finalizeArticles(
    articles: RawArticle[],
    userSettings?: Record<string, unknown>,
  ): Promise<RawArticle[]> {
    const processedArticles = await this.applyAiProcessing(articles, userSettings);
    const finalized: RawArticle[] = [];

    for (const article of processedArticles) {
      const videoId = article._youtube_video_id;

      let embedHtml = "";
      if (typeof videoId === "string" && videoId) {
        embedHtml = createYoutubeEmbedHtml(videoId);
      }

      const processed = await this.processContent(article.content, article);

      article.content = embedHtml + processed;
      delete article._youtube_video_id;
      finalized.push(article);
    }

    return finalized;
  }

  override async fetchArticleContent(url: string): Promise<string> {
    const match = url.match(/v=([A-Za-z0-9_-]+)/);
    const videoId = match ? match[1] : null;
    if (!videoId) return "";

    try {
      const client = this.getClient();
      const videos = await client.fetchVideoDetails([videoId]);
      if (!videos.length) return "";

      const comments = await client.fetchVideoComments(videoId, 10);
      this._last_reloaded_video = videos[0];
      this._last_reloaded_comments = comments;

      return videos[0].snippet?.description || "";
    } catch {
      return "";
    }
  }

  override extractContent(html: string, article: RawArticle): string {
    if (this._last_reloaded_video) {
      const video = this._last_reloaded_video;
      const comments = this._last_reloaded_comments;
      let videoId = video.id;
      if (typeof videoId === "object" && videoId !== null && "videoId" in videoId) {
        videoId = (videoId as { videoId: string }).videoId;
      }
      const description = video.snippet?.description || "";
      if (typeof videoId === "string") {
        return this.buildContentHtml(description, comments, videoId);
      }
    }

    if (html) {
      try {
        const trimmed = html.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          const data = JSON.parse(trimmed);
          const video = Array.isArray(data.items) ? data.items[0] : null;
          if (video) {
            let videoId = video.id;
            if (typeof videoId === "object" && videoId !== null && "videoId" in videoId) {
              videoId = (videoId as { videoId: string }).videoId;
            }
            if (!videoId && article.identifier) {
              const match = article.identifier.match(/v=([A-Za-z0-9_-]+)/);
              if (match) videoId = match[1];
            }
            const description = video.snippet?.description || "";
            const comments = Array.isArray(data.comments) ? data.comments : [];
            if (typeof videoId === "string" && videoId) {
              return this.buildContentHtml(description, comments, videoId);
            }
          }
        }
      } catch {
        // Ignore non-JSON
      }
    }

    return html;
  }

  override async processContent(content: string, article: RawArticle): Promise<string> {
    let videoId: string | null = null;
    if (this._last_reloaded_video) {
      const vid = this._last_reloaded_video.id;
      videoId = typeof vid === "string" ? vid : vid.videoId || null;
    }

    if (!videoId && article.identifier) {
      const match = article.identifier.match(/v=([A-Za-z0-9_-]+)/);
      videoId = match ? match[1] : null;
    }

    const $ = cheerio.load(content);
    const avatarImgs = $("img.youtube-comment-avatar").toArray();
    for (const img of avatarImgs) {
      const src = $(img).attr("src");
      if (src && isSafeUrl(src) && !src.startsWith("yana-img://")) {
        let ref = await storeImageRefFromUrl(src);
        if (!ref) {
          const hash = crypto.createHash("sha256").update(src).digest("hex");
          ref = buildImageRef(hash);
        }
        $(img).attr("src", ref);
      }
    }
    const localizedContent = $.html();

    let embedHtml = "";
    if (videoId) {
      embedHtml = createYoutubeEmbedHtml(videoId);
    }

    const processed = formatArticleContent(localizedContent, article.name, article.identifier);
    return embedHtml + processed;
  }
}
