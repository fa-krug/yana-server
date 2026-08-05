import type { RunStatus } from "./actions";

export type RunOutcome =
  { ok: true; status: RunStatus } | { ok: false; reason: "not-found" | "request-failed" };

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

/**
 * Wait for a run to reach a terminal state ("completed" or "failed") over
 * `/api/runs/[id]/status-stream` (`src/app/api/runs/[id]/status-stream/route.ts`)
 * instead of re-fetching `getRunStatus()` on a timer. That route sends one
 * `status` event immediately if the run is already terminal, otherwise one
 * per child-job completion for as long as the run keeps running -- so this
 * resolves the moment the server actually knows, rather than up to
 * `POLL_INTERVAL_MS` late.
 *
 * **Deliberately unbounded**, same as the polling loop this replaces: the
 * worker claims one job at a time, so a large selection legitimately takes a
 * long time, and giving up early produces silence for exactly the outcome
 * this helper exists to report. The browser's own `EventSource` reconnects on
 * a transient drop and replays from the connection's still-open subscription,
 * so a blip is not a reason to resolve -- only `onerror` firing with
 * `readyState === CLOSED` is: that is the terminal state `EventSource` itself
 * never retries from (a non-2xx response, e.g. this route's 404 for a run
 * that isn't this user's or no longer exists, or a response with the wrong
 * content type). If the user navigates away, the component unmounts and
 * closes the connection; this promise chain is simply abandoned.
 */
export function waitForRun(runId: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const source = new EventSource(`/api/runs/${runId}/status-stream`);
    let settled = false;

    const settle = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      source.close();
      resolve(outcome);
    };

    source.addEventListener("status", (event) => {
      const status = JSON.parse((event as MessageEvent).data) as RunStatus;
      if (TERMINAL_STATUSES.has(status.status)) settle({ ok: true, status });
    });

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        settle({ ok: false, reason: "request-failed" });
      }
    };
  });
}
