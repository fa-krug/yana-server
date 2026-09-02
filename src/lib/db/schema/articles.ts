import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { feeds } from "./feeds";
import { users } from "./users";

/**
 * Django's `content` and this table's own former `raw_content` are both
 * deliberately absent: the block tree is authoritative, and every column that
 * held a copy of the source HTML alongside it was written and never read.
 *
 * `raw_content` held the whole fetched page. It was kept as "the debugging
 * surface, and what the reload action re-runs against" -- the second half was
 * never true (`article.reload` re-fetches the page itself), and the first was
 * paid for on every article view, because `getArticle()` selects the whole row
 * and hands it to a client component, which put a full HTML page into the RSC
 * payload of `/articles/[id]`. It was also excluded from the source
 * fingerprint (see `sourceHash`), so nothing about the row depended on it
 * being current either.
 */
export const articles = sqliteTable(
  "articles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    /** URL or external id. */
    identifier: text("identifier").notNull(),
    /** Block tree flattened to visible text, for search. */
    plainText: text("plain_text").notNull().default(""),
    /**
     * **The fingerprint of the source this row was derived from** --
     * `sourceFingerprint()` in `@/lib/aggregators/source-fingerprint`, taken
     * over the article *as the source gave it* and before any AI
     * post-processing rewrote it.
     *
     * One column carrying one rule: **an article needs work unless its stored
     * fingerprint equals the one the source produces now.** Two readers apply
     * that rule at different costs. `applyAiProcessing()`
     * (`@/lib/aggregators/base`) applies it first, to decide whether to call
     * an AI provider at all; the aggregate handler applies it again, to decide
     * whether to rewrite the row, delete and reinsert the whole block tree,
     * and -- because `updatedAt` carries `$onUpdate` -- put the article back
     * into `/api/v1`'s sync `updated` stream.
     *
     * **Nullable, and null means "needs work".** That is how the column
     * carries completeness as well as identity, and why it is written *last*,
     * after `writeBlocks()`: a crash anywhere above leaves it null and the
     * next run redoes everything. Rows predating the column are null, are
     * therefore treated as changed, and settle after one pass -- no backfill.
     * The same state is written deliberately by the aggregate handler when a
     * feed's configured AI pass did not complete, and by a *failed* reload,
     * which replaces the body with an error notice: without it that notice
     * would stand forever, because the source it came from has not moved.
     *
     * **It fingerprints the source, not the bytes stored, and that is what
     * lets a deliberate local change stick.** A successful `article.reload`
     * and `updateArticle()` (a manual edit) both rewrite the row and both
     * leave this column alone: the source has not changed, so the next run
     * matches, skips, and the human's version stands -- while a genuine
     * upstream edit still moves the fingerprint and correctly replaces it.
     * Nulling it would make every manual action provisional until the next
     * cycle discarded it, which is exactly what both writers used to do.
     *
     * THE INVARIANT, for anything that writes here: **null it when the row
     * stops being a complete rendering of that source, and leave it alone
     * when the source itself has not changed.** Writers that only flip
     * `read`/`starred` touch neither. The trap that remains is a change to
     * `parseBlocks`/`plainTextOf`: existing articles would never be
     * re-parsed, because their sources have not moved -- that needs a
     * deliberate one-off `UPDATE articles SET source_hash = NULL`.
     */
    sourceHash: text("source_hash"),
    /**
     * The feed's real publish time. Aggregation never rewrites it, and it is for
     * display only -- never for retention or sync cursors. See createdAt.
     */
    date: integer("date", { mode: "timestamp" }).notNull(),
    read: integer("read", { mode: "boolean" }).notNull().default(false),
    starred: integer("starred", { mode: "boolean" }).notNull().default(false),
    author: text("author").notNull().default(""),
    /** Per-article header image, written by the header-element extractor. */
    icon: text("icon"),
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    /**
     * Stable, append-only ordering key. Retention and the phase 13 sync cursor
     * both key off this, NOT off `date`: keying retention off `date` would delete
     * articles almost immediately whenever their publish date already sits near
     * the retention cutoff.
     */
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    /**
     * `auto_now=True` in Django. `$onUpdate` is the port of that: it is
     * client-side (it does not appear in the DDL), so every write must go
     * through Drizzle for it to hold -- which the writeTransaction() convention
     * already requires. Declared here rather than at a dozen call sites across
     * phases 3-13, none of which would remember.
     */
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("articles_feed_identifier_idx").on(table.feedId, table.identifier),
    index("articles_feed_date_idx").on(table.feedId, table.date),
    index("articles_date_idx").on(table.date),
    index("articles_read_idx").on(table.read),
    index("articles_starred_idx").on(table.starred),
    index("articles_feed_read_date_idx").on(table.feedId, table.read, table.date),
    // Sync cursor: createdAt with id as tie-breaker.
    index("articles_created_id_idx").on(table.createdAt, table.id),
    index("articles_feed_created_idx").on(table.feedId, table.createdAt),
    // Sync cursor, `updated` stream: the counterpart to
    // `articles_created_id_idx`. `syncArticles` orders by
    // `updatedAt ASC, id ASC` with a LIMIT; without this the query
    // full-scans and builds a temp B-tree on every sync call.
    index("articles_updated_id_idx").on(table.updatedAt, table.id),
  ],
);

/**
 * Records a hard-deleted article for phase 13's sync `removed` list.
 *
 * `userId` is denormalized on purpose: once the article (and possibly its
 * feed) is gone, nothing else lets this row be scoped to its owner. Every
 * hard-delete path (retention, feed deletion, feed restore) must insert one
 * of these for each affected article *before* the delete, inside the same
 * `writeTransaction()`.
 */
export const articleTombstones = sqliteTable(
  "article_tombstones",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    articleId: integer("article_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deletedAt: integer("deleted_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("article_tombstones_user_deleted_idx").on(table.userId, table.deletedAt, table.id),
  ],
);

export type ArticleTombstone = typeof articleTombstones.$inferSelect;
export type NewArticleTombstone = typeof articleTombstones.$inferInsert;

/**
 * One node of an article body in the Yana content format.
 *
 * Typed rows rather than an opaque JSON document, so the database understands
 * the data: imageRef and embedThumbnailRef are indexed because the images
 * route's ownership check joins on them (orphan pruning too, for imageRef).
 */
export const articleBlocks = sqliteTable(
  "article_blocks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    parentId: integer("parent_id").references((): AnySQLiteColumn => articleBlocks.id, {
      onDelete: "cascade",
    }),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),

    level: integer("level"), // heading
    ordered: integer("ordered", { mode: "boolean" }), // list
    text: text("text").notNull().default(""), // code_block
    language: text("language").notNull().default(""), // code_block
    imageRef: text("image_ref").notNull().default(""), // image

    embedProvider: text("embed_provider").notNull().default(""),
    embedThumbnailRef: text("embed_thumbnail_ref").notNull().default(""),
    embedExternalUrl: text("embed_external_url").notNull().default(""),
    embedTitle: text("embed_title").notNull().default(""),
  },
  (table) => [
    /**
     * KNOWN LIMITATION, carried over deliberately: SQLite treats NULLs as
     * distinct in a unique index, so this does NOT cover root-level rows where
     * parentId IS NULL. Root position uniqueness is enforced in application
     * code -- see the block writer. Do not "fix" this by dropping the
     * constraint; it still covers every nested row.
     */
    uniqueIndex("uniq_block_position").on(table.articleId, table.parentId, table.position),
    index("article_blocks_tree_idx").on(table.articleId, table.parentId, table.position),
    index("article_blocks_image_ref_idx").on(table.imageRef),
    // GET /api/v1/images/[hash] ownership path 3 queries embedThumbnailRef on
    // equality (an embed's localized poster is stored there); without this it scans.
    index("article_blocks_embed_thumbnail_ref_idx").on(table.embedThumbnailRef),
    // Django's PositiveIntegerField / PositiveSmallIntegerField emitted these
    // as real CHECK constraints on SQLite; they are part of the schema, not an
    // ORM nicety. `level` is nullable, and `NULL >= 0` evaluates to NULL,
    // which SQLite treats as satisfied -- the same behavior Django had, so no
    // `OR ... IS NULL` half is needed.
    check("article_blocks_position_positive", sql`"position" >= 0`),
    check("article_blocks_level_positive", sql`"level" >= 0`),
  ],
);

/**
 * A styled span inside a paragraph, heading or image caption.
 *
 * Four real booleans, not a bitmask: the reason to choose rows over a JSON
 * document is that the database understands the data, and an opaque integer
 * would hand that back.
 */
export const articleInlineRuns = sqliteTable(
  "article_inline_runs",
  {
    blockId: integer("block_id")
      .notNull()
      .references(() => articleBlocks.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    bold: integer("bold", { mode: "boolean" }).notNull().default(false),
    italic: integer("italic", { mode: "boolean" }).notNull().default(false),
    code: integer("code", { mode: "boolean" }).notNull().default(false),
    strikethrough: integer("strikethrough", { mode: "boolean" }).notNull().default(false),
    link: text("link").notNull().default(""),
  },
  (table) => [
    // (blockId, position) is the natural key: nothing FKs into this table, and
    // every read orders by exactly these columns. The PK also serves the index
    // the dropped article_inline_runs_block_idx used to provide.
    primaryKey({ columns: [table.blockId, table.position] }),
    check("article_inline_runs_position_positive", sql`"position" >= 0`),
  ],
);

/**
 * Content-addressed image, referenced from block trees as `yana-img://<hash>`.
 *
 * The hash is SHA-256 over the *stored* (compressed) bytes, so one row per
 * distinct byte sequence: the same image across ten articles is stored once.
 * Unowned on purpose -- deduplication crosses users.
 */
export const articleImages = sqliteTable(
  "article_images",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentHash: text("content_hash").notNull(),
    file: text("file").notNull(),
    contentType: text("content_type").notNull(),
    width: integer("width"),
    height: integer("height"),
    byteSize: integer("byte_size").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("article_images_hash_unique").on(table.contentHash),
    index("article_images_created_idx").on(table.createdAt),
    // Django's PositiveIntegerField, again. `width` and `height` are nullable;
    // see the note on article_blocks for why that needs no extra clause.
    check("article_images_width_positive", sql`"width" >= 0`),
    check("article_images_height_positive", sql`"height" >= 0`),
    check("article_images_byte_size_positive", sql`"byte_size" >= 0`),
  ],
);

export type Article = typeof articles.$inferSelect;
export type NewArticle = typeof articles.$inferInsert;
export type ArticleBlock = typeof articleBlocks.$inferSelect;
export type NewArticleBlock = typeof articleBlocks.$inferInsert;
export type ArticleInlineRun = typeof articleInlineRuns.$inferSelect;
export type NewArticleInlineRun = typeof articleInlineRuns.$inferInsert;
export type ArticleImage = typeof articleImages.$inferSelect;
export type NewArticleImage = typeof articleImages.$inferInsert;
