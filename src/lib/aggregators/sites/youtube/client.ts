/**
 * YouTube API client for interacting with YouTube Data API v3.
 *
 * Ported from old/core/aggregators/utils/youtube_client.py.
 */

export class YouTubeAPIError extends Error {
  originalError?: unknown;

  constructor(message: string, originalError?: unknown) {
    super(message);
    this.name = "YouTubeAPIError";
    this.originalError = originalError;
  }
}

export interface YouTubeChannelData {
  channel_id: string;
  title: string | null;
  custom_url: string | null;
  uploads_playlist_id: string | null;
  channel_icon_url: string | null;
}

export interface YouTubeVideoItem {
  id: string | { videoId: string };
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    channelId?: string;
    channelTitle?: string;
    thumbnails?: Record<string, { url?: string; width?: number; height?: number }>;
    [key: string]: unknown;
  };
  statistics?: Record<string, unknown>;
  contentDetails?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface YouTubeCommentThread {
  id?: string;
  snippet?: {
    topLevelComment?: {
      snippet?: {
        authorDisplayName?: string;
        authorChannelUrl?: string;
        authorProfileImageUrl?: string;
        textDisplay?: string;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export class YouTubeClient {
  static BASE_URL = "https://www.googleapis.com/youtube/v3";
  public apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new YouTubeAPIError("YouTube API key is required");
    }
    this.apiKey = apiKey;
  }

  async _get<T = any>(endpoint: string, params: Record<string, string | number>): Promise<T> {
    const url = new URL(`${YouTubeClient.BASE_URL}/${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set("key", this.apiKey);

    try {
      const response = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      return (await response.json()) as T;
    } catch (e) {
      if (e instanceof YouTubeAPIError) throw e;
      throw new YouTubeAPIError(
        `YouTube API request failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
  }

  async resolveChannelId(identifier: string): Promise<[string | null, string | null]> {
    const iden = identifier.trim();
    if (!iden) {
      return [null, "Channel identifier is required"];
    }

    // 1. Existing ID (UC...)
    if (iden.startsWith("UC") && iden.length >= 24) {
      if (await this._validateChannelId(iden)) {
        return [iden, null];
      }
      return [null, `Channel ID not found: ${iden}`];
    }

    // 2. URL extraction
    let handle: string | null = null;
    if (iden.includes("youtube.com") || iden.includes("youtu.be")) {
      const extracted = this._extractFromUrl(iden);
      if (extracted.channel_id) {
        return this.resolveChannelId(extracted.channel_id);
      }
      handle = extracted.handle || null;
    } else {
      handle = iden.startsWith("@") ? iden.slice(1) : iden;
    }

    // 3. Resolve handle
    if (handle) {
      let channelId = await this._resolveViaSearch(handle);
      if (channelId) {
        return [channelId, null];
      }

      channelId = await this._resolveViaUsername(handle);
      if (channelId) {
        return [channelId, null];
      }

      return [null, `Channel handle not found: @${handle}`];
    }

    return [null, "Could not parse channel identifier"];
  }

  private async _validateChannelId(channelId: string): Promise<boolean> {
    try {
      const data = await this._get("channels", { part: "id", id: channelId });
      return Array.isArray(data.items) && data.items.length > 0;
    } catch {
      return false;
    }
  }

  private _extractFromUrl(url: string): { handle?: string; channel_id?: string } {
    let fullUrl = url;
    if (!fullUrl.startsWith("http")) {
      fullUrl = "https://" + fullUrl;
    }

    try {
      const parsed = new URL(fullUrl);
      const path = parsed.pathname.replace(/^\//, "");

      if (path.startsWith("@")) {
        return { handle: path.split("/")[0].slice(1) };
      }
      if (path.startsWith("c/") || path.startsWith("user/")) {
        return { handle: path.split("/")[1] };
      }
      if (path.startsWith("channel/")) {
        return { channel_id: path.split("/")[1] };
      }

      const qChannelId = parsed.searchParams.get("channel_id");
      if (qChannelId) {
        return { channel_id: qChannelId };
      }

      return {};
    } catch {
      return {};
    }
  }

  private async _resolveViaSearch(handle: string): Promise<string | null> {
    const q = handle.startsWith("@") ? handle : `@${handle}`;
    try {
      const data = await this._get("search", {
        part: "snippet",
        q,
        type: "channel",
        maxResults: 10,
      });
      const items = data.items || [];
      if (!items.length) return null;

      const channelIds = items
        .map((item: any) => item.id?.channelId)
        .filter(Boolean) as string[];
      if (!channelIds.length) return null;

      const channelsData = await this.fetchChannelsData(channelIds);
      const normHandle = handle.toLowerCase().replace(/^@/, "");

      // 1. Exact customUrl match
      for (const channel of channelsData) {
        const customUrl = (channel.custom_url || "").toLowerCase().replace(/^@/, "");
        if (customUrl === normHandle) {
          return channel.channel_id;
        }
      }

      // 2. Title match
      for (const channel of channelsData) {
        const title = (channel.title || "").toLowerCase();
        if (normHandle.includes(title) || title.includes(normHandle)) {
          return channel.channel_id;
        }
      }

      // 3. First result fallback
      return channelIds[0];
    } catch {
      return null;
    }
  }

  private async _resolveViaUsername(handle: string): Promise<string | null> {
    try {
      const data = await this._get("channels", { part: "id", forUsername: handle });
      const items = data.items || [];
      if (items.length > 0 && items[0].id) {
        return items[0].id;
      }
      return null;
    } catch {
      return null;
    }
  }

  async fetchChannelData(channelId: string): Promise<YouTubeChannelData> {
    const channels = await this.fetchChannelsData([channelId]);
    if (!channels.length) {
      throw new YouTubeAPIError(`Channel not found: ${channelId}`);
    }
    return channels[0];
  }

  async fetchChannelsData(channelIds: string[]): Promise<YouTubeChannelData[]> {
    if (!channelIds.length) return [];

    const results: YouTubeChannelData[] = [];
    for (let i = 0; i < channelIds.length; i += 50) {
      const batch = channelIds.slice(i, i + 50);
      const data = await this._get("channels", {
        part: "contentDetails,snippet",
        id: batch.join(","),
      });

      for (const item of data.items || []) {
        const snippet = item.snippet || {};
        const thumbnails = snippet.thumbnails || {};

        const iconUrl =
          thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || null;

        const uploadsPlaylistId =
          item.contentDetails?.relatedPlaylists?.uploads || null;

        let customUrl = snippet.customUrl || null;
        if (customUrl && !customUrl.startsWith("@")) {
          customUrl = `@${customUrl}`;
        }

        results.push({
          channel_id: item.id,
          title: snippet.title || null,
          custom_url: customUrl,
          uploads_playlist_id: uploadsPlaylistId,
          channel_icon_url: iconUrl,
        });
      }
    }
    return results;
  }

  async fetchVideosFromPlaylist(
    playlistId: string,
    maxResults: number = 50,
  ): Promise<YouTubeVideoItem[]> {
    const videos: YouTubeVideoItem[] = [];
    let nextPageToken: string | null = null;

    while (videos.length < maxResults) {
      const params: Record<string, string | number> = {
        part: "snippet,contentDetails",
        playlistId,
        maxResults: Math.min(50, maxResults - videos.length),
      };
      if (nextPageToken) {
        params.pageToken = nextPageToken;
      }

      const data = await this._get("playlistItems", params);
      const items = data.items || [];
      if (!items.length) break;

      const videoIds = items
        .map((item: any) => item.contentDetails?.videoId)
        .filter(Boolean) as string[];

      const detailedVideos = await this.fetchVideoDetails(videoIds);
      videos.push(...detailedVideos);

      nextPageToken = data.nextPageToken || null;
      if (!nextPageToken) break;
    }

    return videos.slice(0, maxResults);
  }

  async fetchVideoDetails(videoIds: string[]): Promise<YouTubeVideoItem[]> {
    const allVideos: YouTubeVideoItem[] = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const data = await this._get("videos", {
        part: "snippet,statistics,contentDetails",
        id: batch.join(","),
      });
      allVideos.push(...(data.items || []));
    }
    return allVideos;
  }

  async fetchVideoComments(
    videoId: string,
    maxResults: number = 10,
  ): Promise<YouTubeCommentThread[]> {
    if (maxResults <= 0) return [];

    const comments: YouTubeCommentThread[] = [];
    let nextPageToken: string | null = null;

    try {
      while (comments.length < maxResults) {
        const params: Record<string, string | number> = {
          part: "snippet",
          videoId,
          maxResults: Math.min(100, maxResults - comments.length),
          order: "relevance",
          textFormat: "html",
        };
        if (nextPageToken) {
          params.pageToken = nextPageToken;
        }

        const data = await this._get("commentThreads", params);
        const items = data.items || [];
        if (!items.length) break;

        for (const item of items) {
          const snippet = item.snippet?.topLevelComment?.snippet;
          const text = snippet?.textDisplay;
          if (text && text !== "[deleted]" && text !== "[removed]") {
            comments.push(item);
          }
        }

        nextPageToken = data.nextPageToken || null;
        if (!nextPageToken) break;
      }
    } catch {
      // Don't fail the whole video aggregation just because comments failed
      return [];
    }

    return comments.slice(0, maxResults);
  }

  async fetchVideosViaSearch(
    channelId: string,
    maxResults: number = 50,
  ): Promise<YouTubeVideoItem[]> {
    const videos: YouTubeVideoItem[] = [];
    let nextPageToken: string | null = null;

    while (videos.length < maxResults) {
      const params: Record<string, string | number> = {
        part: "id",
        channelId,
        type: "video",
        order: "date",
        maxResults: Math.min(50, maxResults - videos.length),
      };
      if (nextPageToken) {
        params.pageToken = nextPageToken;
      }

      const data = await this._get("search", params);
      const items = data.items || [];
      if (!items.length) break;

      const videoIds = items
        .map((item: any) => item.id?.videoId)
        .filter(Boolean) as string[];

      const detailedVideos = await this.fetchVideoDetails(videoIds);
      videos.push(...detailedVideos);

      nextPageToken = data.nextPageToken || null;
      if (!nextPageToken) break;
    }

    return videos.slice(0, maxResults);
  }
}
