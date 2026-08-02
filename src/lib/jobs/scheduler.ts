import { and, eq, gte } from "drizzle-orm";

import { writeTransaction } from "../db/client";
import { feeds, jobs, userSettings } from "../db/schema";
import { enqueue } from "./queue";

const SCHEDULER_STARTED = Symbol.for("yana.scheduler.started");

interface GlobalWithScheduler {
  [SCHEDULER_STARTED]?: boolean;
}

let schedulerTimer: NodeJS.Timeout | null = null;

export function isSchedulerRunning(): boolean {
  const g = globalThis as GlobalWithScheduler;
  return Boolean(g[SCHEDULER_STARTED] && schedulerTimer !== null);
}

export function startScheduler(options?: { tickIntervalMs?: number }): void {
  const g = globalThis as GlobalWithScheduler;
  if (g[SCHEDULER_STARTED] || schedulerTimer !== null) {
    return;
  }

  g[SCHEDULER_STARTED] = true;

  const intervalMs = options?.tickIntervalMs ?? 60_000;

  tick().catch((err) => {
    console.error("[Scheduler] Error in scheduler tick:", err);
  });

  schedulerTimer = setInterval(() => {
    tick().catch((err) => {
      console.error("[Scheduler] Error in scheduler tick:", err);
    });
  }, intervalMs);
}

export function stopScheduler(): void {
  const g = globalThis as GlobalWithScheduler;
  g[SCHEDULER_STARTED] = false;
  if (schedulerTimer !== null) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

export async function tick(): Promise<void> {
  const now = new Date();

  writeTransaction((db) => {
    const activeFeeds = db
      .select({
        feedId: feeds.id,
        updatedAt: feeds.updatedAt,
        updateIntervalMinutes: userSettings.updateIntervalMinutes,
      })
      .from(feeds)
      .leftJoin(userSettings, eq(feeds.userId, userSettings.userId))
      .where(eq(feeds.enabled, true))
      .all();

    const pendingAggregateJobs = db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(and(eq(jobs.kind, "aggregate"), eq(jobs.status, "pending")))
      .all();

    const pendingFeedIds = new Set<number>();
    for (const j of pendingAggregateJobs) {
      if (typeof j.payload?.feedId === "number") {
        pendingFeedIds.add(j.payload.feedId);
      }
    }

    for (const item of activeFeeds) {
      if (pendingFeedIds.has(item.feedId)) {
        continue;
      }

      const intervalMinutes = item.updateIntervalMinutes ?? 30;
      const intervalMs = intervalMinutes * 60_000;

      let lastRunTime = 0;
      if (item.updatedAt instanceof Date) {
        lastRunTime = item.updatedAt.getTime();
      } else if (typeof item.updatedAt === "number") {
        lastRunTime = item.updatedAt > 1e11 ? item.updatedAt : item.updatedAt * 1000;
      }

      if (now.getTime() - lastRunTime >= intervalMs) {
        enqueue("aggregate", { feedId: item.feedId });
        pendingFeedIds.add(item.feedId);
      }
    }

    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
    const recentRetentionJob = db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, "retention"),
          gte(jobs.createdAt, oneDayAgo),
        ),
      )
      .limit(1)
      .get();

    if (!recentRetentionJob) {
      enqueue("retention", {});
    }
  });
}
