import { attemptCall } from "@/lib/attempt";

import { getRunStatus, type RunStatus } from "./actions";

export type RunOutcome =
  | { ok: true; status: RunStatus }
  | { ok: false; reason: "not-found" | "timeout" | "request-failed" };

const POLL_INTERVAL_MS = 2000;
// 300 * 2s = 10 minutes. A worker that claims one job at a time can take a
// while on a large bulk selection; this is generous enough for ordinary use
// and bounded enough that a genuinely stuck run does not poll forever.
const MAX_POLLS = 300;

/**
 * Poll a run's status until it reaches a terminal state ("completed" or
 * "failed"), or give up after ~10 minutes. Every poll goes through
 * `attemptCall` -- even a read -- per the "never a bare await from a client
 * component" rule (`@/lib/attempt`): on the happy path (the call keeps
 * returning normally) that costs nothing extra, since `attemptCall` only
 * probes the session on an actual rejection.
 */
export async function waitForRun(runId: number): Promise<RunOutcome> {
  for (let i = 0; i < MAX_POLLS; i++) {
    const attempted = await attemptCall(() => getRunStatus(runId), {
      label: "Polling a run's status rejected instead of resolving",
    });

    if (attempted.status !== "returned") return { ok: false, reason: "request-failed" };
    if (!attempted.result) return { ok: false, reason: "not-found" };
    if (attempted.result.status === "completed" || attempted.result.status === "failed") {
      return { ok: true, status: attempted.result };
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { ok: false, reason: "timeout" };
}
