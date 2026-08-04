/**
 * Reddit aggregator implementation.
 *
 * Ported from old/core/aggregators/reddit/aggregator.py.
 */

import * as cheerio from "cheerio";
import { AggregatorUserSettings, BaseAggregator, FeedLike, RawArticle } from "../../base";
import { AggregatorError, ArticleSkipError } from "../../errors";
import { getHeaderImageRef, HeaderElementData } from "../../header/context";
import { extractHeaderElement } from "../../header/extractor";
import {
  buildHeaderHtml,
  extractYoutubeVideoId,
  formatArticleContent,
  isTwitterUrl,
} from "../../extract/format";
import { storeImageRefFromUrl } from "../../images/store";

import { getRedditAccessToken, getRedditUserSettings } from "./auth";
import { fetchPostComments, formatCommentHtml, isValidComment } from "./comments";
import { buildPostContent } from "./content";
import { extractAnimatedGifUrl, extractHeaderImageUrl, extractThumbnailUrl } from "./images";
import { convertRedditMarkdown, escapeHtml, safeImgHtml, safeLinkHtml } from "./markdown";
import { fetchRedditPost } from "./posts";
import { buildVideoHeaderHtml, extractRedditVideo } from "./video";
import {
  RedditComment,
  RedditListing,
  RedditPostData,
  RedditPostDataDict,
  RedditPostRaw,
} from "./types";
import {
  decodeHtmlEntitiesInUrl,
  extractPostInfoFromUrl,
  fetchSubredditInfo,
  fixRedditMediaUrl,
  normalizeSubreddit,
  validateSubreddit,
} from "./urls";

/** The shape `fetchSourceData` produces and `parseToRawArticles` consumes. */
interface RedditSourceData {
  posts: Array<{ data: RedditPostData }>;
  subreddit: string;
}

export class RedditAggregator extends BaseAggregator {
  static identifierField = "subreddit";
  static supportsIdentifierSearch = true;
  static brandSiteUrl = "https://www.reddit.com";

  static getIdentifierFromRelated(relatedObj: unknown): string {
    if (typeof relatedObj === "object" && relatedObj !== null) {
      if ("display_name" in relatedObj) {
        return String((relatedObj as Record<string, unknown>).display_name);
      }
    }
    return String(relatedObj);
  }

  static getConfigurationFields(): Record<string, unknown> {
    return {
      min_comments: {
        type: "number",
        initial: 5,
        label: "Minimum Comments",
        help_text: "Skip posts with fewer comments than this.",
        required: false,
        min_value: 0,
      },
      comment_limit: {
        type: "number",
        initial: 10,
        label: "Comment Limit",
        help_text: "Number of top comments to include in the article body.",
        required: false,
        min_value: 0,
        max_value: 50,
      },
      include_header_image: {
        type: "boolean",
        initial: true,
        label: "Include Header Image",
        help_text: "Include the post image/thumbnail at the top of the article.",
        required: false,
      },
      subreddit_sort: {
        type: "select",
        choices: [
          ["hot", "Hot"],
          ["new", "New"],
          ["top", "Top"],
          ["rising", "Rising"],
        ],
        initial: "hot",
        label: "Sort Order",
        help_text: "Which posts to fetch (Hot, New, Top, Rising).",
        required: false,
      },
      min_age_hours: {
        type: "number",
        initial: 48,
        label: "Minimum Post Age (hours)",
        help_text:
          "Only import posts older than this many hours. Helps filter out posts that get removed by moderators shortly after posting. Set to 0 to disable.",
        required: false,
        min_value: 0,
        max_value: 168,
      },
    };
  }

  private _subredditIconUrl: string | null = null;

  constructor(feed: FeedLike) {
    super(feed);
  }

  override getAggregatorType(): string {
    return "reddit";
  }

  override getSourceUrl(): string {
    if (this.identifier) {
      const subreddit = normalizeSubreddit(this.identifier);
      return `https://www.reddit.com/r/${subreddit}`;
    }
    return "https://www.reddit.com";
  }

  override logoImageUrl(): string | null {
    return this._subredditIconUrl;
  }

  override validate(): void {
    super.validate();
    const subreddit = normalizeSubreddit(this.identifier);
    if (!subreddit) {
      throw new Error(`Could not extract subreddit from identifier: ${this.identifier}`);
    }
    const validation = validateSubreddit(subreddit);
    if (!validation.valid) {
      throw new Error(validation.error || "Invalid subreddit");
    }
  }

  override normalizeIdentifier(identifier: string): string {
    const iden = identifier.trim();
    if (iden.includes(":")) {
      const part = iden.split(":")[0]!.trim();
      if (part.startsWith("r/")) {
        return part.slice(2);
      }
      return part;
    }
    return normalizeSubreddit(iden) || iden;
  }

  override getIdentifierLabel(identifier: string): string {
    if (this.feed && this.feed.name) {
      return `${this.feed.name} (r/${identifier})`;
    }
    return identifier;
  }

  async fetchSourceData(limit?: number): Promise<RedditSourceData> {
    const subreddit = normalizeSubreddit(this.identifier);
    if (!subreddit) {
      throw new Error(`Could not extract subreddit from identifier: ${this.identifier}`);
    }

    const settings = getRedditUserSettings(this.feed.options);
    const accessToken = await getRedditAccessToken(
      settings.reddit_client_id,
      settings.reddit_client_secret,
      settings.reddit_user_agent,
    );

    const info = await fetchSubredditInfo(subreddit, this.feed.userId, accessToken);
    this._subredditIconUrl = info.iconUrl;

    const sort = (this.feed.options?.subreddit_sort as string) || "hot";
    const fetchLimit = Math.min((limit || 25) * 3, 100);

    const url = accessToken
      ? `https://oauth.reddit.com/r/${subreddit}/${sort}?limit=${fetchLimit}`
      : `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${fetchLimit}`;

    const headers: Record<string, string> = {
      "User-Agent": settings.reddit_user_agent || "Yana/1.0",
    };
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw new AggregatorError(`Failed to connect to Reddit: ${(err as Error).message}`);
    }

    if (res.status === 401) {
      throw new AggregatorError("Reddit authentication failed. Please check your API credentials.");
    }
    if (res.status === 403) {
      throw new AggregatorError(`Subreddit 'r/${subreddit}' is private or banned.`);
    }
    if (res.status === 404) {
      throw new AggregatorError(`Subreddit 'r/${subreddit}' does not exist.`);
    }
    if (res.status === 429) {
      throw new AggregatorError("Reddit rate limit exceeded.");
    }
    if (!res.ok) {
      throw new AggregatorError(`Reddit request failed with status ${res.status}.`);
    }

    const data = (await res.json()) as RedditListing<"t3", RedditPostRaw> | null;
    const children = data?.data?.children || [];
    const posts = children
      .filter((child) => child.kind === "t3" && child.data)
      .map((child) => ({ data: new RedditPostData(child.data) }));

    return { posts, subreddit };
  }

  async parseToRawArticles(sourceData: unknown): Promise<RawArticle[]> {
    const data = sourceData as RedditSourceData | null | undefined;
    const posts: Array<{ data: RedditPostData }> = data?.posts || [];
    const subreddit: string = data?.subreddit || "";
    const articles: RawArticle[] = [];

    for (const postWrapper of posts) {
      const originalPostData = this._getOriginalPostData(postWrapper.data);
      const isCrossPost = Boolean(
        postWrapper.data.crosspost_parent_list && postWrapper.data.crosspost_parent_list.length > 0,
      );

      const originalSubreddit =
        postWrapper.data.crosspost_parent_list &&
        postWrapper.data.crosspost_parent_list[0]?.subreddit
          ? postWrapper.data.crosspost_parent_list[0].subreddit
          : subreddit;

      const decodedPermalink = originalPostData.permalink.replace(/&amp;/g, "&");
      const permalink = `https://reddit.com${decodedPermalink}`;

      const headerImageUrl = await extractHeaderImageUrl(originalPostData);
      const thumbnailUrl = extractThumbnailUrl(originalPostData);
      const articleThumbnailUrl = headerImageUrl || thumbnailUrl;

      let videoUrl: string | null = null;
      if (originalPostData.url) {
        const urlLower = originalPostData.url.toLowerCase();
        if (
          urlLower.includes("v.redd.it") ||
          urlLower.includes("youtube.com") ||
          urlLower.includes("youtu.be")
        ) {
          videoUrl = originalPostData.url;
        }
      }

      const postDate = new Date(originalPostData.created_utc * 1000);
      const redditVideo = extractRedditVideo(originalPostData);

      const article: RawArticle = {
        name: originalPostData.title,
        identifier: permalink,
        raw_content: "",
        content: "",
        date: postDate,
        author: originalPostData.author,
        icon: articleThumbnailUrl,
        _reddit_post_data: originalPostData.toDict(),
        _reddit_subreddit: originalSubreddit,
        _reddit_is_cross_post: isCrossPost,
        _reddit_num_comments: originalPostData.num_comments,
        _reddit_header_image_url: headerImageUrl,
        _reddit_video_url: videoUrl,
        _reddit_video_info: redditVideo,
      };

      articles.push(article);
    }

    return articles;
  }

  private _getOriginalPostData(postData: RedditPostData): RedditPostData {
    if (postData.crosspost_parent_list && postData.crosspost_parent_list.length > 0) {
      return new RedditPostData(postData.crosspost_parent_list[0]);
    }
    return postData;
  }

  override async filterArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    const filtered: RawArticle[] = [];
    const minComments = (this.feed.options?.min_comments as number) ?? 5;
    const minAgeHours = (this.feed.options?.min_age_hours as number) ?? 48;

    const now = new Date();
    const twoMonthsAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const minAgeCutoff =
      minAgeHours > 0 ? new Date(now.getTime() - minAgeHours * 60 * 60 * 1000) : null;

    for (const article of articles) {
      const articleDate = article.date;

      if (articleDate && articleDate < twoMonthsAgo) {
        continue;
      }

      if (minAgeCutoff && articleDate && articleDate > minAgeCutoff) {
        continue;
      }

      if (article.author === "AutoModerator") {
        continue;
      }

      if (minComments > 0) {
        const numComments = (article._reddit_num_comments as number) || 0;
        if (numComments < minComments) {
          continue;
        }
      }

      filtered.push(article);
    }

    return filtered;
  }

  override async enrichArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    const commentLimit = (this.feed.options?.comment_limit as number) ?? 10;
    const settings = getRedditUserSettings(this.feed.options);
    const accessToken = await getRedditAccessToken(
      settings.reddit_client_id,
      settings.reddit_client_secret,
      settings.reddit_user_agent,
    );

    const enriched: RawArticle[] = [];

    for (const article of articles) {
      try {
        const postDataDict = (article._reddit_post_data as RedditPostDataDict) || {};
        const postData = new RedditPostData(postDataDict);
        const subreddit = (article._reddit_subreddit as string) || "";
        const isCrossPost = (article._reddit_is_cross_post as boolean) || false;

        const comments = await fetchPostComments(
          subreddit,
          postData.id,
          commentLimit,
          this.feed.userId,
          accessToken,
        );

        const content = await buildPostContent(
          postData,
          commentLimit,
          subreddit,
          this.feed.userId,
          isCrossPost,
          comments,
        );

        article.raw_content = content;
        article.content = content;
      } catch (err) {
        if (err instanceof ArticleSkipError) {
          continue; // drop this article; it's private/removed, not empty-with-comments
        }
        article.raw_content = "";
        article.content = "";
      }

      enriched.push(article);
    }

    return enriched;
  }

  override async finalizeArticles(
    articles: RawArticle[],
    userSettings?: AggregatorUserSettings,
  ): Promise<RawArticle[]> {
    const processedArticles = await this.applyAiProcessing(articles, userSettings);
    const finalized: RawArticle[] = [];

    for (const article of processedArticles) {
      const includeHeaderImage = (this.feed.options?.include_header_image as boolean) ?? true;
      const headerSourceUrl = includeHeaderImage
        ? (article._reddit_header_image_url as string | null)
        : null;

      let headerHtml: string | null = null;
      const redditVideo = article._reddit_video_info as
        { hlsUrl?: string; fallbackUrl?: string } | null | undefined;

      if (redditVideo) {
        headerHtml = await buildVideoHeaderHtml(redditVideo, headerSourceUrl);
        if (headerHtml && article.content) {
          article.content = this._stripImageFromContent(article.content, headerSourceUrl || "");
        }
      } else if (headerSourceUrl) {
        const isYoutubeHeader = Boolean(extractYoutubeVideoId(headerSourceUrl));
        const isTwitterHeader = isTwitterUrl(headerSourceUrl);

        let renderUrl = headerSourceUrl;
        if (!(isYoutubeHeader || isTwitterHeader)) {
          renderUrl = await this._storeHeaderImage(headerSourceUrl, article);
        }

        let headerCaptionHtml: string | null = null;
        const videoUrl = article._reddit_video_url as string | null;
        if (videoUrl && !isYoutubeHeader) {
          headerCaptionHtml = `<p>${safeLinkHtml(videoUrl, "▶ View Video")}</p>`;
        }

        headerHtml = buildHeaderHtml(renderUrl, article.name, headerCaptionHtml);

        if (headerHtml && article.content) {
          article.content = this._stripImageFromContent(article.content, headerSourceUrl);
          if (isYoutubeHeader) {
            article.content = this._stripYoutubeLinkFromContent(article.content, headerSourceUrl);
          }
        }
      }

      article.header_html = headerHtml;

      const content = article.content || "";
      if (content || headerHtml) {
        article.content = await this.processContent(content, article);
      }

      delete article._reddit_post_data;
      delete article._reddit_subreddit;
      delete article._reddit_is_cross_post;
      delete article._reddit_num_comments;
      delete article._reddit_header_image_url;
      delete article._reddit_video_url;
      delete article._reddit_video_info;
      delete article.header_html;

      finalized.push(article);
    }

    return finalized;
  }

  protected async _storeHeaderImage(headerImageUrl: string, _article: RawArticle): Promise<string> {
    if (!headerImageUrl.startsWith("http")) {
      return headerImageUrl;
    }
    try {
      const ref = await storeImageRefFromUrl(headerImageUrl, { isHeader: true });
      if (ref) return ref;
    } catch {
      // Fallback to original URL
    }
    return headerImageUrl;
  }

  protected _stripImageFromContent(content: string, imageUrl: string): string {
    if (!content || !imageUrl) return content;
    try {
      const $ = cheerio.load(content);
      const headerPath = new URL(imageUrl, "https://example.com").pathname;
      let modified = false;

      $("img").each((_, img) => {
        const src = $(img).attr("src");
        if (!src || src.startsWith("data:")) return;
        const srcPath = new URL(src, "https://example.com").pathname;
        if (srcPath === headerPath) {
          const parent = $(img).parent();
          $(img).remove();
          modified = true;

          if (
            parent.length > 0 &&
            ["p", "div", "figure"].includes(parent.prop("tagName")?.toLowerCase() || "") &&
            !parent.text().trim() &&
            parent.find("img, iframe, video, a").length === 0
          ) {
            parent.remove();
          }
        }
      });

      const body = $("body");
      return modified ? (body.length > 0 ? body.html() || "" : $.html()) : content;
    } catch {
      return content;
    }
  }

  protected _stripYoutubeLinkFromContent(content: string, youtubeUrl: string): string {
    if (!content || !youtubeUrl) return content;
    try {
      const videoId = extractYoutubeVideoId(youtubeUrl);
      if (!videoId) return content;

      const $ = cheerio.load(content);
      let modified = false;

      $("a").each((_, link) => {
        const href = $(link).attr("href");
        if (!href) return;
        const linkVideoId = extractYoutubeVideoId(href);
        if (linkVideoId === videoId) {
          const parent = $(link).parent();
          $(link).remove();
          modified = true;

          if (
            parent.length > 0 &&
            ["p", "div"].includes(parent.prop("tagName")?.toLowerCase() || "") &&
            !parent.text().trim() &&
            parent.find("img, iframe, video, a").length === 0
          ) {
            parent.remove();
          }
        }
      });

      const body = $("body");
      return modified ? (body.length > 0 ? body.html() || "" : $.html()) : content;
    } catch {
      return content;
    }
  }

  override async fetchArticleContent(url: string): Promise<string> {
    const postInfo = extractPostInfoFromUrl(url);
    const subreddit = postInfo.subreddit;
    const postId = postInfo.postId;

    if (!subreddit || !postId) {
      throw new Error(
        `Invalid Reddit URL format: ${url}. Expected format: /r/{subreddit}/comments/{postId}/...`,
      );
    }

    const settings = getRedditUserSettings(this.feed.options);
    const accessToken = await getRedditAccessToken(
      settings.reddit_client_id,
      settings.reddit_client_secret,
      settings.reddit_user_agent,
    );

    const postData = await fetchRedditPost(subreddit, postId, this.feed.userId, accessToken);
    if (!postData) {
      throw new Error(`Failed to fetch Reddit post ${postId} from r/${subreddit} via API`);
    }

    let effectiveSubreddit = subreddit;
    let isCrossPost = false;
    let effectivePostData = postData;

    if (postData.crosspost_parent_list && postData.crosspost_parent_list.length > 0) {
      const originalPost = postData.crosspost_parent_list[0];
      isCrossPost = true;
      effectiveSubreddit = originalPost.subreddit || subreddit;
      effectivePostData = new RedditPostData(originalPost);
    }

    const commentLimit = 10;
    const comments = await fetchPostComments(
      effectiveSubreddit,
      effectivePostData.id,
      commentLimit,
      this.feed.userId,
      accessToken,
    );

    return buildPostContent(
      effectivePostData,
      commentLimit,
      effectiveSubreddit,
      this.feed.userId,
      isCrossPost,
      comments,
    );
  }

  override extractContent(html: string, _article: RawArticle): string {
    if (!html) return "";

    const trimmed = html.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const data = JSON.parse(trimmed);
        let postDict: RedditPostRaw | null = null;
        let commentsList: RedditComment[] | undefined = undefined;

        if (Array.isArray(data)) {
          if (data.length > 0 && data[0]?.data?.children?.[0]?.data) {
            postDict = data[0].data.children[0].data;
          }
          if (data.length > 1 && data[1]?.data?.children) {
            const commentItems = data[1].data.children;
            commentsList = [];
            for (const item of commentItems) {
              if (item.kind === "t1" && item.data) {
                const comment = new RedditComment(item.data);
                if (isValidComment(comment)) {
                  commentsList.push(comment);
                }
              }
            }
            commentsList.sort((a, b) => (b.score || 0) - (a.score || 0));
          }
        } else if (data?.data?.children?.[0]?.data) {
          postDict = data.data.children[0].data;
        } else if (data?.id && data?.title) {
          postDict = data;
        }

        if (postDict) {
          const postData = new RedditPostData(postDict);
          const includeComments = (this.feed.options?.include_comments as boolean) ?? true;
          const commentLimit = includeComments
            ? ((this.feed.options?.comment_limit as number) ?? 10)
            : 0;
          const subreddit = postDict.subreddit || normalizeSubreddit(this.identifier);
          const isCrossPost = Boolean(
            postData.crosspost_parent_list && postData.crosspost_parent_list.length > 0,
          );

          const contentParts: string[] = [];

          if (postData.selftext) {
            const selftextHtml = convertRedditMarkdown(postData.selftext);
            contentParts.push(`<div>${selftextHtml}</div>`);
          }

          if (postData.is_gallery && postData.media_metadata && postData.gallery_data) {
            const items = postData.gallery_data.items || [];
            for (const item of items) {
              const mediaId = item.media_id;
              if (mediaId && postData.media_metadata[mediaId]) {
                const mediaInfo = postData.media_metadata[mediaId];
                const isAnimated = mediaInfo.e === "AnimatedImage";
                const mediaUrl = isAnimated ? mediaInfo.s?.gif || mediaInfo.s?.mp4 : mediaInfo.s?.u;
                if (mediaUrl) {
                  const fixedUrl = fixRedditMediaUrl(decodeHtmlEntitiesInUrl(mediaUrl));
                  const caption = item.caption || "";
                  const alt = caption || (isAnimated ? "Animated GIF" : "Gallery image");
                  const imgHtml = safeImgHtml(fixedUrl, alt);
                  if (imgHtml) {
                    if (caption) {
                      contentParts.push(
                        `<figure>${imgHtml}<figcaption>${escapeHtml(alt)}</figcaption></figure>`,
                      );
                    } else {
                      contentParts.push(`<p>${imgHtml}</p>`);
                    }
                  }
                }
              }
            }
          } else if (postData.url) {
            const url = decodeHtmlEntitiesInUrl(postData.url);
            const urlLower = url.toLowerCase();

            if (urlLower.endsWith(".gif") || urlLower.endsWith(".gifv")) {
              const gifUrl =
                extractAnimatedGifUrl(postData) ||
                (urlLower.endsWith(".gifv") ? url.slice(0, -1) : url);
              const fixedUrl = fixRedditMediaUrl(gifUrl);
              const imgHtml = safeImgHtml(fixedUrl, "Animated GIF");
              if (imgHtml) contentParts.push(`<p>${imgHtml}</p>`);
            } else if (
              [".jpg", ".jpeg", ".png", ".webp"].some((ext) => urlLower.includes(ext)) ||
              urlLower.includes("i.redd.it")
            ) {
              const fixedUrl = fixRedditMediaUrl(url);
              if (fixedUrl) contentParts.push(`<p>${safeLinkHtml(fixedUrl, fixedUrl)}</p>`);
            } else if (urlLower.includes("youtube.com") || urlLower.includes("youtu.be")) {
              contentParts.push(`<p>${safeLinkHtml(url, "▶ View Video on YouTube")}</p>`);
            } else if (
              !isCrossPost &&
              !postData.is_self &&
              !urlLower.includes("v.redd.it") &&
              !urlLower.includes("twitter.com") &&
              !urlLower.includes("x.com")
            ) {
              contentParts.push(`<p>${safeLinkHtml(url, url)}</p>`);
            }
          }

          const decodedPermalink = decodeHtmlEntitiesInUrl(postData.permalink);
          const permalink = `https://reddit.com${decodedPermalink}`;
          const commentSectionParts: string[] = [`<h3>${safeLinkHtml(permalink, "Comments")}</h3>`];

          if (commentLimit > 0) {
            if (commentsList && commentsList.length > 0) {
              const sliced = commentsList.slice(0, commentLimit);
              const commentHtmls = sliced.map((c: RedditComment) => formatCommentHtml(c));
              commentSectionParts.push(commentHtmls.join(""));
            } else {
              commentSectionParts.push("<p><em>No comments yet.</em></p>");
            }
          } else {
            commentSectionParts.push("<p><em>Comments disabled.</em></p>");
          }

          contentParts.push(`<section>${commentSectionParts.join("")}</section>`);
          return contentParts.join("");
        }
      } catch (err) {
        console.error("[Reddit extractContent error]", err);
      }
    }

    return html;
  }

  override async processContent(content: string, article: RawArticle): Promise<string> {
    let headerHtml = article.header_html as string | null | undefined;

    if (headerHtml === undefined && (this.feed.options?.include_header_image ?? true)) {
      const headerData = article.header_data;
      if (headerData) {
        headerHtml = buildHeaderHtml(getHeaderImageRef(headerData), article.name);
      }
    }

    return formatArticleContent(
      content,
      article.name,
      article.identifier,
      null,
      null,
      null,
      headerHtml,
    );
  }

  override async extractHeaderElement(article: RawArticle): Promise<HeaderElementData | null> {
    const url = article.identifier;
    const alt = article.name || "Reddit post image";
    if (!url) return null;
    const userId =
      typeof this.feed.userId === "string"
        ? parseInt(this.feed.userId, 10) || null
        : (this.feed.userId as number | null | undefined);
    return extractHeaderElement(url, alt, userId);
  }
}
