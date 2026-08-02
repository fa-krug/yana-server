import { claim, complete, fail, resetOrphaned } from "./queue";
import { getHandler } from "./handlers";

const WORKER_STARTED = Symbol.for("yana.worker.started");

interface GlobalWithWorker {
  [WORKER_STARTED]?: boolean;
}

let isLoopActive = false;

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

    try {
      await withTimeout(handler(job), timeoutMs);
      complete(job.id);
    } catch (err) {
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
