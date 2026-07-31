import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { feeds } from "./feeds";

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
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
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
  ],
);

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
  (table) => [index("article_inline_runs_block_idx").on(table.blockId, table.position)],
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
