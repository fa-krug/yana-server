/**
 * Reddit type definitions.
 *
 * Ported from old/core/aggregators/reddit/types.py.
 */

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
  preview: Record<string, any> | null;
  media_metadata: Record<string, any> | null;
  gallery_data: Record<string, any> | null;
  is_gallery: boolean;
  is_self: boolean;
  is_video: boolean;
  media: Record<string, any> | null;
  crosspost_parent_list: Array<Record<string, any>> | null;

  constructor(data: Record<string, any> = {}) {
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

  toDict(): Record<string, any> {
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

export class RedditPost {
  data: RedditPostData;

  constructor(data: Record<string, any> = {}) {
    this.data = new RedditPostData(data.data || data);
  }
}

export class RedditComment {
  id: string;
  body: string;
  body_html: string | null;
  author: string;
  score: number;
  permalink: string;
  created_utc: number;
  replies: any;

  constructor(data: Record<string, any> = {}) {
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
