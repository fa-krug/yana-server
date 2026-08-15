import { and, count, desc, eq, inArray } from "drizzle-orm";

import { isAdminRole } from "@/lib/auth/roles";
import { currentUserId, requireUserFreshRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { articles, feeds, jobs, tags } from "@/lib/db/schema";
import type { JobStatus } from "@/lib/db/schema/enums";

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
  feedName: string;
};

// Jobs still in flight -- see src/app/(app)/jobs/page.tsx and
// src/lib/jobs/queue.ts. `jobs.status` is written by several functions
// there: `enqueue()`/`resetOrphaned()` write "pending", `claim()` writes
// "running", `complete()` writes "completed", `fail()` writes "failed" (or
// back to "pending" on a retry), and `requestCancel()`/`cancelled()` write
// the two-step cancellation path, "cancelling" then "cancelled". "cancelling"
// is non-terminal -- a running job asked to stop keeps executing until its
// handler notices `isCancelRequested()` at a checkpoint -- so it belongs here
// alongside "pending"/"running", not with the terminal statuses
// ("completed", "failed", "cancelled").
const ACTIVE_JOB_STATUSES: JobStatus[] = ["pending", "running", "cancelling"];

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
