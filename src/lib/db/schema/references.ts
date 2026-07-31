import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Autocomplete cache for the feeds form. */
export const redditSubreddits = sqliteTable(
  "reddit_subreddits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    displayName: text("display_name").notNull(),
    title: text("title").notNull().default(""),
    subscribers: integer("subscribers").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [uniqueIndex("reddit_subreddits_name_unique").on(table.displayName)],
);

export const youtubeChannels = sqliteTable(
  "youtube_channels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: text("channel_id").notNull(),
    title: text("title").notNull(),
    handle: text("handle").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("youtube_channels_channel_id_unique").on(table.channelId),
    index("youtube_channels_title_idx").on(table.title),
  ],
);

export type RedditSubreddit = typeof redditSubreddits.$inferSelect;
export type NewRedditSubreddit = typeof redditSubreddits.$inferInsert;
export type YoutubeChannel = typeof youtubeChannels.$inferSelect;
export type NewYoutubeChannel = typeof youtubeChannels.$inferInsert;
