/**
 * Reddit aggregator implementation.
 *
 * Ported from old/core/aggregators/reddit/aggregator.py.
 */

import * as cheerio from "cheerio";
import { BaseAggregator, FeedLike, RawArticle } from "../../base";
import { mapWithConcurrency } from "../../concurrency";
import { AggregatorError, ArticleSkipError } from "../../errors";
import { getHeaderImageRef, HeaderElementData } from "../../header/context";
import {
  buildHeaderHtml,
  extractYoutubeVideoId,
  formatArticleContent,
  isTwitterUrl,
} from "../../extract/format";
import { localizeThumbnail } from "../../embeds/youtube";
import { storeImageRefFromUrl } from "../../images/store";

import { getRedditAccessToken, getRedditUserSettings } from "./auth";
import { fetchPostComments, formatCommentHtml, isValidComment } from "./comments";
import { buildCrosspostNoticeHtml, buildPostContent, CrosspostAttribution } from "./content";
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

  // Populated by fetchArticleContent() (the reload path only -- a normal
  // aggregation run gets the same information from parseToRawArticles()
  // instead) so that processContent() can rebuild the real header/video/
  // YouTube-thumbnail facade below without finalizeArticles() ever running.
  // `undefined` means "fetchArticleContent() has not run on this instance",
  // distinct from `null` ("ran, found nothing") -- see processContent().
  private _lastReloadedHeaderImageUrl?: string | null;
  private _lastReloadedVideoUrl?: string | null;
  private _lastReloadedVideoInfo?: { hlsUrl?: string; fallbackUrl?: string } | null;

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

  override async logoImageUrl(): Promise<string | null> {
    const subreddit = normalizeSubreddit(this.identifier);
    if (!subreddit) return null;
    try {
      const settings = getRedditUserSettings(this.feed.options);
      const accessToken = await getRedditAccessToken(
        settings.reddit_client_id,
        settings.reddit_client_secret,
        settings.reddit_user_agent,
      );
      const info = await fetchSubredditInfo(subreddit, this.feed.userId, accessToken);
      return info.iconUrl;
    } catch {
      return null;
    }
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

      // Everything above resolves to the *original* post -- title, date,
      // author, permalink, media and (in `enrichArticles()`) comments all come
      // from the subreddit the post was first submitted to, so the finished
      // article would otherwise carry nothing that says it arrived here as a
      // crosspost. This reads the parent entry directly rather than reusing
      // `originalSubreddit` above, whose fallback to the feed's own subreddit
      // is right for the comments fetch and wrong for the notice: naming the
      // subreddit the reader is already looking at says nothing.
      const crosspost: CrosspostAttribution | null = isCrossPost
        ? { originalSubreddit: postWrapper.data.crosspost_parent_list?.[0]?.subreddit || "" }
        : null;

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
        _reddit_crosspost: crosspost,
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

    const results = await mapWithConcurrency(
      articles,
      this.concurrency,
      async (article): Promise<RawArticle | null> => {
        try {
          const postDataDict = (article._reddit_post_data as RedditPostDataDict) || {};
          const postData = new RedditPostData(postDataDict);
          const subreddit = (article._reddit_subreddit as string) || "";
          const crosspost = (article._reddit_crosspost as CrosspostAttribution | null) ?? null;

          const comments = await fetchPostComments(
            subreddit,
            postData.id,
            commentLimit,
            this.feed.userId,
            accessToken,
          );

          const labels = await this.chromeLabels();
          const postContent = await buildPostContent(
            postData,
            commentLimit,
            subreddit,
            labels,
            this.feed.userId,
            crosspost,
            comments,
          );

          // The comment section is kept off `article.content` -- it rides
          // along on `_reddit_comments_html` and is stitched back in by
          // `processContent()` via `formatArticleContent()`'s own
          // `commentsContent` parameter, which is what lets
          // `articleContentHash()` cut it back out. Concatenating it here, as
          // this used to, put the comments back inside the block-source html
          // with no marker to find them by.
          article.raw_content = postContent.body + (postContent.comments ?? "");
          article.content = postContent.body;
          article._reddit_comments_html = postContent.comments;
        } catch (err) {
          if (err instanceof ArticleSkipError) {
            return null; // drop this article; it's private/removed, not empty-with-comments
          }
          article.raw_content = "";
          article.content = "";
        }

        return article;
      },
    );

    return results.filter((a): a is RawArticle => a !== null);
  }

  override async finalizeArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    // AI post-processing used to run here first. It works on the block tree
    // now, which only exists downstream in the job handler -- see
    // `BaseAggregator.finalizeArticles()`.
    return mapWithConcurrency(articles, this.concurrency, async (article): Promise<RawArticle> => {
      const includeHeaderImage = (this.feed.options?.include_header_image as boolean) ?? true;
      // `include_header_image: false` suppresses the video header too, not just
      // the image one: both are headers, and a user who turned headers off got a
      // `<video>` anyway. Nothing is lost -- `addLinkMedia()` in `./content.ts`
      // still renders the post's own `v.redd.it` link in the body.
      const headerSourceUrl = includeHeaderImage
        ? (article._reddit_header_image_url as string | null)
        : null;
      const redditVideo = includeHeaderImage
        ? ((article._reddit_video_info as
            { hlsUrl?: string; fallbackUrl?: string } | null | undefined) ?? null)
        : null;
      const videoUrl = (article._reddit_video_url as string | null | undefined) ?? null;

      const built = await this._buildHeaderForArticle(
        article.content || "",
        article.name,
        headerSourceUrl,
        videoUrl,
        redditVideo,
      );
      article.content = built.content;
      article.header_html = built.headerHtml;

      // The comments-only-body case: a link post whose body is otherwise
      // empty (a bare v.redd.it link renders nothing) still has a comments
      // section to stitch in via processContent() below -- without this
      // clause in the guard, such a post skipped processContent() entirely
      // and silently dropped its comments.
      if (article.content || built.headerHtml || article._reddit_comments_html) {
        article.content = await this.processContent(article.content, article);
      }

      delete article._reddit_post_data;
      delete article._reddit_subreddit;
      delete article._reddit_crosspost;
      delete article._reddit_num_comments;
      delete article._reddit_header_image_url;
      delete article._reddit_video_url;
      delete article._reddit_video_info;
      delete article._reddit_comments_html;
      delete article.header_html;

      return article;
    });
  }

  /**
   * The real header-building logic: video header, YouTube-link thumbnail
   * facade, or a stored header image, plus the matching de-dup strip of that
   * same content out of the body. Shared by `finalizeArticles()` (the normal
   * aggregation path, whose inputs come from `parseToRawArticles()`) and
   * `processContent()`'s reload branch (whose inputs come from
   * `fetchArticleContent()` instead, since reload never calls
   * `finalizeArticles()` -- see `reload.ts`).
   */
  private async _buildHeaderForArticle(
    content: string,
    articleName: string,
    headerSourceUrl: string | null,
    videoUrl: string | null,
    redditVideo: { hlsUrl?: string; fallbackUrl?: string } | null,
  ): Promise<{ headerHtml: string | null; content: string }> {
    let headerHtml: string | null = null;

    if (redditVideo) {
      headerHtml = await buildVideoHeaderHtml(redditVideo, headerSourceUrl);
      if (headerHtml && content) {
        content = this._stripImageFromContent(content, headerSourceUrl || "");
      }
    } else if (headerSourceUrl) {
      const labels = await this.chromeLabels();
      const isYoutubeHeader = Boolean(extractYoutubeVideoId(headerSourceUrl));
      const isTwitterHeader = isTwitterUrl(headerSourceUrl);

      let renderUrl = headerSourceUrl;
      if (!(isYoutubeHeader || isTwitterHeader)) {
        renderUrl = await this._storeHeaderImage(headerSourceUrl);
      }

      let headerCaptionHtml: string | null = null;
      if (videoUrl && !isYoutubeHeader) {
        headerCaptionHtml = `<p>${safeLinkHtml(videoUrl, labels.viewVideo)}</p>`;
      }

      // A YouTube-link post's headerSourceUrl is the watch URL itself, not an
      // image -- createYoutubeEmbedHtml() renders no thumbnail at all unless
      // one is passed in, so without this every such post showed a bare
      // play button on black. Same localizeThumbnail() the YouTube aggregator
      // uses for its own embeds (src/lib/aggregators/embeds/youtube.ts).
      let youtubeThumbnailRef: string | null = null;
      if (isYoutubeHeader) {
        const youtubeVideoId = extractYoutubeVideoId(headerSourceUrl);
        if (youtubeVideoId) {
          youtubeThumbnailRef = (await localizeThumbnail(youtubeVideoId)) || null;
        }
      }

      headerHtml = buildHeaderHtml(
        labels,
        renderUrl,
        articleName,
        headerCaptionHtml,
        youtubeThumbnailRef,
      );

      if (headerHtml && content) {
        content = this._stripImageFromContent(content, headerSourceUrl);
        if (isYoutubeHeader) {
          content = this._stripYoutubeLinkFromContent(content, headerSourceUrl);
        }
      }
    }

    return { headerHtml, content };
  }

  protected async _storeHeaderImage(headerImageUrl: string): Promise<string> {
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
    let crosspost: CrosspostAttribution | null = null;
    let effectivePostData = postData;

    if (postData.crosspost_parent_list && postData.crosspost_parent_list.length > 0) {
      const originalPost = postData.crosspost_parent_list[0];
      effectiveSubreddit = originalPost.subreddit || subreddit;
      effectivePostData = new RedditPostData(originalPost);
      // Same notice as the aggregation path. A normal aggregation run stores
      // the *original* post's permalink as the article identifier, so
      // reloading one of those articles re-fetches the original and lands in
      // neither this branch nor the notice: it is rebuilt only when the
      // identifier really is a crosspost's permalink.
      crosspost = { originalSubreddit: originalPost.subreddit || "" };
    }

    // The post's own title, for the same reason as the three stashes below:
    // reload has no other way to reach it, and `articles.name` may be a
    // previous AI run's output rather than source text (see `noteSourceTitle()`
    // in ../../base.ts). Read off `effectivePostData`, so a crosspost reports
    // the original post's title -- exactly what parseToRawArticles() stores.
    this.noteSourceTitle(effectivePostData.title);

    // Same derivation as parseToRawArticles() -- reload never calls
    // finalizeArticles(), so processContent() reads these back off the
    // instance instead of off the _reddit_* fields a normal aggregation run
    // would have set on the article.
    this._lastReloadedHeaderImageUrl = await extractHeaderImageUrl(effectivePostData);
    this._lastReloadedVideoUrl = null;
    if (effectivePostData.url) {
      const urlLower = effectivePostData.url.toLowerCase();
      if (
        urlLower.includes("v.redd.it") ||
        urlLower.includes("youtube.com") ||
        urlLower.includes("youtu.be")
      ) {
        this._lastReloadedVideoUrl = effectivePostData.url;
      }
    }
    this._lastReloadedVideoInfo = extractRedditVideo(effectivePostData);

    const commentLimit = 10;
    const comments = await fetchPostComments(
      effectiveSubreddit,
      effectivePostData.id,
      commentLimit,
      this.feed.userId,
      accessToken,
    );

    const labels = await this.chromeLabels();
    // Reload never fingerprints this content -- a successful reload keeps the
    // stored `contentHash` as-is (see the schema comment on `articles.contentHash`)
    // -- so there is no marker to preserve here. Concatenated as one string,
    // exactly as this returned before comments and body were split apart.
    const postContent = await buildPostContent(
      effectivePostData,
      commentLimit,
      effectiveSubreddit,
      labels,
      this.feed.userId,
      crosspost,
      comments,
    );
    return postContent.body + (postContent.comments ?? "");
  }

  override async extractContent(html: string, _article: RawArticle): Promise<string> {
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
          const parentPost = postData.crosspost_parent_list?.[0];
          const isCrossPost = Boolean(parentPost);
          const labels = await this.chromeLabels();

          const contentParts: string[] = [];

          // Unlike the two paths above, this branch builds the body from the
          // crosspost itself rather than the original -- the notice's origin
          // comes off the parent entry either way.
          if (parentPost) {
            contentParts.push(
              buildCrosspostNoticeHtml({ originalSubreddit: parentPost.subreddit || "" }, labels),
            );
          }

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
              contentParts.push(`<p>${safeLinkHtml(url, labels.viewVideoOnYoutube)}</p>`);
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
          const commentSectionParts: string[] = [
            `<h3>${safeLinkHtml(permalink, labels.comments)}</h3>`,
          ];

          if (commentLimit > 0) {
            if (commentsList && commentsList.length > 0) {
              const sliced = commentsList.slice(0, commentLimit);
              const commentHtmls = sliced.map((c: RedditComment) => formatCommentHtml(c, labels));
              commentSectionParts.push(commentHtmls.join(""));
            } else {
              commentSectionParts.push(`<p><em>${labels.noCommentsYet}</em></p>`);
            }
          } else {
            commentSectionParts.push(`<p><em>${labels.commentsDisabled}</em></p>`);
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
    const labels = await this.chromeLabels();
    let headerHtml = article.header_html as string | null | undefined;

    if (headerHtml === undefined) {
      const includeHeaderImage = (this.feed.options?.include_header_image as boolean) ?? true;

      if (this._lastReloadedHeaderImageUrl !== undefined) {
        // Reload path: finalizeArticles() never ran (see reload.ts), so the
        // _reddit_* fields it would key off of were never on this article --
        // fetchArticleContent() stashed the same information on the instance
        // instead. Rebuild the real header/video/YouTube-thumbnail facade
        // from that, rather than falling through to header_data below, which
        // would otherwise just be article.identifier's og:image (the
        // subreddit icon for a bare post permalink -- see extractHeaderElement()).
        const built = await this._buildHeaderForArticle(
          content,
          article.name,
          includeHeaderImage ? (this._lastReloadedHeaderImageUrl ?? null) : null,
          this._lastReloadedVideoUrl ?? null,
          includeHeaderImage ? (this._lastReloadedVideoInfo ?? null) : null,
        );
        headerHtml = built.headerHtml;
        content = built.content;
      } else if (includeHeaderImage) {
        const headerData = article.header_data;
        if (headerData) {
          headerHtml = buildHeaderHtml(labels, getHeaderImageRef(headerData), article.name);
        }
      }
    }

    // Only the normal aggregation path (enrichArticles()) stashes this --
    // reload has no marker to preserve (see fetchArticleContent() above) and
    // leaves its comments concatenated into `content` already, so this is
    // `undefined` there and `commentsContent` below is `null`, same as before.
    const commentsHtml = (article._reddit_comments_html as string | null | undefined) ?? null;

    return formatArticleContent(
      content,
      article.name,
      article.identifier,
      labels,
      null,
      null,
      commentsHtml,
      headerHtml,
    );
  }

  // The real per-post header (video, YouTube-thumbnail facade, stored header
  // image) is built by processContent() above, from either finalizeArticles()'s
  // _reddit_* fields or fetchArticleContent()'s stashed instance state on
  // reload -- never from here. Returning the generic og:image scrape here
  // would resolve to the *subreddit's* icon for a bare post permalink
  // (RedditPostStrategy in header/strategies.ts), which is wrong in both
  // cases and, on reload, is exactly the bug this no-op prevents. Same
  // reasoning as youtube/aggregator.ts's override.
  override async extractHeaderElement(_article: RawArticle): Promise<HeaderElementData | null> {
    return null;
  }
}
