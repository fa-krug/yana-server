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
    /**
     * Minutes between automatic aggregation runs for this feed. `0` disables
     * automatic updates entirely (see `src/lib/jobs/scheduler.ts`'s `tick()`).
     * Pre-filled from the aggregator's `recommendedIntervalMinutes` when a
     * feed is created (`src/lib/aggregators/specs.ts`), freely editable
     * afterward -- a recommendation, not an enforced limit.
     */
    updateIntervalMinutes: integer("update_interval_minutes").notNull().default(30),
    /**
     * Max in-flight per-article enrichment calls (header image extraction,
     * full-page fetch, comment fetches) during one aggregation run. Was the
     * hard-coded `ARTICLE_ENRICHMENT_CONCURRENCY` constant; now per-feed, with
     * the same pre-fill-from-recommendation behavior as `updateIntervalMinutes`.
     */
    concurrency: integer("concurrency").notNull().default(4),
    /**
     * Articles older than this, at fetch time, are dropped by
     * `BaseAggregator.filterArticles()` (`src/lib/aggregators/base.ts`) before
     * they're ever enriched or saved -- this is an ingestion filter, not a
     * retention policy (see `userSettings.articleRetentionDays` for that).
     * `0` disables the filter for this feed, same meaning `0` has on
     * `updateIntervalMinutes`: a feed whose source is a deliberate backlog
     * (a podcast's back-catalogue, a comic's archive) can opt out entirely
     * rather than losing everything older than 30 days on first aggregation.
     */
    maxArticleAgeDays: integer("max_article_age_days").notNull().default(30),
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

    /** Kept so the logo can be re-resolved without re-discovering the source. */
    logoSourceUrl: text("logo_source_url").notNull().default(""),
    /**
     * Content-addressed logo, referencing `articleImages.contentHash`.
     * Replaces the old file-path `logo` column, dropped in Task 7.
     */
    logoImageHash: text("logo_image_hash"),

    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    /**
     * `auto_now=True` in Django. `$onUpdate` is the port of that: it is
     * client-side (it does not appear in the DDL), so every write must go
     * through Drizzle for it to hold -- which the writeTransaction() convention
     * already requires. Declared here rather than at a dozen call sites across
     * phases 3-13, none of which would remember.
     *
     * **Not the scheduler's clock, on purpose.** `$onUpdate` fires on *any*
     * write to this row -- a `/feeds` name edit, `storeLogo()` writing
     * `logoImageHash`, `refreshLogos()` touching every feed at once -- none of
     * which means "this feed was just aggregated". `scheduler.ts`'s `tick()`
     * used to read this column as "last aggregation time" regardless, which
     * meant any of those unrelated writes silently postponed the feed's next
     * scheduled run by a full interval. `lastAggregationStartedAt`, below, is
     * the dedicated column that exists so the scheduler no longer has to
     * overload this one.
     */
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date()),
    /**
     * The scheduler's own clock, read by `scheduler.ts`'s `tick()` in place
     * of `updatedAt` (see that column's comment for why). Stamped by
     * `claim()` (`src/lib/jobs/queue.ts`), at the moment a job that runs
     * `handleAggregateJob` -- `"aggregate"` or `"feed.update"`, see
     * `AGGREGATE_HANDLER_JOB_KINDS` -- is claimed for this feed, never at
     * completion: stamping at claim is what makes the scheduler's
     * non-terminal-status dedupe (widened in plan 1) robust rather than
     * merely wider -- a long-running aggregation's feed reads as "just
     * started", not "still due", for the whole time it is in flight.
     * Nullable, and deliberately never backfilled: a `NULL` here means "this
     * feed has never been aggregated by this mechanism" -- true for every row
     * that predates the column -- and the scheduler treats that the same as
     * an aggregation from the epoch, so such a feed is picked up on the very
     * next tick rather than skipped or, if it were defaulted to "now"
     * instead, stampeding every existing feed's next run to line up.
     */
    lastAggregationStartedAt: integer("last_aggregation_started_at", { mode: "timestamp" }),
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
