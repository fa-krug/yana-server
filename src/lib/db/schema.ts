import { relations } from "drizzle-orm";

import { articleBlocks, articleInlineRuns, articles } from "./schema/articles";
import { accounts, passkeys, sessions } from "./schema/auth";
import { feedTags, feeds, tags } from "./schema/feeds";
import { redditSubreddits, youtubeChannels } from "./schema/references";
import { userSettings, users } from "./schema/users";

export * from "./schema/ai";
export * from "./schema/articles";
export * from "./schema/auth";
export * from "./schema/enums";
export * from "./schema/feeds";
export * from "./schema/jobs";
export * from "./schema/references";
export * from "./schema/users";

export const usersRelations = relations(users, ({ many, one }) => ({
  feeds: many(feeds),
  tags: many(tags),
  settings: one(userSettings),
  // Better Auth's satellite tables. It never traverses these itself -- its
  // adapter issues plain selects -- but the account page (task 6) lists a
  // user's passkeys and sessions, and an untraversed relation is a relation
  // nobody proved works. `verifications` has no user FK, so it has no relation.
  sessions: many(sessions),
  accounts: many(accounts),
  passkeys: many(passkeys),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const passkeysRelations = relations(passkeys, ({ one }) => ({
  user: one(users, { fields: [passkeys.userId], references: [users.id] }),
}));

/**
 * The FK-holding side of the one-to-one. `usersRelations.settings` is the
 * non-FK side, which carries no `fields`/`references`, so without this
 * declaration Drizzle cannot infer the join and every relational query
 * touching it throws at runtime -- see relations.test.ts.
 */
export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  owner: one(users, { fields: [userSettings.userId], references: [users.id] }),
}));

export const feedsRelations = relations(feeds, ({ many, one }) => ({
  owner: one(users, { fields: [feeds.userId], references: [users.id] }),
  articles: many(articles),
  feedTags: many(feedTags),
  // The autocomplete associations. Phase 9's feed create/edit form joins these
  // for display, so they need to be traversable, not just constrained.
  redditSubreddit: one(redditSubreddits, {
    fields: [feeds.redditSubredditId],
    references: [redditSubreddits.id],
  }),
  youtubeChannel: one(youtubeChannels, {
    fields: [feeds.youtubeChannelId],
    references: [youtubeChannels.id],
  }),
}));

export const tagsRelations = relations(tags, ({ many, one }) => ({
  owner: one(users, { fields: [tags.userId], references: [users.id] }),
  feedTags: many(feedTags),
}));

export const feedTagsRelations = relations(feedTags, ({ one }) => ({
  feed: one(feeds, { fields: [feedTags.feedId], references: [feeds.id] }),
  tag: one(tags, { fields: [feedTags.tagId], references: [tags.id] }),
}));

export const articlesRelations = relations(articles, ({ many, one }) => ({
  feed: one(feeds, { fields: [articles.feedId], references: [feeds.id] }),
  blocks: many(articleBlocks),
}));

export const articleBlocksRelations = relations(articleBlocks, ({ many, one }) => ({
  article: one(articles, { fields: [articleBlocks.articleId], references: [articles.id] }),
  parent: one(articleBlocks, {
    fields: [articleBlocks.parentId],
    references: [articleBlocks.id],
    relationName: "blockTree",
  }),
  children: many(articleBlocks, { relationName: "blockTree" }),
  runs: many(articleInlineRuns),
}));

export const articleInlineRunsRelations = relations(articleInlineRuns, ({ one }) => ({
  block: one(articleBlocks, {
    fields: [articleInlineRuns.blockId],
    references: [articleBlocks.id],
  }),
}));
