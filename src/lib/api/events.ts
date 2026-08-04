import { EventEmitter } from "node:events";

/**
 * In-process pub/sub for phase 13's SSE notification (`/api/v1/jobs/events`).
 * No Redis, consistent with the job queue it rides on top of being a single
 * process with no broker of its own. Not the source of truth — a dropped
 * connection loses nothing but low-latency notification, since the jobs/runs
 * tables are what a client falls back to polling.
 */
const emitter = new EventEmitter();
// One user's aggregation trigger can fan out into dozens of jobs; each
// completion is one emit, so the default limit of 10 listeners would log a
// spurious warning under ordinary use, not under a leak.
emitter.setMaxListeners(0);

export type ApiEvent =
  | {
      type: "job";
      payload: { jobId: number; runId: number | null; kind: string; status: string; progress: number };
    }
  | {
      type: "run";
      payload: { runId: number; status: string; totalJobs: number; completedJobs: number; failedJobs: number };
    };

function channel(userId: string): string {
  return `user:${userId}`;
}

export function publishUserEvent(userId: string, event: ApiEvent): void {
  emitter.emit(channel(userId), event);
}

/** Returns an unsubscribe function. */
export function subscribeUserEvents(userId: string, listener: (event: ApiEvent) => void): () => void {
  const name = channel(userId);
  emitter.on(name, listener);
  return () => emitter.off(name, listener);
}
