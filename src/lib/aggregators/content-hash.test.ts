import { describe, expect, it } from "vitest";

import { DEFAULT_CHROME_LABELS } from "./chrome-labels";
import { articleContentHash, rawArticleContentHash } from "./content-hash";
import {
  ARTICLE_COMMENTS_CLASS,
  ARTICLE_CONTENT_CLASS,
  formatArticleContent,
} from "./extract/format";
import { extractComments as extractMactechnewsComments } from "./sites/mactechnews/comments";
import { extractComments as extractMeinMmoComments } from "./sites/mein_mmo/comments";
import { buildPostContent } from "./sites/reddit/content";
import { RedditComment, RedditPostData } from "./sites/reddit/types";
import { YouTubeAggregator } from "./sites/youtube/aggregator";
import type { YouTubeCommentThread } from "./sites/youtube/client";

const base = {
  name: "Post",
  html: "<p>body</p>",
  date: new Date("2026-01-01T00:00:00.000Z"),
  author: "ada",
  icon: null,
};

describe("articleContentHash", () => {
  it("is stable for identical input", () => {
    expect(articleContentHash(base)).toBe(articleContentHash({ ...base }));
  });

  it("changes when the block-source html changes", () => {
    expect(
      articleContentHash({ ...base, html: "<p>body</p><blockquote>new</blockquote>" }),
    ).not.toBe(articleContentHash(base));
  });

  /**
   * **A comment is not the article.** `formatArticleContent()` renders the
   * comment section into the same body the block tree is parsed from, so
   * without the exclusion a busy thread rewrote the row on every cycle --
   * deleting and reinserting the block tree, spending an AI request, and
   * pushing the article back into `/api/v1`'s sync `updated` stream -- for
   * text nobody edited.
   */
  describe("the comment section", () => {
    const withComments = (comments: string) =>
      articleContentHash({
        ...base,
        html:
          `<section data-sanitized-class="${ARTICLE_CONTENT_CLASS}"><p>body</p></section>\n\n` +
          `<section data-sanitized-class="${ARTICLE_COMMENTS_CLASS}">${comments}</section>`,
      });

    it("does not change the fingerprint, however it changes", () => {
      expect(withComments("<blockquote>first</blockquote>")).toBe(
        withComments("<blockquote>first</blockquote><blockquote>second</blockquote>"),
      );
      // Including appearing and disappearing entirely.
      expect(withComments("")).toBe(withComments("<blockquote>later</blockquote>"));
    });

    it("does not hide a change to the article's own content", () => {
      const edited = articleContentHash({
        ...base,
        html:
          `<section data-sanitized-class="${ARTICLE_CONTENT_CLASS}"><p>body, revised</p></section>\n\n` +
          `<section data-sanitized-class="${ARTICLE_COMMENTS_CLASS}"><blockquote>a</blockquote></section>`,
      });
      expect(edited).not.toBe(withComments("<blockquote>a</blockquote>"));
    });

    /**
     * `sanitizeClassNames()` rewrites every `class` into
     * `data-sanitized-class`, so a source page carrying
     * `class="article-comments"` reaches the fingerprint looking like our own
     * wrapper. The cut takes the *last* occurrence, so a lookalike earlier in
     * the body cannot truncate the real content.
     */
    it("cuts the real wrapper, not a lookalike earlier in the body", () => {
      const withLookalike = (body: string) =>
        articleContentHash({
          ...base,
          html:
            `<section data-sanitized-class="${ARTICLE_COMMENTS_CLASS}">${body}</section>\n\n` +
            `<section data-sanitized-class="${ARTICLE_COMMENTS_CLASS}"><blockquote>real</blockquote></section>`,
        });
      expect(withLookalike("<p>quoted markup</p>")).not.toBe(withLookalike("<p>edited</p>"));
    });

    /**
     * **The wrapper is written in one file and cut in another**, and only
     * `ARTICLE_COMMENTS_CLASS` ties them together. Driving real
     * `formatArticleContent()` output through the fingerprint is what stops a
     * rename from silently ending the exclusion.
     */
    it("looks past a section that formatArticleContent actually produced", () => {
      const labels = { comments: "Comments" } as unknown as Parameters<
        typeof formatArticleContent
      >[3];
      const rendered = (comments: string | null) =>
        formatArticleContent(
          "<p>body</p>",
          "Post",
          "https://example.com/1",
          labels,
          null,
          null,
          comments,
        );

      expect(rendered("<blockquote>a</blockquote>")).toContain(ARTICLE_COMMENTS_CLASS);

      const fingerprint = (comments: string | null) =>
        articleContentHash({ ...base, html: rendered(comments) });
      expect(fingerprint("<blockquote>a</blockquote>")).toBe(
        fingerprint("<blockquote>a</blockquote><blockquote>b</blockquote>"),
      );
      expect(fingerprint(null)).toBe(fingerprint("<blockquote>later</blockquote>"));
    });
  });

  /**
   * Every commenting site must thread its comment markup through
   * `formatArticleContent()`'s `commentsContent` parameter rather than
   * concatenating it into the block-source html itself -- that parameter is
   * the only thing `withoutComments()` above can find. Reddit and YouTube
   * used to build a bare, unwrapped comment section straight into their
   * content, so a busy Reddit thread or a YouTube video's comments changing
   * gave every active one of those articles a new fingerprint on every
   * aggregation cycle -- rewriting the row, deleting and reinserting the
   * block tree, and spending a paid AI request, for text nobody edited.
   *
   * One case per commenting site, so a sixth site added later has an obvious
   * pattern to copy: build the comment markup, hand it to
   * `formatArticleContent()` as `commentsContent`, never splice it into the
   * body yourself.
   */
  describe("every commenting site keeps comments out of its own fingerprint", () => {
    it("Reddit", async () => {
      const post = new RedditPostData({
        id: "abc123",
        permalink: "/r/test/comments/abc123/title/",
        is_self: true,
        selftext: "the post body",
      });

      const render = async (comments: RedditComment[]) => {
        const postContent = await buildPostContent(
          post,
          10,
          "test",
          DEFAULT_CHROME_LABELS,
          null,
          null,
          comments,
        );
        return formatArticleContent(
          postContent.body,
          "A post",
          "https://reddit.com/r/test/comments/abc123/title/",
          DEFAULT_CHROME_LABELS,
          null,
          null,
          postContent.comments,
        );
      };

      const first = await render([new RedditComment({ id: "c1", body: "first" })]);
      const second = await render([
        new RedditComment({ id: "c1", body: "first" }),
        new RedditComment({ id: "c2", body: "second" }),
      ]);

      expect(first).toContain(ARTICLE_COMMENTS_CLASS);
      expect(articleContentHash({ ...base, html: first })).toBe(
        articleContentHash({ ...base, html: second }),
      );
    });

    it("YouTube", () => {
      const agg = new YouTubeAggregator({ identifier: "UCtest", dailyLimit: 20, options: {} });
      const description = agg.buildDescriptionHtml("the video description");

      const render = (comments: YouTubeCommentThread[]) => {
        const commentsHtml = agg.buildCommentsHtml(comments, "vid1", DEFAULT_CHROME_LABELS);
        return formatArticleContent(
          description,
          "A video",
          "https://www.youtube.com/watch?v=vid1",
          DEFAULT_CHROME_LABELS,
          null,
          null,
          commentsHtml,
        );
      };

      const first = render([
        { id: "c1", snippet: { topLevelComment: { snippet: { textDisplay: "first" } } } },
      ]);
      const second = render([
        { id: "c1", snippet: { topLevelComment: { snippet: { textDisplay: "first" } } } },
        { id: "c2", snippet: { topLevelComment: { snippet: { textDisplay: "second" } } } },
      ]);

      expect(first).toContain(ARTICLE_COMMENTS_CLASS);
      expect(articleContentHash({ ...base, html: first })).toBe(
        articleContentHash({ ...base, html: second }),
      );
    });

    it("MacTechNews", () => {
      const articleUrl = "https://www.mactechnews.de/news/article/Some-Article-123456.html";
      const rawPage = (commentText: string) => `
        <div class="MtnCommentScroll">
          <div class="MtnComment" id="c1">
            <span class="MtnCommentAccountName">Someone</span>
            <div class="MtnCommentText">${commentText}</div>
          </div>
        </div>`;

      const render = (commentText: string) => {
        const commentsHtml = extractMactechnewsComments(
          rawPage(commentText),
          articleUrl,
          5,
          DEFAULT_CHROME_LABELS,
        );
        return formatArticleContent(
          "<p>body</p>",
          "An article",
          articleUrl,
          DEFAULT_CHROME_LABELS,
          null,
          null,
          commentsHtml,
        );
      };

      const first = render("first");
      const second = render("second, edited");

      expect(first).toContain(ARTICLE_COMMENTS_CLASS);
      expect(articleContentHash({ ...base, html: first })).toBe(
        articleContentHash({ ...base, html: second }),
      );
    });

    it("Mein MMO", () => {
      const articleUrl = "https://mein-mmo.de/some-article/";
      const rawPage = (commentText: string) => `
        <div class="wpd-thread-list">
          <div class="wpd-comment">
            <div class="wpd-comment-text">${commentText}</div>
          </div>
        </div>`;

      const render = (commentText: string) => {
        const commentsHtml = extractMeinMmoComments(
          rawPage(commentText),
          articleUrl,
          5,
          DEFAULT_CHROME_LABELS,
        );
        return formatArticleContent(
          "<p>body</p>",
          "An article",
          articleUrl,
          DEFAULT_CHROME_LABELS,
          null,
          null,
          commentsHtml,
        );
      };

      const first = render("first");
      const second = render("second, edited");

      expect(first).toContain(ARTICLE_COMMENTS_CLASS);
      expect(articleContentHash({ ...base, html: first })).toBe(
        articleContentHash({ ...base, html: second }),
      );
    });

    /**
     * Heise's own comment extraction (`HeiseAggregator.extractComments()`)
     * fetches the forum page over the network, so it is exercised in
     * `sites/heise.test.ts` instead -- this pins the same guarantee at the
     * point heise's `processContent()` actually applies it: whatever markup
     * comes back is handed to `formatArticleContent()` as `commentsContent`,
     * never concatenated into the article body.
     */
    it("Heise (formatArticleContent call site)", () => {
      const render = (comments: string) =>
        formatArticleContent(
          "<p>body</p>",
          "An article",
          "https://www.heise.de/-1234567",
          DEFAULT_CHROME_LABELS,
          null,
          null,
          `<section><h3>Comments</h3>${comments}</section>`,
        );

      const first = render("<blockquote>first</blockquote>");
      const second = render("<blockquote>first</blockquote><blockquote>second</blockquote>");

      expect(first).toContain(ARTICLE_COMMENTS_CLASS);
      expect(articleContentHash({ ...base, html: first })).toBe(
        articleContentHash({ ...base, html: second }),
      );
    });
  });

  /**
   * The raw page is not an input: `mactechnews`, `mein_mmo` and `heise` scrape
   * their comments out of the very page they fetched, so hashing it would let
   * a comment rewrite the article through the back door and undo the exclusion
   * above.
   */
  it("ignores the raw page a full-website aggregator stashes", () => {
    const article = { name: "Post", content: "<p>body</p>", date: base.date, author: "ada" };
    expect(rawArticleContentHash({ ...article, raw_content: "<html>page v1</html>" })).toBe(
      rawArticleContentHash({ ...article, raw_content: "<html>v2, one more comment</html>" }),
    );
  });

  it.each(["name", "author"] as const)("changes when %s changes", (field) => {
    expect(articleContentHash({ ...base, [field]: "different" })).not.toBe(
      articleContentHash(base),
    );
  });

  it("changes when the icon changes, including to and from null", () => {
    const withIcon = articleContentHash({ ...base, icon: "https://example.com/a.png" });
    expect(withIcon).not.toBe(articleContentHash(base));
    expect(articleContentHash({ ...base, icon: null })).toBe(articleContentHash(base));
  });

  it("changes when the feed's own date changes", () => {
    expect(articleContentHash({ ...base, date: new Date("2026-01-02T00:00:00.000Z") })).not.toBe(
      articleContentHash(base),
    );
  });

  it("treats a missing date as a stable value, not as a fresh timestamp", () => {
    // The handler's fallback is `raw.date || new Date()`. Hashing the stored
    // value would differ on every run for any feed that supplies no dates,
    // so the hash covers the feed's own value -- null included.
    expect(articleContentHash({ ...base, date: null })).toBe(
      articleContentHash({ ...base, date: null }),
    );
    expect(articleContentHash({ ...base, date: null })).not.toBe(articleContentHash(base));
  });

  it("cannot be fooled by shifting content across field boundaries", () => {
    expect(articleContentHash({ ...base, name: "Post<p>body</p>", html: "" })).not.toBe(
      articleContentHash(base),
    );
  });
});
