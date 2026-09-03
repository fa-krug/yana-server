import { createHash } from "node:crypto";

import { ARTICLE_COMMENTS_CLASS } from "./extract/format";

/** The opening tag `formatArticleContent()` wraps a comment section in. */
const COMMENTS_OPENING_TAG = `<section data-sanitized-class="${ARTICLE_COMMENTS_CLASS}">`;

/**
 * `html` with any comment section cut off.
 *
 * **A comment changing is not the article changing.**
 * `formatArticleContent()` renders comments into the same body the block tree
 * is parsed from, so without this a busy thread rewrote the row on every
 * cycle -- deleting and reinserting the block tree, spending an AI request,
 * and pushing the article back into `/api/v1`'s sync `updated` stream -- for
 * text nobody edited.
 *
 * **Cut at the marker rather than parsed, deliberately.** A parser would mean
 * `cheerio` in this module's graph, which the aggregate handler imports before
 * it has decided to do any work at all. The cut is safe because
 * `formatArticleContent()` appends the comment section *last* and joins its
 * sections with `\n\n`: everything from that tag onward is comments.
 * `lastIndexOf` rather than `indexOf` for the one hazard that remains --
 * `sanitizeClassNames()` rewrites every `class` into `data-sanitized-class`,
 * so a source page whose own markup carries `class="article-comments"` reaches
 * here looking like our wrapper, and taking the *last* occurrence still finds
 * the real one.
 *
 * The result is trimmed because removing the last section leaves that `\n\n`
 * separator dangling, and a body plus trailing whitespace does not hash to the
 * same value as the same body without it -- which is precisely the case this
 * exists to make equal.
 */
function withoutComments(html: string): string {
  const marker = html.lastIndexOf(COMMENTS_OPENING_TAG);
  return (marker === -1 ? html : html.slice(0, marker)).trim();
}

/**
 * Everything that determines what an aggregated article stores -- both the
 * `articles` row and the block tree derived from it.
 *
 * `date` is the feed's *own* value, not the value that gets stored. The
 * handler's fallback is `raw.date || new Date()`, so hashing the stored value
 * would produce a fresh hash on every run for any feed whose items carry no
 * date, and the skip would never fire.
 *
 * **A comment section in `html` is not an input**, and neither is the raw
 * page -- see `withoutComments()` above for the first, and
 * `rawArticleContentHash()` below for why the second had to go with it.
 * `plainText` deliberately is not an input either: it is a pure function of
 * `html`, so it is already covered, and computing it would mean parsing the
 * blocks before we know whether we need them.
 */
export interface ArticleContentInput {
  name: string;
  /** What the block tree is parsed from. Any comment section is ignored. */
  html: string;
  /** The feed's own date, or null when the feed supplied none. */
  date: Date | null;
  author: string;
  icon: string | null;
}

/**
 * A content fingerprint for one aggregated article, stored in
 * `articles.contentHash`. When a later aggregation run computes the same value
 * the row and its blocks are already correct and every write is skipped --
 * which is also what keeps an unchanged article out of `/api/v1`'s sync
 * `updated` stream, since `articles.updatedAt` carries `$onUpdate`.
 *
 * The fields are joined via `JSON.stringify` over an array rather than a
 * delimiter, so no value can be shifted across a field boundary to collide
 * with a different input.
 */
export function articleContentHash(input: ArticleContentInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.name,
        withoutComments(input.html),
        input.date ? input.date.toISOString() : null,
        input.author,
        input.icon,
      ]),
    )
    .digest("hex");
}

/**
 * The `RawArticle` fields the fingerprint is derived from, structurally rather
 * than by importing `RawArticle` from `./base` -- that module imports the AI
 * runtime, and this one is deliberately dependency-free apart from `node:crypto`.
 */
export interface RawArticleFingerprintSource {
  name?: string;
  content?: string;
  raw_content?: string;
  date?: Date | null;
  author?: string;
  icon?: string | null;
}

/**
 * The one derivation of `ArticleContentInput` from a freshly aggregated
 * article, called by `handleAggregateJob()` before it does anything else with
 * the row.
 *
 * **It fingerprints the article as *fetched*, and the ordering that makes that
 * true is load-bearing.** AI post-processing runs *below* this check now
 * (`applyAiToBlocks()`, on the block tree, in the job handler), so nothing in
 * this value can depend on model output. It did once: the AI stage (then
 * `applyAiOptions()`) rewrote `name` and `content` in place inside the
 * aggregator pipeline, upstream of the handler, so the fingerprint was a hash
 * of a non-deterministic answer -- a different string on every run at the
 * default `ai_temperature` of 0.3. Everything the hash exists to prevent was
 * therefore happening every cycle for exactly the feeds with AI enabled: full
 * rewrite, block tree deleted and reinserted, `updatedAt` bumped, article back
 * in `/api/v1`'s sync `updated` stream. And the far larger cost, because the
 * skip sat downstream of the provider request it should have prevented: every
 * article sent to the provider again on every run.
 *
 * So a change that moves AI back above this call re-breaks both at once.
 *
 * `content || raw_content` mirrors what the block tree is parsed from.
 *
 * **The raw page is not hashed, and that follows from the comment exclusion
 * rather than being a separate idea.** `mactechnews`, `mein_mmo` and `heise`
 * scrape their comments out of the very page they fetched, so hashing the page
 * would let a new comment rewrite the article through the back door and undo
 * `withoutComments()` for exactly the feeds that have comments. Reddit and
 * YouTube keep their comments out of this fingerprint too, the same way --
 * through `formatArticleContent()`'s `commentsContent` parameter rather than
 * by scraping a page, since both get comments from an API instead -- so the
 * full site list for the exclusion above is five, not three; the raw-page
 * angle here is specific to the three that actually scrape one. Excluding it
 * is also what left `articles.rawContent` with no reader at all -- see the
 * note on the `articles` table for why that column is now gone.
 */
export function rawArticleContentHash(raw: RawArticleFingerprintSource): string {
  return articleContentHash({
    name: raw.name || "Untitled",
    html: raw.content || raw.raw_content || "",
    date: raw.date ?? null,
    author: raw.author || "",
    icon: raw.icon || null,
  });
}
