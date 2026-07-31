import { relations } from "drizzle-orm";

import { articleBlocks, articleImages, articleInlineRuns, articles } from "./schema/articles";
import { feedTags, feeds, tags } from "./schema/feeds";
import { jobs } from "./schema/jobs";
import { redditSubreddits, youtubeChannels } from "./schema/references";
import { userSettings, users } from "./schema/users";

export * from "./schema/articles";
export * from "./schema/enums";
export * from "./schema/feeds";
export * from "./schema/jobs";
export * from "./schema/references";
export * from "./schema/users";

export const usersRelations = relations(users, ({ many, one }) => ({
  feeds: many(feeds),
  tags: many(tags),
  settings: one(userSettings),
}));

export const feedsRelations = relations(feeds, ({ many, one }) => ({
  owner: one(users, { fields: [feeds.userId], references: [users.id] }),
  articles: many(articles),
  feedTags: many(feedTags),
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

// Referenced for completeness so the barrel's export surface is explicit.
export { articleImages, jobs, redditSubreddits, youtubeChannels };
