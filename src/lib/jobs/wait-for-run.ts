import { attemptCall } from "@/lib/attempt";

import { getRunStatus, type RunStatus } from "./actions";

export type RunOutcome =
  { ok: true; status: RunStatus } | { ok: false; reason: "not-found" | "request-failed" };

const POLL_INTERVAL_MS = 2000;

/**
 * Poll a run's status until it reaches a terminal state ("completed" or
 * "failed"). Every poll goes through `attemptCall` -- even a read -- per the
 * "never a bare await from a client component" rule (`@/lib/attempt`): on the
 * happy path (the call keeps returning normally) that costs nothing extra,
 * since `attemptCall` only probes the session on an actual rejection.
 *
 * **The loop is deliberately unbounded.** The worker claims one job at a time,
 * so a large selection legitimately takes a long time, and a poll that gives up
 * produces silence for exactly the outcome it is most likely to hit -- the whole
 * point of this helper is one honest toast at the end, however long the end
 * takes. It costs nothing to keep waiting: if the user navigates away the
 * component unmounts and this promise chain is simply abandoned. Only two things
 * end it early, both real failures: a request that never returned, and a run
 * that cannot be read back (deleted, or not this user's).
 */
export async function waitForRun(runId: number): Promise<RunOutcome> {
  for (;;) {
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
}
