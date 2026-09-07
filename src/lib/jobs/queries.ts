import { isAdminRole } from "@/lib/auth/roles";
import { requireUserFreshRole } from "@/lib/auth/session";
import type { ListParams } from "@/lib/crud/params";
import type { Job } from "@/lib/db/schema";

import { getJob, listJobs, type JobWithOwner } from "./queue";

/**
 * The **gated** job reads `/jobs` and `/jobs/[id]` call. Ungated primitives
 * (`listJobs()`, `getJob()`) stay in `./queue`, which the worker imports.
 *
 * Both functions here start at `requireUserFreshRole()` and decide the owner
 * filter themselves. That used to happen in the page bodies -- each awaited
 * the gate as its first statement and passed `userId`/`admin` down -- and the
 * instant-render-no-fallback migration took those awaits out, so the rule has
 * to live where the rows are read or a non-admin's page would read every
 * user's jobs. See "THE SECURITY INVARIANT" in
 * `docs/superpowers/plans/2026-08-17-instant-render-no-fallback.md`: a page
 * rendering instantly is not permission to render data the caller may not see.
 *
 * `requireUserFreshRole()`, not `requireUser()` + `isAdminRole()`: whether a
 * caller sees every *other* user's job payloads is an authority decision, so
 * the role must not come from the five-minute session cookie cache. An
 * administrator demoted through `/users` loses cross-user visibility on their
 * next request, not five minutes later. **Nothing here may be `cache()`d
 * across requests** for the same reason -- per-request memoisation belongs at
 * the call site, which is what `/jobs` does.
 *
 * Not gated by `requireAdmin()`: a non-admin is still owed a response here,
 * just a filtered one -- the third category the doc comment on
 * `requireUserFreshRole()` in `@/lib/auth/session` describes.
 */

/** One page of jobs, the total it was cut from, and whether to show the owner column. */
export interface JobsPage {
  jobs: JobWithOwner[];
  total: number;
  /**
   * `true` for an admin only. Only an admin sees jobs across every user, so
   * only an admin needs the column that says whose -- and it travels with the
   * rows rather than being read again by the caller, so the header and the body
   * cannot disagree about how many columns there are.
   */
  showOwner: boolean;
}

/**
 * One page of the jobs the signed-in caller may see.
 *
 * A non-admin gets `jobs.userId = their own id` and nothing else: not another
 * user's rows, and not the ownerless ones (`retention` runs once per boot
 * across every user and owns none of them individually, so `jobs.userId` is
 * null for that kind -- see the `jobs.userId` bullet in CLAUDE.md). A
 * non-admin who owns nothing therefore sees an empty list, which is correct
 * and not "no filter". An admin gets every row, ownerless ones included.
 *
 * `total` is scoped by the same filter as `jobs`: an unfiltered count beside a
 * filtered page would tell a non-admin how many jobs everybody else has.
 */
export async function listJobsForCurrentUser(params: ListParams): Promise<JobsPage> {
  const user = await requireUserFreshRole();
  const admin = isAdminRole(user.role);

  const { jobs, total } = listJobs({
    kind: params.filters.kind,
    status: params.filters.status,
    // `undefined` is "every user", which is why this is the one place the
    // admin branch may leave it out.
    userId: admin ? undefined : user.id,
    limit: params.pageSize,
    offset: (params.page - 1) * params.pageSize,
  });

  return { jobs, total, showOwner: admin };
}

/**
 * One job, if the signed-in caller may see it.
 *
 * `null` covers all three refusals -- no such job, another user's job, and an
 * ownerless job read by a non-admin -- deliberately indistinguishable from one
 * another, the same reason the avatar route answers one empty 404 for every
 * refusal: a caller that can tell "not yours" from "does not exist" can
 * enumerate other users' job ids.
 */
export async function getJobForCurrentUser(id: number): Promise<Job | null> {
  const user = await requireUserFreshRole();
  const job = Number.isInteger(id) ? getJob(id) : null;
  if (!job) return null;
  if (!isAdminRole(user.role) && job.userId !== user.id) return null;
  return job;
}
