import { and, count, desc, eq, inArray } from "drizzle-orm";

import { isAdminRole } from "@/lib/auth/roles";
import { requireUserFreshRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { articles, feeds, jobs, tags } from "@/lib/db/schema";

export type DashboardStats = {
  unreadArticles: number;
  totalArticles: number;
  enabledFeeds: number;
  totalFeeds: number;
  tags: number;
  activeJobs: number;
};

export type RecentArticle = {
  id: number;
  name: string;
  date: Date;
  feedId: number;
  feedName: string;
};

// Jobs still in flight -- see src/app/(app)/jobs/page.tsx and
// src/lib/jobs/queue.ts, whose claim/complete/fail transitions are the only
// writers of `jobs.status`.
const ACTIVE_JOB_STATUSES = ["pending", "running"];

/**
 * Summary counts for the dashboard's stat tiles.
 *
 * Uses `requireUserFreshRole()`, not `requireUser()`: an admin demoted a
 * moment ago must not keep seeing every user's active jobs off a stale
 * cookie-cached role, the same reason `/jobs` reads it this way.
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  const user = await requireUserFreshRole();
  const admin = isAdminRole(user.role);
  const db = getDb();

  const totalArticlesRow = db
    .select({ value: count() })
    .from(articles)
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(eq(feeds.userId, user.id))
    .get();

  const unreadArticlesRow = db
    .select({ value: count() })
    .from(articles)
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(and(eq(feeds.userId, user.id), eq(articles.read, false)))
    .get();

  const totalFeedsRow = db
    .select({ value: count() })
    .from(feeds)
    .where(eq(feeds.userId, user.id))
    .get();

  const enabledFeedsRow = db
    .select({ value: count() })
    .from(feeds)
    .where(and(eq(feeds.userId, user.id), eq(feeds.enabled, true)))
    .get();

  const tagsRow = db.select({ value: count() }).from(tags).where(eq(tags.userId, user.id)).get();

  // An admin sees every active job, ownerless ones included; a non-admin sees
  // only their own -- same rule `/jobs` and `/jobs/[id]` follow.
  const activeJobsRow = db
    .select({ value: count() })
    .from(jobs)
    .where(
      admin
        ? inArray(jobs.status, ACTIVE_JOB_STATUSES)
        : and(inArray(jobs.status, ACTIVE_JOB_STATUSES), eq(jobs.userId, user.id)),
    )
    .get();

  return {
    unreadArticles: unreadArticlesRow?.value ?? 0,
    totalArticles: totalArticlesRow?.value ?? 0,
    enabledFeeds: enabledFeedsRow?.value ?? 0,
    totalFeeds: totalFeedsRow?.value ?? 0,
    tags: tagsRow?.value ?? 0,
    activeJobs: activeJobsRow?.value ?? 0,
  };
}

/**
 * The newest unread articles owned by the current user.
 *
 * plainText and rawContent are deliberately absent from the selected columns:
 * they are the largest columns on the table and nothing here renders them.
 */
export async function getRecentUnreadArticles(limit = 6): Promise<RecentArticle[]> {
  const user = await requireUserFreshRole();
  const db = getDb();

  return db
    .select({
      id: articles.id,
      name: articles.name,
      date: articles.date,
      feedId: articles.feedId,
      feedName: feeds.name,
    })
    .from(articles)
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(and(eq(feeds.userId, user.id), eq(articles.read, false)))
    .orderBy(desc(articles.date), desc(articles.id))
    .limit(limit)
    .all();
}
