import type { Job } from "@/lib/db/schema";
import { handleAggregateJob } from "./aggregate";

export async function handleUpdateJob(job: Job): Promise<void> {
  await handleAggregateJob(job);
}
