import { EventEmitter } from "node:events";

import type { JobLog } from "../db/schema";

/**
 * In-process pub/sub for a job's live log lines, keyed by job id -- not by
 * user id like `src/lib/api/events.ts`'s bus. Not every job kind resolves to
 * a single owning user -- `retention` runs once per boot across every user in
 * one execution, and `feed.logo`/`feed.update`/`feed.restore` are feed-scoped
 * maintenance the client API never triggers -- so there is no per-user
 * channel to key these events on in the first place. Best-effort, same as
 * `events.ts`: a dropped subscriber loses nothing but a live update, since
 * `listJobLogs()` remains the source of truth a viewer can always re-fetch.
 *
 * This bus enforces no ownership of its own -- it is a pure delivery
 * mechanism, agnostic to who is allowed to subscribe to a given job id.
 * Ownership is enforced by the callers that decide *who* gets to subscribe:
 * `/jobs`, `/jobs/[id]` and `src/app/api/jobs/[id]/log-stream/route.ts` all
 * filter a non-admin to their own rows (`jobs.userId`, via
 * `requireUserFreshRole()`) before ever reaching a `subscribe*` call here.
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
 *
 * Never throws, for the same reason `publishJobOutcome()` in `queue.ts` never
 * throws: `EventEmitter.emit()` rethrows a listener's throw synchronously, and
 * `complete()`/`fail()` call this *after* their own transaction has already
 * committed -- an escaping throw here would land in the worker loop's
 * `catch`, which would call `fail()` again on a job that just finished,
 * double-counting its parent run's counters and overwriting a "completed"
 * status with "failed" (or, worse, resetting an already-terminal "failed" job
 * back to "pending" for a retry it should never get). The listener that can
 * throw is real, not hypothetical: the log-stream route's terminal subscriber
 * (`src/app/api/jobs/[id]/log-stream/route.ts`) calls `send()`, which does
 * `controller.enqueue()`, and `enqueue()` throws once the controller is
 * already closed. A dropped listener loses nothing but a live "end" event --
 * `listJobLogs()` and the job row itself remain the source of truth a client
 * can always re-fetch, the same best-effort guarantee the line-log channel
 * relies on.
 */
export function publishJobTerminal(jobId: number, status: "completed" | "failed"): void {
  try {
    emitter.emit(terminalChannel(jobId), status);
  } catch (err) {
    console.error(`[log-bus] failed to publish terminal notification for job ${jobId}:`, err);
  }
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
