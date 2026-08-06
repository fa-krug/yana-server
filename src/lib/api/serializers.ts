import type { Article, Feed, Tag } from "@/lib/db/schema";

export interface ArticleSummaryWire {
  id: number;
  feedId: number;
  name: string;
  identifier: string;
  date: string;
  author: string;
  icon: string | null;
  read: boolean;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
}

export function serializeArticleSummary(article: Article): ArticleSummaryWire {
  return {
    id: article.id,
    feedId: article.feedId,
    name: article.name,
    identifier: article.identifier,
    date: article.date.toISOString(),
    author: article.author,
    icon: article.icon,
    read: article.read,
    starred: article.starred,
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
  };
}

export interface FeedWire {
  id: number;
  name: string;
  aggregator: string;
  identifier: string;
  enabled: boolean;
  dailyLimit: number;
  updateIntervalMinutes: number;
  concurrency: number;
  tagIds: number[];
  logoImageHash: string | null;
  updatedAt: string;
}

export function serializeFeed(feed: Feed, tagIds: number[]): FeedWire {
  return {
    id: feed.id,
    name: feed.name,
    aggregator: feed.aggregator,
    identifier: feed.identifier,
    enabled: feed.enabled,
    dailyLimit: feed.dailyLimit,
    updateIntervalMinutes: feed.updateIntervalMinutes,
    concurrency: feed.concurrency,
    tagIds,
    logoImageHash: feed.logoImageHash,
    updatedAt: feed.updatedAt.toISOString(),
  };
}

export interface TagWire {
  id: number;
  name: string;
  color: string;
}

export function serializeTag(tag: Tag): TagWire {
  return { id: tag.id, name: tag.name, color: tag.color };
}
