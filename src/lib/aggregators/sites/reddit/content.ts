/**
 * Reddit content building utilities.
 *
 * Ported from old/core/aggregators/reddit/content.py.
 */

import { ArticleSkipError } from "../../errors";
import type { ChromeLabels } from "../../chrome-labels";
import { buildCommentsSection, type CommentSpec } from "../../comments/section";
import { fetchPostComments } from "./comments";
import { extractAnimatedGifUrl, extractGiphyGifUrl } from "./images";
import { convertRedditMarkdown, escapeHtml, safeImgHtml, safeLinkHtml } from "./markdown";
import { RedditComment, RedditGalleryItem, RedditPostData } from "./types";
import { decodeHtmlEntitiesInUrl, fixRedditMediaUrl } from "./urls";

/**
 * Reddit's own comment descriptor for the shared `buildCommentsSection()`
 * (`src/lib/aggregators/comments/section.ts`): no timestamp, a
 * `target="_blank" rel="noopener"` source link, and no outer wrap -- the
 * heading and comments ride bare inside `formatArticleContent()`'s own
 * `ARTICLE_COMMENTS_CLASS` wrapper, so this must not add a second one.
 */
const REDDIT_COMMENT_SPEC: CommentSpec<RedditComment[], RedditComment> = {
  list: (comments) => comments,
  author: (c) => c.author || "[deleted]",
  bodyHtml: (c) => convertRedditMarkdown(c.body || ""),
  anchorUrl: (c) => `https://reddit.com${c.permalink}`,
  linkAttrs: 'target="_blank" rel="noopener"',
  multiline: true,
};

/**
 * What a crosspost is, spelled out for the reader. A crosspost's article body
 * is built from the *original* post -- its title, selftext, media, comments
 * and permalink all belong to the subreddit it was first submitted to -- so
 * without this nothing in the finished article says the post reached the feed
 * by way of a crosspost, nor which subreddit it actually came from. That was
 * true of the retired Django implementation too: `is_cross_post` only ever
 * suppressed the bare link `addLinkMedia()` would otherwise append (the
 * crosspost's `url` is the original post, so the link would point the reader
 * back at the article they are already reading).
 *
 * The subreddit the crosspost itself appeared in is deliberately *not* part of
 * this: it is the feed's own subreddit, which the reader already knows -- the
 * one thing the article does not carry is where the post came *from*.
 * `originalSubreddit` is `""` when Reddit's `crosspost_parent_list` entry
 * carries no `subreddit` (rare), which is distinct from a null attribution
 * meaning "not a crosspost at all".
 */
export interface CrosspostAttribution {
  originalSubreddit: string;
}

/**
 * The one-line "Crosspost: r/from" notice that opens a crosspost's body, the
 * subreddit name linking to that subreddit. Exported because
 * `extractContent()`'s JSON branch in `./aggregator.ts` builds its content
 * without going through `buildPostContent()` and has to emit the same notice
 * rather than a second version of it.
 *
 * With no origin known the notice degrades to the bare word, which still
 * answers the question the whole notice exists for -- is this a crosspost.
 */
export function buildCrosspostNoticeHtml(
  crosspost: CrosspostAttribution,
  labels: ChromeLabels,
): string {
  const origin = crosspost.originalSubreddit
    ? `: ${safeLinkHtml(
        `https://reddit.com/r/${crosspost.originalSubreddit}`,
        `r/${crosspost.originalSubreddit}`,
      )}`
    : "";

  return `<p><em>${escapeHtml(labels.crosspost)}${origin}</em></p>`;
}

/**
 * `buildPostContent()`'s return: the post's own body, and its comment section
 * kept separate rather than concatenated in. Callers that fingerprint or
 * render this content must pass `comments` through `formatArticleContent()`'s
 * `commentsContent` parameter -- never splice it into `body` themselves -- or
 * `articleContentHash()`'s comment exclusion
 * (`src/lib/aggregators/content-hash.ts`) cannot find it and a busy thread
 * rewrites the row on every aggregation cycle. See `ARTICLE_COMMENTS_CLASS` in
 * `../../extract/format` for the one place that wrapper is written.
 */
export interface RedditPostContent {
  body: string;
  comments: string | null;
}

export async function buildPostContent(
  post: RedditPostData,
  commentLimit: number,
  subreddit: string,
  labels: ChromeLabels,
  userId?: number | string | null,
  crosspost: CrosspostAttribution | null = null,
  commentsList?: RedditComment[],
  onLog?: (message: string) => void,
): Promise<RedditPostContent> {
  const contentParts: string[] = [];

  // 1. Crosspost notice -- first, so the reader knows what they are looking at
  // before the original post's own body starts.
  if (crosspost) {
    contentParts.push(buildCrosspostNoticeHtml(crosspost, labels));
  }

  // 2. Selftext
  if (post.selftext) {
    const selftextHtml = convertRedditMarkdown(post.selftext);
    contentParts.push(`<div>${selftextHtml}</div>`);
  }

  // 3. Gallery media
  addGalleryMedia(post, contentParts);

  // 4. Link media
  addLinkMedia(post, contentParts, Boolean(crosspost), labels);

  // 5. Comments section -- built separately, not pushed into contentParts. See
  // `RedditPostContent` above for why.
  const comments = await buildPostCommentsSection(
    post,
    commentLimit,
    subreddit,
    userId,
    labels,
    commentsList,
    onLog,
  );

  return { body: contentParts.join(""), comments };
}

function processGalleryItem(item: RedditGalleryItem, post: RedditPostData): string | null {
  const mediaId = item.media_id;
  if (!mediaId || !post.media_metadata) return null;

  const mediaInfo = post.media_metadata[mediaId];
  if (!mediaInfo) return null;

  const isAnimated = mediaInfo.e === "AnimatedImage";
  let mediaUrl: string | null = null;
  if (isAnimated) {
    mediaUrl = mediaInfo.s?.gif || mediaInfo.s?.mp4 || null;
  } else if (mediaInfo.e === "Image") {
    mediaUrl = mediaInfo.s?.u || null;
  }

  if (!mediaUrl) return null;

  const fixedUrl = fixRedditMediaUrl(decodeHtmlEntitiesInUrl(mediaUrl));
  const caption = item.caption || "";
  const alt = caption || (isAnimated ? "Animated GIF" : "Gallery image");

  const imgHtml = safeImgHtml(fixedUrl, alt);
  if (!imgHtml) return null;

  if (caption) {
    return `<figure>${imgHtml}<figcaption>${escapeHtml(alt)}</figcaption></figure>`;
  }
  return `<p>${imgHtml}</p>`;
}

function addGalleryMedia(post: RedditPostData, contentParts: string[]): void {
  if (!post.is_gallery || !post.media_metadata || !post.gallery_data) {
    return;
  }

  const items = post.gallery_data.items || [];
  for (const item of items) {
    const html = processGalleryItem(item, post);
    if (html) {
      contentParts.push(html);
    }
  }
}

function addLinkMedia(
  post: RedditPostData,
  contentParts: string[],
  isCrossPost: boolean,
  labels: ChromeLabels,
): void {
  if (!post.url || post.is_gallery) return;

  const url = decodeHtmlEntitiesInUrl(post.url);

  if (processLinkMedia(post, url, contentParts, labels)) {
    return;
  }

  if (!isCrossPost && !post.is_self) {
    contentParts.push(`<p>${safeLinkHtml(url, url)}</p>`);
  }
}

function processLinkMedia(
  post: RedditPostData,
  url: string,
  contentParts: string[],
  labels: ChromeLabels,
): boolean {
  const urlLower = url.toLowerCase();

  const giphyUrl = extractGiphyGifUrl(url);
  if (giphyUrl) {
    const imgHtml = safeImgHtml(giphyUrl, "Giphy");
    if (imgHtml) contentParts.push(`<p>${imgHtml}</p>`);
    return true;
  }

  // GIF media
  if (urlLower.endsWith(".gif") || urlLower.endsWith(".gifv")) {
    const gifUrl =
      extractAnimatedGifUrl(post) || (urlLower.endsWith(".gifv") ? url.slice(0, -1) : url);
    const fixedUrl = fixRedditMediaUrl(gifUrl);
    const imgHtml = safeImgHtml(fixedUrl, "Animated GIF");
    if (imgHtml) {
      contentParts.push(`<p>${imgHtml}</p>`);
    }
    return true;
  }

  // Direct image media
  const isImage =
    [".jpg", ".jpeg", ".png", ".webp"].some((ext) => urlLower.includes(ext)) ||
    urlLower.includes("i.redd.it");
  if (isImage) {
    const fixedUrl = fixRedditMediaUrl(url);
    if (fixedUrl) {
      contentParts.push(`<p>${safeLinkHtml(fixedUrl, fixedUrl)}</p>`);
    }
    return true;
  }

  // Video media
  if (urlLower.includes("v.redd.it")) {
    return true;
  }

  if (urlLower.includes("youtube.com") || urlLower.includes("youtu.be")) {
    contentParts.push(`<p>${safeLinkHtml(url, labels.viewVideoOnYoutube)}</p>`);
    return true;
  }

  // Twitter/X links
  return urlLower.includes("twitter.com") || urlLower.includes("x.com");
}

/**
 * Builds the comment section's own inner markup -- the caller wraps it (or
 * doesn't); this delegates to the shared `buildCommentsSection()`
 * (`src/lib/aggregators/comments/section.ts`) with `REDDIT_COMMENT_SPEC`
 * carrying no `wrapTag`, so the only `ARTICLE_COMMENTS_CLASS` wrapper in the
 * whole pipeline stays the one `formatArticleContent()` writes.
 *
 * Reddit's three empty states -- disabled, fetched-but-empty, and
 * fetch-failed -- are three separate calls into the shared builder, each with
 * its own `emptyLabel`, decided here before the (synchronous) shared builder
 * ever runs: which message applies depends on *why* there is no list, not
 * just on the list being empty.
 */
async function buildPostCommentsSection(
  post: RedditPostData,
  commentLimit: number,
  subreddit: string,
  userId: number | string | null | undefined,
  labels: ChromeLabels,
  providedComments?: RedditComment[],
  onLog?: (message: string) => void,
): Promise<string> {
  const decodedPermalink = decodeHtmlEntitiesInUrl(post.permalink);
  const permalink = `https://reddit.com${decodedPermalink}`;

  if (commentLimit <= 0) {
    return (
      buildCommentsSection(
        { ...REDDIT_COMMENT_SPEC, emptyLabel: "commentsDisabled" },
        [],
        permalink,
        0,
        labels,
        onLog,
      ) ?? ""
    );
  }

  try {
    const comments =
      providedComments !== undefined
        ? providedComments
        : await fetchPostComments(subreddit, post.id, commentLimit, userId);

    return (
      buildCommentsSection(
        { ...REDDIT_COMMENT_SPEC, emptyLabel: "noCommentsYet" },
        comments ?? [],
        permalink,
        commentLimit,
        labels,
        onLog,
      ) ?? ""
    );
  } catch (err) {
    // A 403/404 from the comments endpoint means the post itself is private,
    // removed or gone -- `fetchPostComments()` reports that as an
    // `ArticleSkipError` and the caller drops the article. Swallowing it here
    // would silently reinstate the bug that fix by degrading a skipped post
    // into one whose body says "Comments unavailable." Production always
    // pre-fetches (`aggregator.ts` passes `commentsList`), so this path is
    // reachable only from a future caller that does not -- which is exactly
    // when the guard has to already be here.
    if (err instanceof ArticleSkipError) throw err;
    return (
      buildCommentsSection(
        { ...REDDIT_COMMENT_SPEC, emptyLabel: "commentsUnavailable" },
        [],
        permalink,
        0,
        labels,
        onLog,
      ) ?? ""
    );
  }
}
