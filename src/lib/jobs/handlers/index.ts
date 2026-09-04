import type { Job } from "../../db/schema";
import { AGGREGATE_HANDLER_JOB_KINDS } from "../queue";
import { handleAggregateJob } from "./aggregate";
import { handleLogoJob } from "./logo";
import { handleReloadJob } from "./reload";
import { handleRetentionJob } from "./retention";

export type JobHandler = (job: Job) => Promise<void>;

const registry = new Map<string, JobHandler>();

export function registerHandler(kind: string, handler: JobHandler): void {
  registry.set(kind, handler);
}

export function getHandler(kind: string): JobHandler | undefined {
  return registry.get(kind);
}

export function clearHandlers(): void {
  registry.clear();
}

export function registerDefaultHandlers(): void {
  // Both aggregate-running kinds are registered from the one list `queue.ts`
  // already maintains for them, rather than as two literals here.
  // `"feed.update"` used to map to `handleUpdateJob` -- a six-line
  // `handlers/update.ts` whose entire body was `await
  // handleAggregateJob(job)`. That indirection bought nothing and cost the
  // introspection: because the two kinds mapped to two *different* function
  // references, nothing could see that they were the same handler, so
  // `AGGREGATE_HANDLER_JOB_KINDS` had to be hand-maintained *and* restated
  // here as literals, with nothing keeping the two agreed. Reading that list
  // closes the drift -- a kind added there is registered here by
  // construction. The kind itself stays: `queue.ts` stamps
  // `feeds.lastAggregationStartedAt` for both, and `/jobs` shows
  // `feed.update` as its own user-visible kind.
  for (const kind of AGGREGATE_HANDLER_JOB_KINDS) {
    registerHandler(kind, handleAggregateJob);
  }
  registerHandler("feed.logo", handleLogoJob);
  registerHandler("article.reload", handleReloadJob);
  registerHandler("retention", handleRetentionJob);
}

// Register default handlers on module load
registerDefaultHandlers();
