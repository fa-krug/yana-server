import { appendLogLine, claim, complete, fail, resetOrphaned } from "./queue";
import { getHandler } from "./handlers";
import { runWithLogCapture } from "./log-capture";

const WORKER_STARTED = Symbol.for("yana.worker.started");

interface GlobalWithWorker {
  [WORKER_STARTED]?: boolean;
}

let isLoopActive = false;

/**
 * `appendLogLine()` can throw (e.g. a busy database); a logging failure must
 * never fail the job it is trying to describe. This call always happens
 * outside `runWithLogCapture()`'s active context (before entering it, or
 * after it has already returned/thrown), so the plain `console.error` here
 * is the process's real stderr, not a captured job log line.
 */
function logSafe(jobId: number, stream: "stdout" | "stderr", line: string): void {
  try {
    appendLogLine(jobId, stream, line);
  } catch (err) {
    console.error(`[Worker] failed to append log line for job ${jobId}:`, err);
  }
}

export function isWorkerRunning(): boolean {
  const g = globalThis as GlobalWithWorker;
  return Boolean(g[WORKER_STARTED] && isLoopActive);
}

export function startWorker(options?: { pollIntervalMs?: number; timeoutMs?: number }): void {
  const g = globalThis as GlobalWithWorker;
  if (g[WORKER_STARTED]) {
    return;
  }

  g[WORKER_STARTED] = true;
  isLoopActive = true;

  // Startup: reset orphaned running rows whose startedAt predates this process
  resetOrphaned(new Date());

  runWorkerLoop(options).catch((err) => {
    console.error("[Worker] Fatal error in worker loop:", err);
    g[WORKER_STARTED] = false;
    isLoopActive = false;
  });
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

    logSafe(job.id, "stdout", `job started (attempt ${job.attempts}/${job.maxAttempts})`);
    try {
      await runWithLogCapture(job.id, () => withTimeout(handler(job), timeoutMs));
      logSafe(job.id, "stdout", "job completed");
      complete(job.id);
    } catch (err) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      for (const line of detail.split("\n")) {
        logSafe(job.id, "stderr", line);
      }
      fail(job.id, err instanceof Error ? err : String(err));
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Job execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}
