import { attemptIn } from "@/lib/attempt";

/**
 * The `jobs` binding of `attempt()` (see `src/lib/attempt.ts`) -- used by
 * `src/components/jobs/jobs-table.tsx` and `src/components/jobs/job-actions.tsx`
 * for the bulk/single cancel and delete actions.
 */
export const attempt = attemptIn("jobs", {
  sessionEnded: "sessionEnded",
  requestFailed: "requestFailed",
});
