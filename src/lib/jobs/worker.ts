import {
  appendLogLine,
  cancelled,
  claim,
  complete,
  fail,
  requestCancel,
  resetOrphaned,
} from "./queue";
import { JobCancelledError } from "./errors";
import { getHandler } from "./handlers";
import { notifyAdmins } from "../email/error-notifications";

const WORKER_STARTED = Symbol.for("yana.worker.started");

interface GlobalWithWorker {
  [WORKER_STARTED]?: boolean;
}

let isLoopActive = false;

/**
 * How many `runWorkerLoop()` instances `startWorker()` runs concurrently when
 * no explicit `concurrency` and no `WORKER_CONCURRENCY` env var is given.
 * Matches `feeds.concurrency`'s own default (see `schema/feeds.ts`) -- there
 * is no reason job-level concurrency should be more conservative than the
 * per-feed article concurrency this same process already runs unattended.
 * Still overridable per instance via `WORKER_CONCURRENCY` for a host that
 * genuinely can't sustain four concurrent handlers (e.g. a single-core box).
 */
const DEFAULT_WORKER_CONCURRENCY = 4;

/**
 * Each loop independently `claim()`s and executes jobs -- safe to run
 * concurrently because `claim()`'s conditional `UPDATE ... WHERE status =
 * 'pending'` (inside `BEGIN IMMEDIATE`) is a compare-and-swap: two loops
 * racing for the same row can never both win it (see `schema/jobs.ts` and
 * `queue.ts`'s `claim()`). An invalid or unset `WORKER_CONCURRENCY` falls back
 * to `DEFAULT_WORKER_CONCURRENCY` rather than throwing, matching this
 * codebase's other env-configured numbers (e.g. `SMTP_PORT`).
 */
function resolveConcurrency(explicit?: number): number {
  if (explicit !== undefined) {
    return Math.max(1, Math.floor(explicit));
  }
  const fromEnv = Number(process.env.WORKER_CONCURRENCY);
  return Number.isInteger(fromEnv) && fromEnv >= 1 ? fromEnv : DEFAULT_WORKER_CONCURRENCY;
}

export function isWorkerRunning(): boolean {
  const g = globalThis as GlobalWithWorker;
  return Boolean(g[WORKER_STARTED] && isLoopActive);
}

export function startWorker(options?: {
  pollIntervalMs?: number;
  timeoutMs?: number;
  concurrency?: number;
}): void {
  const g = globalThis as GlobalWithWorker;
  if (g[WORKER_STARTED]) {
    return;
  }

  g[WORKER_STARTED] = true;
  isLoopActive = true;

  // Startup: reset orphaned running rows whose startedAt predates this
  // process. Safe to run once here, before any loop below starts claiming --
  // every loop this process spawns starts after this point, so there is no
  // live claim of this process's own to clobber.
  resetOrphaned(new Date());

  const concurrency = resolveConcurrency(options?.concurrency);

  // One promise per loop. `reportedFatal` is shared across every loop's
  // `.catch()` so N loops crashing at once (or in quick succession) still
  // notifies admins once, not N times for what reads as a single incident --
  // and any one loop escaping its own try/catch (which, per runWorkerLoop's
  // comments, should never happen) stops every other loop in this process
  // too, rather than silently running on reduced, unannounced capacity.
  let reportedFatal = false;
  for (let i = 0; i < concurrency; i++) {
    runWorkerLoop(options).catch((err) => {
      console.error("[Worker] Fatal error in worker loop:", err);
      if (!reportedFatal) {
        reportedFatal = true;
        notifyAdmins({
          category: "worker",
          message: err instanceof Error ? (err.stack ?? err.message) : String(err),
          occurredAt: new Date(),
        });
      }
      g[WORKER_STARTED] = false;
      isLoopActive = false;
    });
  }
}

export function stopWorker(): void {
  const g = globalThis as GlobalWithWorker;
  g[WORKER_STARTED] = false;
  isLoopActive = false;
}

export async function runWorkerLoop(options?: {
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<void> {
  const pollInterval = options?.pollIntervalMs ?? 2000;
  const timeoutMs = options?.timeoutMs ?? 300_000;

  isLoopActive = true;

  while (isLoopActive) {
    const job = claim();
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      continue;
    }

    const handler = getHandler(job.kind);
    if (!handler) {
      fail(job.id, `No handler registered for job kind '${job.kind}'`);
      continue;
    }

    appendLogLine(job.id, "stdout", `job started (attempt ${job.attempts}/${job.maxAttempts})`);

    // A hard `Promise.race()` timeout here does not stop the handler -- there
    // is no way to preempt in-flight `await`s from the outside, so the
    // "timed out" promise this used to race against was pure theater: the
    // real handler kept running to completion in the background, writing to
    // `articles`/`feeds` and calling `progress()`/`appendLogLine()` under this
    // same job id, no longer supervised by anything. Worse, `fail()` would
    // requeue the job as `pending`, so `claim()` could pick up a *second*,
    // fully concurrent execution of the same job while the first was still
    // silently running -- two live handlers racing writes against each other,
    // one of them able to overwrite the other's fresher data with stale data.
    //
    // Exceeding the time budget now requests cooperative cancellation instead
    // (`requestCancel()`, the same mechanism a user-initiated cancel already
    // uses) and this loop keeps genuinely awaiting the *same* handler promise
    // -- so the next `claim()` cannot start a second execution of this job
    // until the first one has actually finished, one way or another. A
    // handler with an `isCancelRequested()` checkpoint (aggregate.ts,
    // retention.ts) stops at its next one; a handler with none just keeps
    // running, exactly as it already did before this change -- the only
    // difference is that the worker no longer lies about it being done.
    let exceededBudget = false;
    const budgetTimer = setTimeout(() => {
      exceededBudget = true;
      appendLogLine(
        job.id,
        "stdout",
        `job exceeded its ${timeoutMs}ms time budget -- requesting cancellation`,
      );
      requestCancel(job.id);
    }, timeoutMs);

    try {
      await handler(job);
      clearTimeout(budgetTimer);
      appendLogLine(
        job.id,
        "stdout",
        exceededBudget ? "job completed (after exceeding its time budget)" : "job completed",
      );
      complete(job.id);
    } catch (err) {
      clearTimeout(budgetTimer);
      if (err instanceof JobCancelledError) {
        appendLogLine(job.id, "stdout", "job cancelled");
        cancelled(job.id);
        continue;
      }

      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      for (const line of detail.split("\n")) {
        appendLogLine(job.id, "stderr", line);
      }
      fail(job.id, err instanceof Error ? err : String(err));
    }
  }
}
