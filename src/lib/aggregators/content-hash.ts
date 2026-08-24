import { createHash } from "node:crypto";

/**
 * Everything that determines what an aggregated article stores -- both the
 * `articles` row and the block tree derived from it.
 *
 * `date` is the feed's *own* value, not the value that gets stored. The
 * handler's fallback is `raw.date || new Date()`, so hashing the stored value
 * would produce a fresh hash on every run for any feed whose items carry no
 * date, and the skip would never fire.
 *
 * `html` and `rawContent` are both here because they are two different
 * expressions over the same raw article: the block tree is parsed from
 * `content || raw_content` while the column stores `raw_content || content`.
 * `plainText` deliberately is not: it is a pure function of `html`, so it is
 * already covered, and computing it would mean parsing the blocks before we
 * know whether we need them.
 */
export interface ArticleContentInput {
  name: string;
  /** What the block tree is parsed from. */
  html: string;
  /** What lands in `articles.rawContent`. */
  rawContent: string;
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
        input.html,
        input.rawContent,
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
 * article, shared by the two places that need the same fingerprint for the
 * same article: `BaseAggregator.fingerprintArticles()` computes it *before*
 * AI post-processing runs, and `handleAggregateJob()` reads that precomputed
 * value back rather than deriving a second one.
 *
 * The two halves used to be one expression in the job handler, computed
 * *after* `applyAiOptions()` had already rewritten `name` and `content` in
 * place -- which made the fingerprint a hash of model output. At the default
 * `ai_temperature` of 0.3 that is a different string on every run, so the
 * "nothing changed, skip every write" branch could never fire for a feed with
 * any AI option enabled: every article was rewritten, re-parsed and pushed
 * back into `/api/v1`'s sync `updated` stream on every aggregation cycle, and
 * -- far more expensively -- every article was sent to the provider again on
 * every cycle, because the skip that would have prevented it was downstream of
 * the call it needed to prevent. Fingerprinting the article as *fetched* is
 * what makes the value stable, and therefore what makes the skip work at all.
 *
 * The `content || raw_content` / `raw_content || content` pair mirrors what
 * the handler stores: the block tree is parsed from the first, the
 * `articles.rawContent` column holds the second.
 */
export function rawArticleContentHash(raw: RawArticleFingerprintSource): string {
  return articleContentHash({
    name: raw.name || "Untitled",
    html: raw.content || raw.raw_content || "",
    rawContent: raw.raw_content || raw.content || "",
    date: raw.date ?? null,
    author: raw.author || "",
    icon: raw.icon || null,
  });
}
