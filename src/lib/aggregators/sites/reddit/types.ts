/**
 * Reddit type definitions.
 *
 * Ported from old/core/aggregators/reddit/types.py.
 *
 * These interfaces model the JSON shapes Reddit's public API returns. Reddit
 * omits fields freely depending on post/comment kind, so every field below is
 * optional -- the `RedditPostData`/`RedditComment` constructors are what
 * apply the same defaults the Python `dict.get(key, default)` calls did.
 */

/** A single resolution entry inside a preview image or its `variants`. */
export interface RedditMediaSource {
  url?: string;
  width?: number;
  height?: number;
}

/** The `variants` map on a preview image -- alternate encodings of the same media. */
export interface RedditPreviewVariants {
  gif?: { source?: RedditMediaSource };
  mp4?: { source?: RedditMediaSource };
}

export interface RedditPreviewImage {
  source?: RedditMediaSource;
  variants?: RedditPreviewVariants;
}

/** `post.preview` -- Reddit's preview-image payload. */
export interface RedditPreview {
  images?: RedditPreviewImage[];
}

/** One entry of `media_metadata`, keyed by media id. */
export interface RedditMediaMetadataItem {
  e?: string; // "Image" | "AnimatedImage" | ...
  s?: {
    u?: string;
    gif?: string;
    mp4?: string;
  };
}

/** `post.media_metadata` -- gallery media, keyed by the id gallery items reference. */
export type RedditMediaMetadata = Record<string, RedditMediaMetadataItem>;

/** One entry of `gallery_data.items`. */
export interface RedditGalleryItem {
  media_id?: string;
  caption?: string;
}

/** `post.gallery_data` -- the ordered list of gallery items, keyed to `media_metadata`. */
export interface RedditGalleryData {
  items?: RedditGalleryItem[];
}

/**
 * The raw JSON shape Reddit returns for a post's "t3" data, as consumed by
 * `RedditPostData`'s constructor. A crosspost's `crosspost_parent_list` entry
 * carries this same shape (plus `subreddit`, read directly off the raw dict
 * rather than through `RedditPostData`).
 */
export interface RedditPostRaw {
  id?: string;
  title?: string;
  selftext?: string;
  selftext_html?: string | null;
  url?: string;
  permalink?: string;
  created_utc?: number;
  author?: string;
  score?: number;
  num_comments?: number;
  thumbnail?: string;
  preview?: RedditPreview | null;
  media_metadata?: RedditMediaMetadata | null;
  gallery_data?: RedditGalleryData | null;
  is_gallery?: boolean;
  is_self?: boolean;
  is_video?: boolean;
  media?: Record<string, unknown> | null;
  crosspost_parent_list?: RedditPostRaw[] | null;
  subreddit?: string;
}

/** The plain object `RedditPostData.toDict()` returns. */
export interface RedditPostDataDict {
  id: string;
  title: string;
  selftext: string;
  selftext_html: string | null;
  url: string;
  permalink: string;
  created_utc: number;
  author: string;
  score: number;
  num_comments: number;
  thumbnail: string;
  preview: RedditPreview | null;
  media_metadata: RedditMediaMetadata | null;
  gallery_data: RedditGalleryData | null;
  is_gallery: boolean;
  is_self: boolean;
  is_video: boolean;
  media: Record<string, unknown> | null;
  crosspost_parent_list: RedditPostRaw[] | null;
}

/**
 * A "kind"-wrapped object from Reddit's API, e.g. `{kind: "t3", data: {...}}`.
 */
export interface RedditThing<TKind extends string, TData> {
  kind: TKind;
  data: TData;
}

/** The paginated "Listing" envelope every Reddit collection endpoint returns. */
export interface RedditListing<TKind extends string, TData> {
  kind: "Listing";
  data: {
    children: RedditThing<TKind, TData>[];
    after?: string | null;
    before?: string | null;
  };
}

export class RedditPostData {
  id: string;
  title: string;
  selftext: string;
  selftext_html: string | null;
  url: string;
  permalink: string;
  created_utc: number;
  author: string;
  score: number;
  num_comments: number;
  thumbnail: string;
  preview: RedditPreview | null;
  media_metadata: RedditMediaMetadata | null;
  gallery_data: RedditGalleryData | null;
  is_gallery: boolean;
  is_self: boolean;
  is_video: boolean;
  media: Record<string, unknown> | null;
  crosspost_parent_list: RedditPostRaw[] | null;

  constructor(data: RedditPostRaw = {}) {
    this.id = data.id || "";
    this.title = data.title || "";
    this.selftext = data.selftext || "";
    this.selftext_html = data.selftext_html ?? null;
    this.url = data.url || "";
    this.permalink = data.permalink || "";
    this.created_utc = data.created_utc || 0;
    this.author = data.author || "";
    this.score = data.score || 0;
    this.num_comments = data.num_comments || 0;
    this.thumbnail = data.thumbnail || "";
    this.preview = data.preview ?? null;
    this.media_metadata = data.media_metadata ?? null;
    this.gallery_data = data.gallery_data ?? null;
    this.is_gallery = data.is_gallery ?? false;
    this.is_self = data.is_self ?? false;
    this.is_video = data.is_video ?? false;
    this.media = data.media ?? null;
    this.crosspost_parent_list = data.crosspost_parent_list ?? null;
  }

  toDict(): RedditPostDataDict {
    return {
      id: this.id,
      title: this.title,
      selftext: this.selftext,
      selftext_html: this.selftext_html,
      url: this.url,
      permalink: this.permalink,
      created_utc: this.created_utc,
      author: this.author,
      score: this.score,
      num_comments: this.num_comments,
      thumbnail: this.thumbnail,
      preview: this.preview,
      media_metadata: this.media_metadata,
      gallery_data: this.gallery_data,
      is_gallery: this.is_gallery,
      is_self: this.is_self,
      is_video: this.is_video,
      media: this.media,
      crosspost_parent_list: this.crosspost_parent_list,
    };
  }
}

/**
 * Either a "kind"-wrapped Reddit Thing (`{data: RedditPostRaw}`) or a bare
 * raw post dict -- `RedditPost` accepts both, mirroring the Python
 * constructor's `data.get("data", {})` plus the TS port's `data.data || data`
 * fallback for a caller that already unwrapped the Thing.
 */
export interface RedditPostInput extends RedditPostRaw {
  data?: RedditPostRaw;
}

export class RedditPost {
  data: RedditPostData;

  constructor(data: RedditPostInput = {}) {
    this.data = new RedditPostData(data.data || data);
  }
}

/**
 * The raw JSON shape Reddit returns for a comment's "t1" data, as consumed by
 * `RedditComment`'s constructor. `replies` is either `""` (no replies) or a
 * nested Listing of more "t1"/"more" things -- never read here, so it stays
 * `unknown` rather than a shape this module has no use for pinning down.
 */
export interface RedditCommentRaw {
  id?: string;
  body?: string;
  body_html?: string | null;
  author?: string;
  score?: number;
  permalink?: string;
  created_utc?: number;
  replies?: unknown;
}

export class RedditComment {
  id: string;
  body: string;
  body_html: string | null;
  author: string;
  score: number;
  permalink: string;
  created_utc: number;
  replies: unknown;

  constructor(data: RedditCommentRaw = {}) {
    this.id = data.id || "";
    this.body = data.body || "";
    this.body_html = data.body_html ?? null;
    this.author = data.author || "";
    this.score = data.score || 0;
    this.permalink = data.permalink || "";
    this.created_utc = data.created_utc || 0;
    this.replies = data.replies ?? null;
  }
}
