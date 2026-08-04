"use server";

import { eq } from "drizzle-orm";

import { currentUserId } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";

export type RunStatus = {
  status: string;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
};

/**
 * The web dashboard's poll target for a run created by `updateFeedsBulk()`
 * or `reloadArticles()`. Mirrors `/api/v1/runs/[id]`'s ownership check, but
 * against the session instead of a Bearer token: a mismatch or a
 * nonexistent id both answer `null`, never a distinguishable error, so this
 * cannot be used to enumerate other users' run ids.
 */
export async function getRunStatus(runId: number): Promise<RunStatus | null> {
  const userId = await currentUserId();

  const run = getDb()
    .select({
      status: runs.status,
      totalJobs: runs.totalJobs,
      completedJobs: runs.completedJobs,
      failedJobs: runs.failedJobs,
      userId: runs.userId,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .get();

  if (!run || run.userId !== userId) return null;

  return {
    status: run.status,
    totalJobs: run.totalJobs,
    completedJobs: run.completedJobs,
    failedJobs: run.failedJobs,
  };
}
