"use server";

import { and, eq, inArray } from "drizzle-orm";

import { isAdminRole } from "@/lib/auth/roles";
import { currentUserId, requireUserFreshRole } from "@/lib/auth/session";
import { getDb, writeTransaction } from "@/lib/db/client";
import { jobs, runs } from "@/lib/db/schema";
import { requestCancel } from "@/lib/jobs/queue";

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

/** `ids` narrowed to the ones `userId` may act on -- every id, unfiltered,
 * for an admin. Re-checked here even though `/jobs` already filters a
 * non-admin's view to their own rows: a server action is reachable directly
 * with an arbitrary id list, and the list page's filter is a display
 * concern, not the authority boundary. */
function ownedJobIds(ids: number[], userId: string, admin: boolean): number[] {
  const ownership = admin ? undefined : eq(jobs.userId, userId);
  return getDb()
    .select({ id: jobs.id })
    .from(jobs)
    .where(ownership ? and(inArray(jobs.id, ids), ownership) : inArray(jobs.id, ids))
    .all()
    .map((row) => row.id);
}

/**
 * Requests cancellation for every owned id in `ids`. A `pending` job is
 * cancelled immediately; a `running` one only starts stopping (see
 * `requestCancel()` in `@/lib/jobs/queue`) -- `affected` counts either kind,
 * and the caller's toast reads accordingly ("cancellation requested", not
 * "cancelled", to stay honest about a still-running job).
 */
export async function cancelJobs(ids: number[]): Promise<{ ok: true; affected: number }> {
  if (ids.length === 0) return { ok: true, affected: 0 };

  const user = await requireUserFreshRole();
  const admin = isAdminRole(user.role);
  const ownedIds = ownedJobIds(ids, user.id, admin);

  let affected = 0;
  for (const id of ownedIds) {
    if (requestCancel(id) !== "unchanged") affected++;
  }

  return { ok: true, affected };
}

/**
 * Deletes every owned id in `ids` that is safe to delete right now
 * (`pending`, `completed`, `failed`, `cancelled` -- cascades to that job's
 * log lines). A `running` or `cancelling` job is not deleted: its row is
 * still being written to by the worker loop, and removing it out from under
 * that write would surface as a foreign-key-constraint throw inside the
 * handler's own `appendLogLine()`/`progress()` calls rather than a clean
 * stop. Such a job is asked to cancel instead (idempotent -- a no-op against
 * one already `cancelling`) and returned in `stopping`, for the caller to
 * poll (`@/lib/jobs/wait-for-jobs-terminal`) and delete again once it has
 * actually stopped.
 */
export async function deleteJobs(
  ids: number[],
): Promise<{ ok: true; deleted: number; stopping: number[] }> {
  if (ids.length === 0) return { ok: true, deleted: 0, stopping: [] };

  const user = await requireUserFreshRole();
  const admin = isAdminRole(user.role);
  const ownedIds = ownedJobIds(ids, user.id, admin);
  if (ownedIds.length === 0) return { ok: true, deleted: 0, stopping: [] };

  return writeTransaction((db) => {
    const rows = db
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(inArray(jobs.id, ownedIds))
      .all();

    const stopping: number[] = [];
    const deletable: number[] = [];
    for (const row of rows) {
      if (row.status === "running" || row.status === "cancelling") {
        stopping.push(row.id);
      } else {
        deletable.push(row.id);
      }
    }

    for (const id of stopping) {
      requestCancel(id);
    }

    const result =
      deletable.length > 0 ? db.delete(jobs).where(inArray(jobs.id, deletable)).run() : null;

    return { ok: true, deleted: result?.changes ?? 0, stopping };
  });
}

/** Ownership-scoped read used only to poll whether a `deleteJobs()` call's
 * `stopping` set has gone terminal (`@/lib/jobs/wait-for-jobs-terminal`). An
 * id the caller doesn't own, or that no longer exists, is simply absent from
 * the result. */
export async function getJobsStatus(ids: number[]): Promise<{ id: number; status: string }[]> {
  if (ids.length === 0) return [];

  const user = await requireUserFreshRole();
  const admin = isAdminRole(user.role);
  const ownedIds = ownedJobIds(ids, user.id, admin);
  if (ownedIds.length === 0) return [];

  return getDb()
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(inArray(jobs.id, ownedIds))
    .all();
}
