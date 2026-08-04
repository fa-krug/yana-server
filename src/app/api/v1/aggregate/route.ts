import { and, eq } from "drizzle-orm";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { getDb } from "@/lib/db/client";
import { feeds } from "@/lib/db/schema";
import { enqueueRun } from "@/lib/jobs/queue";

/**
 * The native client's "aggregate now" trigger. Enqueues one `aggregate` job
 * per caller-owned enabled feed, grouped under a single run so the client has
 * one id to poll (`GET /api/v1/runs/[id]`, Task 19) or watch over SSE
 * (`GET /api/v1/jobs/events`, Task 20) instead of N job ids.
 *
 * `enqueueRun()` (`src/lib/jobs/queue.ts`) treats an empty payload list as
 * legal -- a caller with zero enabled feeds still gets a run back, just one
 * created already `"completed"` with `totalJobs: 0`, because no child job
 * would ever exist to flip it out of `"running"` otherwise. So `runId` here
 * is always a real, non-null id; there is no "no run" response shape.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser(request);

    const enabledFeeds = getDb()
      .select({ id: feeds.id })
      .from(feeds)
      .where(and(eq(feeds.userId, user.id), eq(feeds.enabled, true)))
      .all();

    const runId = enqueueRun(
      user.id,
      "aggregate",
      enabledFeeds.map((feed) => ({ feedId: feed.id })),
    );

    return Response.json({ runId }, { status: 202 });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
