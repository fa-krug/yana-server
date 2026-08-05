import { toast } from "sonner";

import type { RunOutcome } from "./wait-for-run";

export type RunOutcomeCopy = {
  completed: (n: number) => string;
  partial: (completed: number, failed: number) => string;
  fallback: string;
};

/**
 * The one toast a run-tracked action reports, once, at the end. Every arm says
 * something: `waitForRun()` polls until the run really is terminal, so an
 * `ok: false` here is always a genuine failure (the request never returned, or
 * the run could not be read back) rather than "this tab stopped waiting".
 */
export function reportRunOutcome(outcome: RunOutcome, copy: RunOutcomeCopy): void {
  if (!outcome.ok) {
    toast.error(copy.fallback);
    return;
  }

  const { completedJobs, failedJobs } = outcome.status;
  if (failedJobs === 0) toast.success(copy.completed(completedJobs));
  else toast.warning(copy.partial(completedJobs, failedJobs));
}
