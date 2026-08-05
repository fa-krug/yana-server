import { attemptCall } from "@/lib/attempt";

import { getJobsStatus } from "./actions";

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Poll a set of jobs until every one of them has reached a terminal status
 * (or no longer exists -- e.g. already deleted by another tab). Unbounded,
 * same as `waitForRun()` (`./wait-for-run.ts`): a job with no cooperative-
 * cancellation checkpoint (`src/lib/jobs/handlers/logo.ts`,
 * `src/lib/jobs/handlers/reload.ts`) only stops once it finishes on its own,
 * and there is no good shorter timeout to guess at. Returns `false` only on
 * a real failure -- the poll request itself never returned; if the caller
 * navigates away, this promise chain is simply abandoned.
 */
export async function waitForJobsTerminal(ids: number[]): Promise<boolean> {
  let remaining = ids;

  while (remaining.length > 0) {
    const attempted = await attemptCall(() => getJobsStatus(remaining), {
      label: "Polling jobs' status rejected instead of resolving",
    });
    if (attempted.status !== "returned") return false;

    const stillRunning = new Set(
      attempted.result.filter((row) => !TERMINAL_STATUSES.has(row.status)).map((row) => row.id),
    );
    remaining = remaining.filter((id) => stillRunning.has(id));

    if (remaining.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return true;
}
