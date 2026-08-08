/**
 * YouTube aggregator implementation.
 *
 * Ported from old/core/aggregators/youtube/aggregator.py.
 */

import * as cheerio from "cheerio";
import { BaseAggregator, FeedLike, RawArticle } from "../../base";
import type { ChromeLabels } from "../../chrome-labels";
import { mapWithConcurrency } from "../../concurrency";
import type { HeaderElementData } from "../../header/context";
import { isSafeUrl } from "../../blocks/parser";
import { cleanHtml, removeSanitizedAttributes, sanitizeHtmlAttributes } from "../../extract/clean";
import { createYoutubeEmbedHtml, escapeHtml, formatArticleContent } from "../../extract/format";
import { localizeThumbnail } from "../../embeds/youtube";
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

// Comment avatars are deliberately not rendered -- they added a full-size,
// unconstrained <img> to every comment with no product need for it.
export function safeCommentAvatarHtml(): string {
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

  override async logoImageUrl(): Promise<string | null> {
    if (!this.identifier) return null;
    let client: YouTubeClient;
    try {
      client = this.getClient();
    } catch {
      return null;
    }

    try {
      let channelId = this._channel_id;
      if (!channelId) {
        const [resolvedId] = await client.resolveChannelId(this.identifier);
        channelId = resolvedId || this.identifier;
      }
      const channels = await client.fetchChannelsData([channelId]);
      return channels[0]?.channel_icon_url ?? null;
    } catch {
      return null;
    }
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
    const labels = await this.chromeLabels();

    await mapWithConcurrency(articles, this.concurrency, async (article) => {
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
        labels,
      );
      article.content = contentHtml;
      article.raw_content = contentHtml;
    });

    return articles;
  }

  buildContentHtml(
    description: string,
    comments: YouTubeCommentThread[],
    videoId: string,
    labels: ChromeLabels,
  ): string {
    // The description is plain text from the API and channel-owner-controlled, so it must be
    // escaped before splicing it into HTML -- a raw `<script>`/`onerror=` payload here would be
    // a stored XSS served verbatim through GET /api/v1/articles/[id]/content.
    const formattedDescription = escapeHtml(description).replace(/\n/g, "<br>");
    let htmlContent = `<div class="youtube-description">${formattedDescription}</div>`;

    if (comments && comments.length > 0) {
      htmlContent += `<div class="youtube-comments"><h3>${labels.comments}</h3>`;
      for (const comment of comments) {
        const topLevel = comment.snippet?.topLevelComment;
        const snippet = topLevel?.snippet;
        const author = snippet?.authorDisplayName;
        const channelUrl = snippet?.authorChannelUrl;
        const body = snippet?.textDisplay || "";
        const commentId = comment.id || "";

        const commentUrl = `https://www.youtube.com/watch?v=${videoId}&lc=${escapeHtml(String(commentId))}`;

        const authorHtml = safeCommentAuthorHtml(author, channelUrl);
        const sanitizedBody = sanitizeCommentBodyHtml(body);

        htmlContent += `\n<blockquote>\n<p><strong>${authorHtml}</strong> | <a href="${commentUrl}" target="_blank" rel="noopener">${labels.source}</a></p>\n<div>${sanitizedBody}</div>\n</blockquote>\n`;
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
      // processContent() (below) already derives the video id from
      // article.identifier and prepends its own createYoutubeEmbedHtml()
      // facade, so building a second one here duplicated the embed in every
      // aggregated video's content.
      article.content = await this.processContent(article.content, article);
      delete article._youtube_video_id;
      finalized.push(article);
    }

    return finalized;
  }

  // `processContent()` below builds its own embed thumbnail via
  // `localizeThumbnail(videoId)` and never reads `article.header_data` --
  // the generic header extractor's `YouTubeStrategy` would otherwise still
  // run on every `article.reload` (see `reload.ts`, which calls this for
  // every aggregator unconditionally), fetching the video's thumbnail image
  // over HTTP and writing it to the image store for a result nothing
  // consumes. Same reasoning as explosm.ts/oglaf.ts/dark_legacy.ts.
  override async extractHeaderElement(_article: RawArticle): Promise<HeaderElementData | null> {
    return null;
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

  override async extractContent(html: string, article: RawArticle): Promise<string> {
    if (this._last_reloaded_video) {
      const video = this._last_reloaded_video;
      const comments = this._last_reloaded_comments;
      let videoId = video.id;
      if (typeof videoId === "object" && videoId !== null && "videoId" in videoId) {
        videoId = (videoId as { videoId: string }).videoId;
      }
      const description = video.snippet?.description || "";
      if (typeof videoId === "string") {
        const labels = await this.chromeLabels();
        return this.buildContentHtml(description, comments, videoId, labels);
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
              const labels = await this.chromeLabels();
              return this.buildContentHtml(description, comments, videoId, labels);
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

    let embedHtml = "";
    if (videoId) {
      const thumbnailRef = await localizeThumbnail(videoId);
      embedHtml = createYoutubeEmbedHtml(videoId, "", thumbnailRef);
    }

    const processed = formatArticleContent(content, article.name, article.identifier);
    return embedHtml + processed;
  }
}
