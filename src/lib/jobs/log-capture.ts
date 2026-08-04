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
    const context = als.getStore();
    if (!context) {
      original[method](...args);
      return;
    }

    const text = format(...args);
    for (const line of text.split("\n")) {
      try {
        appendLogLine(context.jobId, stream, line);
      } catch (err) {
        original.error(`[log-capture] failed to persist a log line for job ${context.jobId}:`, err);
      }
    }
  };
}

(Object.keys(STREAM_FOR) as ConsoleMethod[]).forEach(patch);

/**
 * Runs `fn` with `console.log`/`info`/`warn`/`error` calls made during its own
 * async execution captured into `jobId`'s log, instead of the process's real
 * stdout/stderr. Scoped with `AsyncLocalStorage` rather than a time-boxed
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
