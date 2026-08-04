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
