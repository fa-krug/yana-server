import { and, eq, gte, inArray } from "drizzle-orm";

import { aiReadinessFor } from "../ai/readiness";
import { writeTransaction } from "../db/client";
import { feeds, userSettings, jobs } from "../db/schema";
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
        lastAggregationStartedAt: feeds.lastAggregationStartedAt,
        updateIntervalMinutes: feeds.updateIntervalMinutes,
        options: feeds.options,
      })
      .from(feeds)
      .where(eq(feeds.enabled, true))
      .all();

    // Every owner's settings row, read once per tick rather than once per
    // feed -- several feeds commonly share one owner. Keyed by userId so the
    // readiness check below is a map lookup, not a query per feed.
    const settingsByUserId = new Map(
      db
        .select()
        .from(userSettings)
        .all()
        .map((row) => [row.userId, row] as const),
    );

    // Every kind that runs (or delegates to) handleAggregateJob, in every
    // non-terminal status -- not just a pending "aggregate" row. A job
    // outlives one 60s tick whenever AI post-processing is on, so
    // status = 'pending' alone missed every job already claimed to
    // "running"; and kind = 'aggregate' alone missed "feed.update" (what
    // updateFeedsBulk() enqueues) entirely, which also runs the same
    // handler. See AGGREGATE_HANDLER_JOB_KINDS's doc comment.
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

      // The scheduler's own clock -- feeds.updatedAt is *not* read here on
      // purpose, because it carries $onUpdate and so is bumped by any write
      // to the row (a logo store, a /feeds edit), which used to postpone the
      // next aggregation by a full interval for reasons unrelated to
      // aggregating. lastAggregationStartedAt is stamped only by claim()
      // (src/lib/jobs/queue.ts), at the moment a job that runs this feed's
      // aggregation is picked up. A NULL value -- every feed that predates
      // the column, and every feed never yet aggregated by this mechanism --
      // reads as "never aggregated", i.e. immediately due, so lastRunTime
      // stays 0 for it: see feeds.lastAggregationStartedAt's doc comment.
      let lastRunTime = 0;
      if (item.lastAggregationStartedAt instanceof Date) {
        lastRunTime = item.lastAggregationStartedAt.getTime();
      } else if (typeof item.lastAggregationStartedAt === "number") {
        lastRunTime =
          item.lastAggregationStartedAt > 1e11
            ? item.lastAggregationStartedAt
            : item.lastAggregationStartedAt * 1000;
      }

      if (now.getTime() - lastRunTime >= intervalMs) {
        // Refuse to enqueue a feed whose AI options are on but whose owner
        // has no working provider -- see `aiReadinessFor()`'s doc comment.
        // Enqueueing anyway would run `handleAggregateJob`, which treats
        // every article's AI failure as transient and skips-and-retries it
        // forever; for this permanent misconfiguration that means every
        // article ages out of the feed's window and is lost for good, on a
        // job that reports success. One log line per feed per tick, not per
        // article -- the per-article log lives in `handleAggregateJob`
        // itself and would flood the job output at this volume.
        const readiness = aiReadinessFor(item.options, settingsByUserId.get(item.userId));
        if (readiness === "noProvider") {
          console.warn(
            `[Scheduler] skipping feed ${item.feedId}: AI options are on but no working ` +
              `AI provider is configured for its owner`,
          );
          continue;
        }

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
