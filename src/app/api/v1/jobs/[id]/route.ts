import { and, eq } from "drizzle-orm";
import { connection } from "next/server";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";

/**
 * The native client's poll target for one job's durable state. A standalone
 * `article.reload` job has `runId: null`, so `GET /api/v1/runs/[id]` can never
 * see it, and its single terminal SSE event is unrecoverable once missed --
 * this row is the only thing a client can ask again later, which is what makes
 * "resume monitoring after an app relaunch" possible at all.
 *
 * `progress` is the progress signal (0-100); `status` says only whether the
 * work has ended and whether it succeeded.
 *
 * Ownership is a direct `jobs.userId` check, which also excludes the unowned
 * rows (`retention` runs for every user and has no single owner), and a
 * mismatch answers the same 404 as a nonexistent id -- the same convention
 * `runs/[id]/route.ts` follows, so this route cannot enumerate other users'
 * job ids.
 *
 * `await connection()` must be the literal first statement, ahead of
 * `requireApiUser()` -- see the `connection()` bullet in the root CLAUDE.md.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  await connection();

  try {
    const user = await requireApiUser(request);

    const { id } = await ctx.params;
    const jobId = Number(id);
    if (!Number.isInteger(jobId)) throw new ApiError(404, "not_found");

    const job = getDb()
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.userId, user.id)))
      .get();
    if (!job) throw new ApiError(404, "not_found");

    return Response.json({
      jobId: job.id,
      runId: job.runId,
      kind: job.kind,
      progress: job.progress,
      status: job.status,
      error: job.error,
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
    });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
