import type { Job } from "../../db/schema";
import { handleAggregateJob } from "./aggregate";
import { handleLogoJob } from "./logo";
import { handleReloadJob } from "./reload";
import { handleRetentionJob } from "./retention";
import { handleUpdateJob } from "./update";

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
  registerHandler("aggregate", handleAggregateJob);
  registerHandler("feed.logo", handleLogoJob);
  registerHandler("feed.update", handleUpdateJob);
  registerHandler("article.reload", handleReloadJob);
  registerHandler("retention", handleRetentionJob);
}

// Register default handlers on module load
registerDefaultHandlers();
