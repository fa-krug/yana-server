import { createHash } from "node:crypto";

import * as cheerio from "cheerio";

import { ARTICLE_COMMENTS_CLASS } from "./extract/format";

/**
 * The subset of a `RawArticle` the fingerprint reads.
 *
 * Declared structurally rather than importing `RawArticle` from `./base`,
 * which would make this module depend on the aggregator that calls it.
 */
export interface FingerprintableArticle {
  name?: string;
  content?: string;
  raw_content?: string;
  date?: Date | null;
  author?: string;
  icon?: string | null;
}

/** Built from the constant the wrapper is written with, never restated. */
const COMMENTS_SELECTOR = `section[data-sanitized-class="${ARTICLE_COMMENTS_CLASS}"]`;

/**
 * `html` with any comment section removed.
 *
 * **Parsed rather than cut at the marker string.** `sanitizeClassNames()`
 * rewrites every `class` attribute into `data-sanitized-class`, so a source
 * page whose own markup carries `class="article-comments"` would otherwise
 * truncate the real content at that point. Matching element *and* attribute is
 * narrow enough to be safe, and cheerio gets the nesting right where a regex
 * would not. Only a `<section>` is stripped; a same-named `<div>` in the body
 * is still the article.
 *
 * **Both paths `.trim()`, and that is load-bearing rather than tidiness.**
 * `formatArticleContent()` joins its sections with `\n\n`, so removing the last
 * one leaves that separator dangling -- and a body plus trailing whitespace
 * does not hash to the same value as the same body without it, which is
 * precisely the "comments changed, article did not" case this exists to make
 * equal. The article-only string reaches the hash identically whether or not a
 * comment section was ever appended.
 */
function withoutComments(html: string): string {
  if (!html.includes(ARTICLE_COMMENTS_CLASS)) return html.trim();
  const $ = cheerio.load(html, { xml: { decodeEntities: false } }, false);
  $(COMMENTS_SELECTOR).remove();
  return $.html().trim();
}

/**
 * **The fingerprint of the source an aggregated article came from**, stored in
 * `articles.sourceHash`. When a later aggregation run computes the same value,
 * the row and its block tree are already a complete rendering of that source
 * and everything is skipped -- the AI call in `applyAiProcessing()`
 * (`./base`), then the row write and block rebuild in the aggregate handler.
 *
 * There is one function and one definition of "the source", because the
 * fingerprint is only useful if every caller computes it identically: the
 * aggregator takes it *before* AI post-processing, the handler takes it for
 * feeds that have none, and a mismatch between them is invisible -- the values
 * simply stop agreeing and every article looks changed forever.
 *
 * What it covers, and the four decisions behind that:
 *
 * - **`name`, `content`, `date`, `author`, `icon`**, with the same fallbacks
 *   the handler applies when it stores a row (`content || raw_content`,
 *   `"Untitled"`, `""`, `null`), so the fingerprint describes the thing that
 *   actually gets persisted.
 * - **`date` is the feed's *own* value, never the stored one.** The handler
 *   falls back to `raw.date || new Date()`, so hashing the stored value would
 *   produce a fresh hash on every run for any feed whose items carry no date,
 *   and the skip would never fire.
 * - **The comment section is stripped.** `formatArticleContent()` renders
 *   comments into the same body the block tree is parsed from, so without this
 *   a busy thread rewrote the row every cycle -- re-running whatever AI the
 *   feed configured and pushing the article back into `/api/v1`'s sync
 *   `updated` stream -- for text nobody edited. It governs what *triggers* a
 *   rewrite, not what gets stored: when the article's own content changes, the
 *   current comments ride along into the row as before.
 * - **The raw page (`raw_content` on the in-memory article) is not an input at
 *   all**, beyond standing in for `content` when an aggregator produced none.
 *   `mactechnews`, `mein_mmo` and `heise` scrape their comments out of the very
 *   page they fetched, so hashing it would let a comment rewrite the article
 *   through the back door, defeating the exclusion above. Excluding it here is
 *   also what showed the `articles.raw_content` column to be dead weight --
 *   nothing read it, and nothing about a row depended on it being current --
 *   which is why that column is gone.
 *
 * `plainText` is not an input either: it is a pure function of the html, so it
 * is already covered, and computing it would mean parsing the blocks before we
 * know whether we need them.
 *
 * The fields are joined via `JSON.stringify` over an array rather than a
 * delimiter, so no value can be shifted across a field boundary to collide
 * with a different input.
 */
export function sourceFingerprint(raw: FingerprintableArticle): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        raw.name || "Untitled",
        withoutComments(raw.content || raw.raw_content || ""),
        raw.date ? raw.date.toISOString() : null,
        raw.author || "",
        raw.icon || null,
      ]),
    )
    .digest("hex");
}
