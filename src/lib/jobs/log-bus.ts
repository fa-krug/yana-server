import { EventEmitter } from "node:events";

import type { JobLog } from "../db/schema";

/**
 * In-process pub/sub for a job's live log lines, keyed by job id -- not by
 * user id like `src/lib/api/events.ts`'s bus. Not every job kind resolves to
 * an owning user (`retention`, `feed.logo`, ...), and `/jobs` is visible to
 * any signed-in user, not just a job's owner (`listJobs()`/`getJob()` apply
 * no ownership filter). Best-effort, same as `events.ts`: a dropped
 * subscriber loses nothing but a live update, since `listJobLogs()` remains
 * the source of truth a viewer can always re-fetch.
 */
const emitter = new EventEmitter();
// A job's log stream is one listener at a time in the common case, but
// nothing prevents two browser tabs watching the same job -- the default
// limit of 10 would log a spurious warning under ordinary use, not a leak.
emitter.setMaxListeners(0);

function channel(jobId: number): string {
  return `job:${jobId}`;
}

export function publishJobLog(jobId: number, line: JobLog): void {
  emitter.emit(channel(jobId), line);
}

/** Returns an unsubscribe function. */
export function subscribeJobLog(jobId: number, listener: (line: JobLog) => void): () => void {
  const name = channel(jobId);
  emitter.on(name, listener);
  return () => emitter.off(name, listener);
}

function terminalChannel(jobId: number): string {
  return `job-terminal:${jobId}`;
}

/**
 * A second, distinctly-namespaced pub/sub pair on the same emitter, for one
 * event: "this job just reached a terminal status." Kept separate from the
 * line-log channel above rather than folded into it (e.g. a line with a
 * sentinel `stream`) because a subscriber to one has no reason to also
 * receive the other, and `src/app/api/jobs/[id]/log-stream/route.ts` needs to
 * tell the two apart to know when to close the stream versus when to forward
 * a line -- a shared channel would make that a runtime check on every event
 * instead of a compile-time one on which function was called.
 */
export function publishJobTerminal(jobId: number, status: "completed" | "failed"): void {
  emitter.emit(terminalChannel(jobId), status);
}

/** Returns an unsubscribe function. */
export function subscribeJobTerminal(
  jobId: number,
  listener: (status: "completed" | "failed") => void,
): () => void {
  const name = terminalChannel(jobId);
  emitter.on(name, listener);
  return () => emitter.off(name, listener);
}
