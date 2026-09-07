"use server";

import { and, eq, inArray } from "drizzle-orm";

import { isAdminRole } from "@/lib/auth/roles";
import { currentUserId, requireUserFreshRole } from "@/lib/auth/session";
import { getDb, writeTransaction } from "@/lib/db/client";
import { jobs, runs } from "@/lib/db/schema";
import type { Run } from "@/lib/db/schema";
import { decrementRunTotal, publishRunUpdate, requestCancel } from "@/lib/jobs/queue";

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
 *
 * A deleted `pending` job that belonged to a run has its run's `totalJobs`
 * decremented in the same transaction (`decrementRunTotal()`,
 * `@/lib/jobs/queue`) -- without that, `runs.totalJobs` would keep counting a
 * job that can now never complete or fail, and `bumpRunCounters()`'s
 * `completedJobs + failedJobs >= totalJobs` check would never see the run as
 * done. `waitForRun()` (`@/lib/jobs/wait-for-run`) is deliberately unbounded,
 * so a run stranded that way would spin the dashboard's tracking UI forever.
 * Deleted `completed`/`failed`/`cancelled` rows need no such adjustment: they
 * already contributed to `completedJobs`/`failedJobs` before being deleted.
 *
 * HAZARD (noted, not fixed here -- see Task 7's brief): the `requestCancel()`
 * loop below runs *inside* this `writeTransaction`. That is safe today only
 * because `stopping` never contains a `pending` id -- every pending id was
 * already routed into `deletable` above -- so `requestCancel()`'s own-pending
 * branch (`cancelled()`, which opens a *second*, nested `writeTransaction`
 * and publishes SSE events) is never reached from in here.
 * `writeTransaction()` has no savepoints, so a nested one would be a real
 * hazard if that branch ever became reachable from this call site. Do not
 * widen `stopping` to include pending ids, and do not call `requestCancel()`
 * on an id whose status this function has not just checked itself, without
 * addressing that first.
 */
export async function deleteJobs(
  ids: number[],
): Promise<{ ok: true; deleted: number; stopping: number[] }> {
  if (ids.length === 0) return { ok: true, deleted: 0, stopping: [] };

  const user = await requireUserFreshRole();
  const admin = isAdminRole(user.role);
  const ownedIds = ownedJobIds(ids, user.id, admin);
  if (ownedIds.length === 0) return { ok: true, deleted: 0, stopping: [] };

  const { deleted, stopping, terminalRuns } = writeTransaction((db) => {
    const rows = db
      .select({ id: jobs.id, status: jobs.status, runId: jobs.runId })
      .from(jobs)
      .where(inArray(jobs.id, ownedIds))
      .all();

    const stopping: number[] = [];
    const deletable: number[] = [];
    const deletedPendingByRun = new Map<number, number>();
    for (const row of rows) {
      if (row.status === "running" || row.status === "cancelling") {
        stopping.push(row.id);
      } else {
        deletable.push(row.id);
        if (row.status === "pending" && row.runId !== null) {
          deletedPendingByRun.set(row.runId, (deletedPendingByRun.get(row.runId) ?? 0) + 1);
        }
      }
    }

    for (const id of stopping) {
      requestCancel(id);
    }

    const result =
      deletable.length > 0 ? db.delete(jobs).where(inArray(jobs.id, deletable)).run() : null;

    const terminalRuns: Run[] = [];
    for (const [runId, count] of deletedPendingByRun) {
      const run = decrementRunTotal(db, runId, count);
      if (run && run.status !== "running") terminalRuns.push(run);
    }

    return { deleted: result?.changes ?? 0, stopping, terminalRuns };
  });

  // Published only after the transaction above has committed, mirroring
  // complete()/fail()'s publishJobOutcome(): a rolled-back delete must never
  // get an event published for it.
  for (const run of terminalRuns) {
    publishRunUpdate(run.userId, run);
  }

  return { ok: true, deleted, stopping };
}
