/**
 * YouTube aggregator implementation.
 *
 * Ported from old/core/aggregators/youtube/aggregator.py.
 */

import { BaseAggregator, FeedLike, RawArticle } from "../../base";
import type { ChromeLabels } from "../../chrome-labels";
import { buildCommentsSection, type CommentSpec } from "../../comments/section";
import { mapWithConcurrency } from "../../concurrency";
import type { HeaderElementData } from "../../header/context";
import { isSafeUrl } from "../../blocks/parser";
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

export function safeCommentAuthorHtml(
  labels: ChromeLabels,
  name?: string | null,
  channelUrl?: string | null,
): string {
  const escapedName = escapeHtml(name || labels.unknownAuthor);
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

export class YouTubeAggregator extends BaseAggregator {
  static identifierField = "youtube_channel";

  private _client: YouTubeClient | null = null;
  private _channel_id: string | null = null;
  private _last_reloaded_video: YouTubeVideoItem | null = null;
  private _last_reloaded_comments: YouTubeCommentThread[] = [];

  constructor(feed: FeedLike) {
    super(feed);
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
    // `??`, not `||`: an explicit `limit` of `0` means zero, not "no limit
    // given" -- see the `parseToRawArticles()` contract on `BaseAggregator`.
    const desiredCount = limit ?? this.dailyLimit;

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

  async parseToRawArticles(sourceData: YouTubeSourceData, limit: number): Promise<RawArticle[]> {
    // Sliced by the paced `limit` `aggregate()` computed, never by however
    // many videos `fetchSourceData()` happened to fetch -- see the contract on
    // `BaseAggregator.parseToRawArticles()`.
    const videos: YouTubeVideoItem[] = (sourceData?.videos || []).slice(0, limit);
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

      // The description and the comments are kept apart here -- the comments
      // ride along on `_youtube_comments_html` and are stitched back in by
      // processContent() via `formatArticleContent()`'s own `commentsContent`
      // parameter, which is what lets `articleContentHash()` cut them back
      // out. Concatenating them into one string, as this used to, put the
      // comments inside the block-source html with no marker to find them by.
      const descriptionHtml = this.buildDescriptionHtml(description);
      const commentsHtml = this.buildCommentsHtml(
        comments,
        typeof videoId === "string" ? videoId : "",
        labels,
      );
      article.content = descriptionHtml;
      article.raw_content = descriptionHtml;
      article._youtube_comments_html = commentsHtml;
    });

    return articles;
  }

  buildDescriptionHtml(description: string): string {
    // The description is plain text from the API and channel-owner-controlled, so it must be
    // escaped before splicing it into HTML -- a raw `<script>`/`onerror=` payload here would be
    // a stored XSS served verbatim through GET /api/v1/articles/[id]/content.
    const formattedDescription = escapeHtml(description).replace(/\n/g, "<br>");
    return `<div class="youtube-description">${formattedDescription}</div>`;
  }

  buildCommentsHtml(
    comments: YouTubeCommentThread[],
    videoId: string,
    labels: ChromeLabels,
  ): string | null {
    if (!comments) {
      return null;
    }

    // YouTube's own adapter for the shared `buildCommentsSection()`
    // (`src/lib/aggregators/comments/section.ts`): no timestamp, an author
    // that can itself be a link to the commenter's channel
    // (`authorIsHtml: true`), and an already-escaped comment-id-bearing href
    // that must not be run through `escapeHtml()` a second time
    // (`rawAnchorHref: true`) -- doing so would double-escape the literal "&"
    // between its query parameters.
    const spec: CommentSpec<YouTubeCommentThread[], YouTubeCommentThread> = {
      list: (source) => source,
      author: (c) =>
        safeCommentAuthorHtml(
          labels,
          c.snippet?.topLevelComment?.snippet?.authorDisplayName,
          c.snippet?.topLevelComment?.snippet?.authorChannelUrl,
        ),
      authorIsHtml: true,
      bodyHtml: (c) => c.snippet?.topLevelComment?.snippet?.textDisplay || "",
      anchorUrl: (c) =>
        `https://www.youtube.com/watch?v=${videoId}&lc=${escapeHtml(String(c.id || ""))}`,
      rawAnchorHref: true,
      linkAttrs: 'target="_blank" rel="noopener"',
      multiline: true,
      wrapTag: "div",
      wrapClass: "youtube-comments",
    };

    return buildCommentsSection(spec, comments, null, comments.length, labels, this.onLog);
  }

  /**
   * The combined description + comments html this used to be built as, kept
   * for the one caller that still wants one string: the reload path
   * (`extractContent()` below), which never fingerprints this content -- a
   * successful reload keeps the stored `contentHash` as-is (see the schema
   * comment on `articles.contentHash`) -- so there is no marker to preserve.
   */
  buildContentHtml(
    description: string,
    comments: YouTubeCommentThread[],
    videoId: string,
    labels: ChromeLabels,
  ): string {
    return (
      this.buildDescriptionHtml(description) +
      (this.buildCommentsHtml(comments, videoId, labels) ?? "")
    );
  }

  override async finalizeArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    // AI post-processing used to run here, ahead of this loop. It works on the
    // block tree now, which only exists downstream in the job handler -- see
    // `BaseAggregator.finalizeArticles()`.
    const finalized: RawArticle[] = [];

    for (const article of articles) {
      // processContent() (below) already derives the video id from
      // article.identifier and prepends its own createYoutubeEmbedHtml()
      // facade, so building a second one here duplicated the embed in every
      // aggregated video's content.
      article.content = await this.processContent(article.content, article);
      delete article._youtube_video_id;
      delete article._youtube_comments_html;
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
      // The video's current title, so reload runs AI over the source's own
      // title rather than over the title a previous AI run wrote -- see
      // `noteSourceTitle()` in ../../base.ts.
      this.noteSourceTitle(videos[0].snippet?.title);

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
    const labels = await this.chromeLabels();
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
      embedHtml = createYoutubeEmbedHtml(videoId, labels, "", thumbnailRef);
    }

    // Only the normal aggregation path (enrichArticles()) stashes this --
    // reload has no marker to preserve (see buildContentHtml()'s doc comment
    // above) and leaves its comments concatenated into `content` already, so
    // this is `undefined` there and `commentsContent` below is `null`, same
    // as before.
    const commentsHtml = (article._youtube_comments_html as string | null | undefined) ?? null;

    const processed = formatArticleContent(
      content,
      article.name,
      article.identifier,
      labels,
      null,
      null,
      commentsHtml,
    );
    return embedHtml + processed;
  }
}
