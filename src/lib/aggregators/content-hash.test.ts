import { describe, expect, it } from "vitest";

import { articleContentHash, rawArticleContentHash } from "./content-hash";
import {
  ARTICLE_COMMENTS_CLASS,
  ARTICLE_CONTENT_CLASS,
  formatArticleContent,
} from "./extract/format";

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
