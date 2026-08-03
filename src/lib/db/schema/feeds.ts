import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { redditSubreddits, youtubeChannels } from "./references";
import { users } from "./users";

/** Replaces Django's FeedGroup. Many-per-feed via feedTags. */
export const tags = sqliteTable(
  "tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    color: text("color").notNull().default("red"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
  (table) => [uniqueIndex("tags_name_user_unique").on(table.name, table.userId)],
);

export const feeds = sqliteTable(
  "feeds",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    aggregator: text("aggregator").notNull().default("full_website"),
    /** URL or external id. Required for reddit and youtube, optional elsewhere. */
    identifier: text("identifier").notNull().default(""),
    dailyLimit: integer("daily_limit").notNull().default(20),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Autocomplete relationships, mirroring Feed.reddit_subreddit / youtube_channel.
    redditSubredditId: integer("reddit_subreddit_id").references(() => redditSubreddits.id, {
      onDelete: "set null",
    }),
    youtubeChannelId: integer("youtube_channel_id").references(() => youtubeChannels.id, {
      onDelete: "set null",
    }),

    /**
     * Aggregator-specific configuration. Stays JSON in the column, but is typed
     * in code by the per-aggregator Zod registry (phase 9), which also generates
     * the create/edit form body.
     */
    options: text("options", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),

    logo: text("logo"),
    /** Kept so the logo can be re-resolved without re-discovering the source. */
    logoSourceUrl: text("logo_source_url").notNull().default(""),

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
    index("feeds_user_idx").on(table.userId),
    index("feeds_aggregator_idx").on(table.aggregator),
    /**
     * Django's JSONField emitted `CHECK (JSON_VALID("options") OR "options" IS
     * NULL)` on SQLite; this column is NOT NULL, so the first half suffices.
     *
     * Keep it. Without it a malformed write succeeds and the row becomes
     * poison: every subsequent *read* throws inside Drizzle's
     * `mapFromDriverValue` when it tries to `JSON.parse` the column, which is
     * far harder to trace back than a rejected insert.
     */
    check("feeds_options_json", sql`json_valid("options")`),
  ],
);

export const feedTags = sqliteTable(
  "feed_tags",
  {
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.feedId, table.tagId] }),
    // Reverse lookup: "which feeds carry this tag" drives the sidebar.
    index("feed_tags_tag_idx").on(table.tagId),
  ],
);

export type Feed = typeof feeds.$inferSelect;
export type NewFeed = typeof feeds.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type FeedTag = typeof feedTags.$inferSelect;
export type NewFeedTag = typeof feedTags.$inferInsert;
