import { describe, expect, it } from "vitest";

import { articleContentHash } from "./content-hash";

const base = {
  name: "Post",
  html: "<p>body</p>",
  rawContent: "<html><p>body</p></html>",
  date: new Date("2026-01-01T00:00:00.000Z"),
  author: "ada",
  icon: null,
};

describe("articleContentHash", () => {
  it("is stable for identical input", () => {
    expect(articleContentHash(base)).toBe(articleContentHash({ ...base }));
  });

  it("changes when the block-source html changes", () => {
    // A new Reddit comment lands here: the comment section is rendered into
    // the article body, so the html differs and the article must be rewritten.
    expect(
      articleContentHash({ ...base, html: "<p>body</p><blockquote>new</blockquote>" }),
    ).not.toBe(articleContentHash(base));
  });

  it("changes when the stored rawContent changes even though html did not", () => {
    // The block tree is parsed from `content || raw_content` but the column
    // stores `raw_content || content` -- two different expressions, so both
    // have to be covered.
    expect(articleContentHash({ ...base, rawContent: "<html>other</html>" })).not.toBe(
      articleContentHash(base),
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
