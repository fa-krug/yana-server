import { and, eq, gte, inArray } from "drizzle-orm";

import { writeTransaction } from "../db/client";
import { feeds, jobs } from "../db/schema";
import { notifyAdmins } from "../email/error-notifications";
import { AGGREGATE_HANDLER_JOB_KINDS, NON_TERMINAL_JOB_STATUSES, enqueue } from "./queue";

const SCHEDULER_STARTED = Symbol.for("yana.scheduler.started");

// A due check is jittered by up to this fraction of the configured interval in
// either direction, so a 30-minute setting fires sometime in roughly
// [27, 33] minutes rather than at exactly the same offset every time --
// otherwise every feed on the same interval would poll in lockstep forever.
const INTERVAL_JITTER_FRACTION = 0.1;

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
    notifyAdmins({
      category: "scheduler",
      message: err instanceof Error ? (err.stack ?? err.message) : String(err),
      occurredAt: new Date(),
    });
  });

  schedulerTimer = setInterval(() => {
    tick().catch((err) => {
      console.error("[Scheduler] Error in scheduler tick:", err);
      notifyAdmins({
        category: "scheduler",
        message: err instanceof Error ? (err.stack ?? err.message) : String(err),
        occurredAt: new Date(),
      });
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
        userId: feeds.userId,
        updatedAt: feeds.updatedAt,
        updateIntervalMinutes: feeds.updateIntervalMinutes,
      })
      .from(feeds)
      .where(eq(feeds.enabled, true))
      .all();

    // Every kind that runs (or delegates to) handleAggregateJob, in every
    // non-terminal status -- not just a pending "aggregate" row. A job
    // outlives one 60s tick whenever AI post-processing is on, so
    // status = 'pending' alone missed every job already claimed to
    // "running"; and kind = 'aggregate' alone missed "feed.update" (what
    // updateFeedsBulk() enqueues) and "feed.restore" entirely, both of which
    // run the same handler. See AGGREGATE_HANDLER_JOB_KINDS's doc comment.
    const pendingAggregateJobs = db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          inArray(jobs.kind, AGGREGATE_HANDLER_JOB_KINDS),
          inArray(jobs.status, NON_TERMINAL_JOB_STATUSES),
        ),
      )
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

      const intervalMinutes = item.updateIntervalMinutes;
      if (intervalMinutes <= 0) {
        // 0 (or, defensively, negative) disables automatic updates for this feed.
        continue;
      }
      const baseIntervalMs = intervalMinutes * 60_000;
      const jitter = 1 + (Math.random() * 2 - 1) * INTERVAL_JITTER_FRACTION;
      const intervalMs = baseIntervalMs * jitter;

      // TODO(plan 2, docs/superpowers/plans/2026-09-03-pipeline-review-2-data-integrity.md):
      // feeds.updatedAt is overloaded as "last aggregated" -- it carries
      // $onUpdate, so *any* write to this feed (a logo store, a /feeds edit)
      // postpones the next aggregation by a full interval. Needs a dedicated
      // feeds.lastAggregationStartedAt column, stamped at claim time, which
      // needs a migration and belongs in that plan, not here.
      let lastRunTime = 0;
      if (item.updatedAt instanceof Date) {
        lastRunTime = item.updatedAt.getTime();
      } else if (typeof item.updatedAt === "number") {
        lastRunTime = item.updatedAt > 1e11 ? item.updatedAt : item.updatedAt * 1000;
      }

      if (now.getTime() - lastRunTime >= intervalMs) {
        enqueue("aggregate", { feedId: item.feedId }, { userId: item.userId });
        pendingFeedIds.add(item.feedId);
      }
    }

    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
    const recentRetentionJob = db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.kind, "retention"), gte(jobs.createdAt, oneDayAgo)))
      .limit(1)
      .get();

    if (!recentRetentionJob) {
      enqueue("retention", {});
    }
  });
}
