import { and, eq } from "drizzle-orm";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { aiReadinessFor } from "@/lib/ai/readiness";
import { getDb } from "@/lib/db/client";
import { feeds, userSettings } from "@/lib/db/schema";
import { enqueueRun } from "@/lib/jobs/queue";

/**
 * A feed excluded from the run, and the machine-readable reason -- never
 * prose, per this API's existing no-echo convention (see `ApiError`'s own
 * doc comment). `"ai_no_provider"` is the only reason today; the type is an
 * open union of one so a second reason (were one ever needed) is additive
 * rather than a breaking change to this shape.
 */
type SkippedFeed = { feedId: number; reason: "ai_no_provider" };

/**
 * The native client's "aggregate now" trigger. Enqueues one `aggregate` job
 * per caller-owned enabled feed that is actually ready to run, grouped under
 * a single run so the client has one id to poll (`GET /api/v1/runs/[id]`,
 * Task 19) or watch over SSE (`GET /api/v1/jobs/events`, Task 20) instead of
 * N job ids.
 *
 * **Refuses a feed whose AI options are on but whose owner has no working AI
 * provider**, via `aiReadinessFor()` (`@/lib/ai/readiness`) -- the same rule
 * the scheduler and `updateFeedsBulk()` (`@/lib/feeds/actions`) already
 * consult, not a second copy of it. Enqueueing anyway would run every one of
 * that feed's articles through `applyAiToBlocks()`'s permanent `noProvider`
 * failure, which `handleAggregateJob` treats as transient and
 * skips-and-retries forever -- silently losing every article as it ages out
 * of the feed's source window, on a job that reports success. This route has
 * exactly the shape that bug needs: "aggregate every enabled feed" is
 * precisely "enqueue an AI-misconfigured feed" the moment one exists.
 *
 * **A blocked feed does not refuse the whole request.** The caller may own
 * several feeds, only some of which are misconfigured; refusing the entire
 * call because one feed can't run would be strictly worse than the bug this
 * guards against. Blocked feeds are excluded from the run and reported back
 * in `skippedFeeds`, so the native client can tell its user which feeds need
 * attention (and why) without the whole "aggregate now" action failing for
 * feeds that were perfectly fine.
 *
 * `enqueueRun()` (`src/lib/jobs/queue.ts`) treats an empty payload list as
 * legal -- a caller with zero ready feeds (whether because it owns none, or
 * because every enabled one was skipped) still gets a run back, just one
 * created already `"completed"` with `totalJobs: 0`, because no child job
 * would ever exist to flip it out of `"running"` otherwise. So `runId` here
 * is always a real, non-null id; there is no "no run" response shape.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser(request);

    const enabledFeeds = getDb()
      .select({ id: feeds.id, options: feeds.options })
      .from(feeds)
      .where(and(eq(feeds.userId, user.id), eq(feeds.enabled, true)))
      .all();

    const settings = getDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, user.id))
      .get();

    const skippedFeeds: SkippedFeed[] = [];
    const readyFeeds = enabledFeeds.filter((feed) => {
      if (aiReadinessFor(feed.options, settings) === "noProvider") {
        skippedFeeds.push({ feedId: feed.id, reason: "ai_no_provider" });
        return false;
      }
      return true;
    });

    const runId = enqueueRun(
      user.id,
      "aggregate",
      readyFeeds.map((feed) => ({ feedId: feed.id })),
    );

    return Response.json({ runId, skippedFeeds }, { status: 202 });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
