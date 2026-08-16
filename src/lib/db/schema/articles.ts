import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { feeds } from "./feeds";
import { users } from "./users";

/**
 * `content` from the Django model is deliberately absent: it held processed HTML
 * that blocks were rebuilt from, and blocks are authoritative here. `rawContent`
 * remains as the debugging surface and as what phase 12's reload action re-runs.
 */
export const articles = sqliteTable(
  "articles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    /** URL or external id. */
    identifier: text("identifier").notNull(),
    rawContent: text("raw_content").notNull().default(""),
    /** Block tree flattened to visible text, for search. */
    plainText: text("plain_text").notNull().default(""),
    /**
     * Fingerprint of the aggregator inputs that produced this row and its
     * block tree (see `articleContentHash` in
     * `@/lib/aggregators/content-hash`). The aggregate handler compares it
     * before writing: an unchanged article is skipped entirely, which avoids
     * rewriting the row, avoids deleting and reinserting the whole block
     * tree, and -- because `updatedAt` carries `$onUpdate` -- keeps the
     * article out of `/api/v1`'s sync `updated` stream.
     *
     * Nullable, and written *last* on purpose: a stored hash means "row and
     * blocks are both up to date for this content", so a crash mid-write
     * leaves it null or stale and the next run redoes the work. Every row
     * that predates this column is null, is therefore treated as changed,
     * and settles after one aggregation pass -- no backfill needed.
     */
    contentHash: text("content_hash"),
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
 * the data: imageRef is indexed (orphan pruning becomes a join) and
 * embedProvider is indexed ("articles containing video" becomes answerable).
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
    index("article_blocks_embed_provider_idx").on(table.embedProvider),
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
    id: integer("id").primaryKey({ autoIncrement: true }),
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
    index("article_inline_runs_block_idx").on(table.blockId, table.position),
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
