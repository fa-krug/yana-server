import { toast } from "sonner";

import type { RunOutcome } from "./wait-for-run";

export type RunOutcomeCopy = {
  completed: (n: number) => string;
  partial: (completed: number, failed: number) => string;
  fallback: string;
};

/**
 * The one toast a run-tracked action reports, once, at the end. `"timeout"`
 * is deliberately not an error: the run is still going server-side, just
 * slower than this tab was willing to wait -- nothing has failed.
 */
export function reportRunOutcome(outcome: RunOutcome, copy: RunOutcomeCopy): void {
  if (!outcome.ok) {
    if (outcome.reason === "timeout") return;
    toast.error(copy.fallback);
    return;
  }

  const { completedJobs, failedJobs } = outcome.status;
  if (failedJobs === 0) toast.success(copy.completed(completedJobs));
  else toast.warning(copy.partial(completedJobs, failedJobs));
}
