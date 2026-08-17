import { and, count, desc, eq } from "drizzle-orm";

import { currentUserId } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { articles, feeds, tags } from "@/lib/db/schema";

export type DashboardStats = {
  unreadArticles: number;
  totalArticles: number;
  enabledFeeds: number;
  totalFeeds: number;
  tags: number;
};

export type RecentArticle = {
  id: number;
  name: string;
  date: Date;
  feedName: string;
};

/**
 * Summary counts for the dashboard's stat tiles.
 *
 * Uses `currentUserId()`, not `requireUserFreshRole()`: every count below is
 * scoped to the caller's own rows and none of them branches on role, the
 * pure-identity case CLAUDE.md's `requireUser()`/`requireUserFreshRole()`
 * bullet describes. The role read this function used to need existed only
 * for the now-removed "active jobs" tile, whose admin-sees-everything branch
 * was the one place here that cared who was an administrator.
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  const userId = await currentUserId();
  const db = getDb();

  const totalArticlesRow = db
    .select({ value: count() })
    .from(articles)
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(eq(feeds.userId, userId))
    .get();

  const unreadArticlesRow = db
    .select({ value: count() })
    .from(articles)
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(and(eq(feeds.userId, userId), eq(articles.read, false)))
    .get();

  const totalFeedsRow = db
    .select({ value: count() })
    .from(feeds)
    .where(eq(feeds.userId, userId))
    .get();

  const enabledFeedsRow = db
    .select({ value: count() })
    .from(feeds)
    .where(and(eq(feeds.userId, userId), eq(feeds.enabled, true)))
    .get();

  const tagsRow = db.select({ value: count() }).from(tags).where(eq(tags.userId, userId)).get();

  return {
    unreadArticles: unreadArticlesRow?.value ?? 0,
    totalArticles: totalArticlesRow?.value ?? 0,
    enabledFeeds: enabledFeedsRow?.value ?? 0,
    totalFeeds: totalFeedsRow?.value ?? 0,
    tags: tagsRow?.value ?? 0,
  };
}

/**
 * The newest unread articles owned by the current user.
 *
 * plainText and rawContent are deliberately absent from the selected columns:
 * they are the largest columns on the table and nothing here renders them.
 * Likewise `feedId`: nothing here renders it either, so it is not selected --
 * see `listArticles()` for the same pattern.
 *
 * Uses `currentUserId()`, not `requireUserFreshRole()`: this reads only
 * `user.id` and branches on nothing, the pure-identity case CLAUDE.md's
 * `requireUser()`/`requireUserFreshRole()` bullet describes -- matching
 * `listArticles()`, which reads the same way.
 */
export async function getRecentUnreadArticles(limit = 6): Promise<RecentArticle[]> {
  const userId = await currentUserId();
  const db = getDb();

  return db
    .select({
      id: articles.id,
      name: articles.name,
      date: articles.date,
      feedName: feeds.name,
    })
    .from(articles)
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(and(eq(feeds.userId, userId), eq(articles.read, false)))
    .orderBy(desc(articles.date), desc(articles.id))
    .limit(limit)
    .all();
}
