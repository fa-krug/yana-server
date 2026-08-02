import { eq } from "drizzle-orm";

import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, feeds, type Job } from "@/lib/db/schema";
import { handleAggregateJob } from "./aggregate";

export async function handleRestoreJob(job: Job): Promise<void> {
  const feedId = Number(job.payload?.feedId);
  if (!feedId) return;

  const db = getDb();
  const feed = db.select().from(feeds).where(eq(feeds.id, feedId)).get();
  if (!feed) return;

  // Destructive: clear feed's existing articles first
  writeTransaction((tx) => {
    tx.delete(articles).where(eq(articles.feedId, feedId)).run();
  });

  // Re-aggregate with full allowance
  await handleAggregateJob(job);
}
