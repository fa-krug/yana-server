import { and, eq } from "drizzle-orm";
import { connection } from "next/server";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";

/**
 * The native client's poll target for a run created by
 * `POST /api/v1/aggregate` (Task 18) -- one thing to check instead of N job
 * ids, matching the counters `src/lib/jobs/queue.ts`'s `bumpRunCounters()`
 * maintains and the shape its `run` event publishes over SSE (Task 20).
 * Ownership is a direct column check (`runs.userId`, no join needed) and a
 * mismatch answers the same 404 as a nonexistent id, never a 403 -- the same
 * convention `content/route.ts` (Task 15) and `[id]/route.ts` (Task 16) use,
 * so this route cannot be used to enumerate other users' run ids.
 *
 * `await connection()` must be the literal first statement, ahead of
 * `requireApiUser()` -- see the `connection()` bullet in the root CLAUDE.md:
 * this route has no other Dynamic API call in its path (no cookie/header
 * read is guaranteed -- a Bearer-token caller never touches `next/headers`),
 * so nothing else would opt it out of prerendering.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  await connection();

  try {
    const user = await requireApiUser(request);

    const { id } = await ctx.params;
    const runId = Number(id);
    if (!Number.isInteger(runId)) throw new ApiError(404, "not_found");

    const run = getDb()
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.userId, user.id)))
      .get();
    if (!run) throw new ApiError(404, "not_found");

    return Response.json({
      runId: run.id,
      status: run.status,
      totalJobs: run.totalJobs,
      completedJobs: run.completedJobs,
      failedJobs: run.failedJobs,
    });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
