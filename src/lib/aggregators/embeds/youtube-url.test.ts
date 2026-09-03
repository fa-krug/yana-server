import fs from "node:fs";
import path from "node:path";

import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";

import {
  isYoutubeUrl,
  thumbnailUrlFor,
  youtubeIdFrom,
  YOUTUBE_EMBED_DOMAIN_ALTERNATION,
  YOUTUBE_IFRAME_KEEP_SELECTOR,
  YOUTUBE_URL_DOMAINS,
} from "./youtube-url";

const ROOT = path.resolve(import.meta.dirname, "../../../..");

/**
 * `youtube-url.ts` says it imports nothing "and must stay that way". That is
 * a comment; this is the tripwire, the same shape `src/lib/secrets.test.ts`
 * and `src/lib/auth/roles.test.ts` carry for their own dependency-free
 * modules -- CLAUDE.md's standard for the rule is "pinned … not just
 * asserted in a comment", and two of the other five dependency-free modules
 * shipped with only the comment for a while, which is the failure mode this
 * guards against.
 *
 * The rule is not tidiness: `src/components/articles/block-node.tsx` is a
 * client component that imports `youtubeIdFrom` from this module, so
 * anything reachable from here is in the browser bundle. One import of
 * `../images/store` (node fs) or `cheerio` would drag server-only code in
 * behind it, and the failure would be an opaque bundler error rather than
 * anything that names this file.
 */
describe("the youtube-url module's dependency contract", () => {
  it("imports nothing at all", () => {
    const source = fs
      .readFileSync(path.join(ROOT, "src/lib/aggregators/embeds/youtube-url.ts"), "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const specifiers = [
      ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);

    expect(specifiers).toEqual([]);
  });
});

describe("youtubeIdFrom", () => {
  const cases: [string, string | null][] = [
    // Standard watch URL
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Short URL
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Embed URL
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Privacy-embed domain -- copies 1 and 2 (extract/format.ts,
    // images/strategies.ts) never recognised this, which is the live bug:
    // isYoutubeUrl() accepted the domain, the extractor didn't, and the
    // embed fell through to a site's selectorsToRemove rule and was deleted.
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // /v/ URL
    ["https://www.youtube.com/v/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Shorts
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Livestream form -- same bug as nocookie: accepted by isYoutubeUrl(),
    // not by copies 1/2's extractor.
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Watch URL with extra params
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120", "dQw4w9WgXcQ"],
    // Mobile URL (matched via the bare "youtube.com" substring inside the
    // watch pattern -- m.youtube.com contains it)
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Invalid: empty
    ["", null],
    // Invalid: not a YouTube URL
    ["https://example.com/watch?v=dQw4w9WgXcQ", null],
    // Invalid: no id
    ["https://www.youtube.com/", null],
    // Partial match: regex stops at space/special chars, extracts "bad"
    ["https://www.youtube.com/watch?v=bad id!", "bad"],
  ];

  it.each(cases)("youtubeIdFrom(%s) -> %s", (input, expected) => {
    expect(youtubeIdFrom(input)).toBe(expected);
  });
});

describe("isYoutubeUrl", () => {
  it("accepts every domain the id extractor also accepts, plus bare youtu.be", () => {
    expect(isYoutubeUrl("https://www.youtube.com/watch?v=x")).toBe(true);
    expect(isYoutubeUrl("https://youtu.be/x")).toBe(true);
    expect(isYoutubeUrl("https://m.youtube.com/watch?v=x")).toBe(true);
    expect(isYoutubeUrl("https://www.youtube-nocookie.com/embed/x")).toBe(true);
  });

  it("rejects a non-YouTube URL and an empty string", () => {
    expect(isYoutubeUrl("https://example.com")).toBe(false);
    expect(isYoutubeUrl("")).toBe(false);
  });
});

describe("thumbnailUrlFor", () => {
  it("returns maxresdefault by default", () => {
    expect(thumbnailUrlFor("abc123")).toBe("https://img.youtube.com/vi/abc123/maxresdefault.jpg");
  });

  it("accepts an explicit quality", () => {
    expect(thumbnailUrlFor("abc123", "hqdefault")).toBe(
      "https://img.youtube.com/vi/abc123/hqdefault.jpg",
    );
  });
});

describe("YOUTUBE_EMBED_DOMAIN_ALTERNATION", () => {
  it("is a regex fragment matching both embed domains and nothing else", () => {
    const re = new RegExp(`^(?:${YOUTUBE_EMBED_DOMAIN_ALTERNATION})$`);
    expect(re.test("youtube.com")).toBe(true);
    expect(re.test("youtube-nocookie.com")).toBe(true);
    expect(re.test("evil.com")).toBe(false);
  });
});

describe("YOUTUBE_IFRAME_KEEP_SELECTOR", () => {
  /**
   * This selector is a hand-written CSS literal, kept in sync with
   * YOUTUBE_URL_DOMAINS by hand rather than derived from it (see the
   * constant's doc comment for why). This is the drift guard: an iframe
   * whose src contains any domain isYoutubeUrl() (and, by extension,
   * youtubeIdFrom()) recognises must survive this selector, or a site's
   * selectorsToRemove would delete it during extraction, one stage before
   * youtubeIdFrom() is ever consulted -- exactly the live bug this module
   * exists to close. Checked by actually running the selector against a real
   * iframe for each domain, not by asserting the domain string appears
   * literally in the selector: "m.youtube.com" is covered by the
   * :not([src*=\'youtube.com\']) clause as a substring match, with no
   * separate clause of its own, so a literal toContain(domain) check would
   * be a false failure for that one entry.
   */
  it("keeps an iframe alive for every domain YOUTUBE_URL_DOMAINS lists", () => {
    for (const domain of YOUTUBE_URL_DOMAINS) {
      const $ = cheerio.load(`<div><iframe src="https://${domain}/embed/abc"></iframe></div>`);
      $(YOUTUBE_IFRAME_KEEP_SELECTOR).remove();
      expect($("iframe").length, `expected an iframe on ${domain} to survive`).toBe(1);
    }
  });

  it("still removes a stray, non-YouTube iframe", () => {
    const $ = cheerio.load('<div><iframe src="https://evil.example.com/embed/abc"></iframe></div>');
    $(YOUTUBE_IFRAME_KEEP_SELECTOR).remove();
    expect($("iframe").length).toBe(0);
  });
});
