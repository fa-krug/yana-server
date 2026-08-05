import { EventEmitter } from "node:events";

/**
 * In-process pub/sub for phase 13's SSE notification (`/api/v1/jobs/events`).
 * No Redis, consistent with the job queue it rides on top of being a single
 * process with no broker of its own. Not the source of truth — a dropped
 * connection loses nothing but low-latency notification, since the jobs/runs
 * tables are what a client falls back to polling.
 *
 * **Stashed on `globalThis` behind a `Symbol.for()`, the same pattern
 * `src/lib/jobs/worker.ts` uses for `WORKER_STARTED`, and for the same
 * reason: this module is not actually a singleton.** Next bundles the
 * instrumentation hook (which starts the worker that publishes here) and
 * each route handler (which subscribes here) into separate webpack chunks,
 * and a plain module-level `const emitter = new EventEmitter()` gets
 * re-evaluated once per chunk that imports it — confirmed by instrumenting
 * this file and observing a distinct instance log per request, in both
 * `next dev` and a real `node .next/standalone/server.js`. Each chunk then
 * has its own emitter, so a publish from the worker's copy never reaches a
 * subscriber reading from a route's copy: `waitForRun()`
 * (`src/lib/jobs/wait-for-run.ts`) only ever resolved by accident, when the
 * run happened to already be terminal at connect time, and otherwise hung
 * forever — the header's run-tracking spinner in
 * `src/components/jobs/active-runs-context.tsx` never clearing being the
 * visible symptom. `Symbol.for()` uses Node's global symbol registry, keyed
 * by string across the whole process regardless of which module instance
 * reads it, so every chunk's copy of this module resolves to the exact same
 * `EventEmitter` object.
 */
const EVENT_BUS_KEY = Symbol.for("yana.api.events.bus");

interface GlobalWithEventBus {
  [EVENT_BUS_KEY]?: EventEmitter;
}

const g = globalThis as GlobalWithEventBus;
const emitter = g[EVENT_BUS_KEY] ?? new EventEmitter();
g[EVENT_BUS_KEY] = emitter;
// One user's aggregation trigger can fan out into dozens of jobs; each
// completion is one emit, so the default limit of 10 listeners would log a
// spurious warning under ordinary use, not under a leak.
emitter.setMaxListeners(0);

export type ApiEvent =
  | {
      type: "job";
      payload: {
        jobId: number;
        runId: number | null;
        kind: string;
        status: string;
        progress: number;
      };
    }
  | {
      type: "run";
      payload: {
        runId: number;
        status: string;
        totalJobs: number;
        completedJobs: number;
        failedJobs: number;
      };
    };

function channel(userId: string): string {
  return `user:${userId}`;
}

export function publishUserEvent(userId: string, event: ApiEvent): void {
  emitter.emit(channel(userId), event);
}

/** Returns an unsubscribe function. */
export function subscribeUserEvents(
  userId: string,
  listener: (event: ApiEvent) => void,
): () => void {
  const name = channel(userId);
  emitter.on(name, listener);
  return () => emitter.off(name, listener);
}
