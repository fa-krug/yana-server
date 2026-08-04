import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";

import { appendLogLine } from "./queue";

type ConsoleMethod = "log" | "info" | "warn" | "error";

const STREAM_FOR: Record<ConsoleMethod, "stdout" | "stderr"> = {
  log: "stdout",
  info: "stdout",
  warn: "stderr",
  error: "stderr",
};

interface LogContext {
  jobId: number;
}

const als = new AsyncLocalStorage<LogContext>();

/**
 * Captured once, before any method below is patched -- the only safe thing
 * for the patch's own error handling to call. Calling the *patched*
 * `console.error` from inside the patch (e.g. on a failed `appendLogLine`
 * write) would re-enter this same function while the AsyncLocalStorage
 * context is still set, appending forever if the write keeps failing.
 */
const original: Record<ConsoleMethod, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function patch(method: ConsoleMethod): void {
  const stream = STREAM_FOR[method];
  console[method] = (...args: unknown[]) => {
    // Tee, not redirect: the real console call always happens, so an
    // operator tailing container logs still sees everything a job handler
    // logs, exactly as before this feature existed. Persistence into the
    // job's log (below) is additional, not a replacement.
    original[method](...args);

    const context = als.getStore();
    if (!context) return;

    const text = format(...args);
    for (const line of text.split("\n")) {
      try {
        // Runs with no active job context. `appendLogLine()`'s write and
        // `publishJobLog()`'s synchronous `EventEmitter.emit()` -- and every
        // subscriber that runs inside that `emit()`, today just the SSE
        // route's `send()`, but nothing prevents a future one -- all happen
        // inside this callback. Without `als.exit()`, a subscriber that
        // itself called a patched console method would still see
        // `als.getStore()` reporting this same `jobId` and recurse back into
        // `appendLogLine()`, forever. Exiting the store first means any such
        // call instead falls through to the plain tee-and-return path above,
        // exactly like a console call made with no job running at all.
        als.exit(() => appendLogLine(context.jobId, stream, line));
      } catch (err) {
        original.error(`[log-capture] failed to persist a log line for job ${context.jobId}:`, err);
      }
    }
  };
}

(Object.keys(STREAM_FOR) as ConsoleMethod[]).forEach(patch);

/**
 * Runs `fn` with `console.log`/`info`/`warn`/`error` calls made during its own
 * async execution *also* captured into `jobId`'s log -- every call still
 * reaches the real console first, unchanged, so an operator tailing container
 * logs loses nothing; the job log is an additional destination, not a
 * replacement one. Scoped with `AsyncLocalStorage` rather than a time-boxed
 * global patch: `src/lib/jobs/worker.ts` runs jobs one at a time, but the same
 * process also serves HTTP requests concurrently, and a patch that was simply
 * "on" for the duration of an `await` would misattribute an unrelated
 * request's logging to whichever job happened to be running at that moment.
 * `AsyncLocalStorage` instead follows this specific call's own async
 * continuation, wherever it interleaves with anything else.
 */
export function runWithLogCapture<T>(jobId: number, fn: () => Promise<T>): Promise<T> {
  return als.run({ jobId }, fn);
}
