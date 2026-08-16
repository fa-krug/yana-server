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
