import { describe, expect, it } from "vitest";

import {
  ARTICLE_COMMENTS_CLASS,
  ARTICLE_CONTENT_CLASS,
  formatArticleContent,
} from "./extract/format";
import { sourceFingerprint } from "./source-fingerprint";

const base = {
  name: "Post",
  content: "<p>body</p>",
  date: new Date("2026-01-01T00:00:00.000Z"),
  author: "ada",
  icon: null,
};

describe("sourceFingerprint", () => {
  it("is stable for identical input", () => {
    expect(sourceFingerprint(base)).toBe(sourceFingerprint({ ...base }));
  });

  it("changes when the block-source html changes", () => {
    expect(
      sourceFingerprint({ ...base, content: "<p>body</p><blockquote>new</blockquote>" }),
    ).not.toBe(sourceFingerprint(base));
  });

  /**
   * **A comment is not the article.** `formatArticleContent()` renders the
   * comment section into the same body the block tree is parsed from, so
   * without this a busy thread rewrote the row on every cycle -- re-running
   * whatever AI the feed configured and pushing the article back into
   * `/api/v1`'s sync `updated` stream for text nobody edited.
   */
  describe("the comment section", () => {
    const withComments = (comments: string) =>
      sourceFingerprint({
        ...base,
        content:
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
      const edited = sourceFingerprint({
        ...base,
        content:
          `<section data-sanitized-class="${ARTICLE_CONTENT_CLASS}"><p>body, revised</p></section>\n\n` +
          `<section data-sanitized-class="${ARTICLE_COMMENTS_CLASS}"><blockquote>first</blockquote></section>`,
      });
      expect(edited).not.toBe(withComments("<blockquote>first</blockquote>"));
    });

    /**
     * `sanitizeClassNames()` rewrites every `class` into
     * `data-sanitized-class`, so a source page whose own markup carries
     * `class="article-comments"` reaches the fingerprint looking like our
     * wrapper. Only a `<section>` is stripped -- a `<div>` in the body is
     * still the article.
     */
    it("only strips a section, so a same-named div in the body still counts", () => {
      const a = sourceFingerprint({
        ...base,
        content: `<div data-sanitized-class="${ARTICLE_COMMENTS_CLASS}"><p>real body</p></div>`,
      });
      const b = sourceFingerprint({
        ...base,
        content: `<div data-sanitized-class="${ARTICLE_COMMENTS_CLASS}"><p>real body, edited</p></div>`,
      });
      expect(a).not.toBe(b);
    });
  });

  /**
   * **The wrapper is written in one file and stripped in another**, and only
   * `ARTICLE_COMMENTS_CLASS` ties the two together. This drives real
   * `formatArticleContent()` output through the fingerprint rather than
   * hand-written markup, so renaming the wrapper cannot silently stop the
   * stripping -- which would restart the rewrite-per-comment loop with nothing
   * failing.
   */
  it("looks past a comment section that formatArticleContent actually produced", () => {
    const labels = {
      comments: "Comments",
      readMore: "Read more",
      noCommentsYet: "No comments yet.",
      commentsDisabled: "Comments disabled.",
      commentsUnavailable: "Comments unavailable.",
    } as unknown as Parameters<typeof formatArticleContent>[3];

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

    // The markup really does carry the wrapper the fingerprint matches on --
    // otherwise the equalities below would hold for the wrong reason.
    expect(rendered("<blockquote>first</blockquote>")).toContain(ARTICLE_COMMENTS_CLASS);

    const fingerprint = (comments: string | null) =>
      sourceFingerprint({ ...base, content: rendered(comments) });

    expect(fingerprint("<blockquote>first</blockquote>")).toBe(
      fingerprint("<blockquote>first</blockquote><blockquote>second</blockquote>"),
    );
    expect(fingerprint(null)).toBe(fingerprint("<blockquote>later</blockquote>"));
  });

  /**
   * The raw page is not a fingerprint input: `mactechnews`, `mein_mmo` and
   * `heise` scrape comments out of the very page they fetched, so hashing it
   * would rewrite the article for a comment through the back door.
   */
  it("ignores the raw page a full-website aggregator stashes", () => {
    const article = { name: "Post", content: "<p>body</p>", date: base.date, author: "ada" };
    expect(sourceFingerprint({ ...article, raw_content: "<html>page v1</html>" })).toBe(
      sourceFingerprint({ ...article, raw_content: "<html>page v2, one more comment</html>" }),
    );
  });

  it.each(["name", "author"] as const)("changes when %s changes", (field) => {
    expect(sourceFingerprint({ ...base, [field]: "different" })).not.toBe(sourceFingerprint(base));
  });

  it("changes when the icon changes, including to and from null", () => {
    const withIcon = sourceFingerprint({ ...base, icon: "https://example.com/a.png" });
    expect(withIcon).not.toBe(sourceFingerprint(base));
    expect(sourceFingerprint({ ...base, icon: null })).toBe(sourceFingerprint(base));
  });

  it("changes when the feed's own date changes", () => {
    expect(sourceFingerprint({ ...base, date: new Date("2026-01-02T00:00:00.000Z") })).not.toBe(
      sourceFingerprint(base),
    );
  });

  it("treats a missing date as a stable value, not as a fresh timestamp", () => {
    // The handler's fallback is `raw.date || new Date()`. Hashing the stored
    // value would differ on every run for any feed that supplies no dates,
    // so the hash covers the feed's own value -- null included.
    expect(sourceFingerprint({ ...base, date: null })).toBe(
      sourceFingerprint({ ...base, date: null }),
    );
    expect(sourceFingerprint({ ...base, date: null })).not.toBe(sourceFingerprint(base));
  });

  it("cannot be fooled by shifting content across field boundaries", () => {
    expect(sourceFingerprint({ ...base, name: "Post<p>body</p>", content: "" })).not.toBe(
      sourceFingerprint(base),
    );
  });
});
