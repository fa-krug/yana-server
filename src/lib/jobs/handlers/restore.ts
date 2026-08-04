import { eq } from "drizzle-orm";

import { getDb, writeTransaction } from "@/lib/db/client";
import { articleTombstones, articles, feeds, type Job } from "@/lib/db/schema";
import { handleAggregateJob } from "./aggregate";

export async function handleRestoreJob(job: Job): Promise<void> {
  const feedId = Number(job.payload?.feedId);
  if (!feedId) return;

  const db = getDb();
  const feed = db.select().from(feeds).where(eq(feeds.id, feedId)).get();
  if (!feed) return;

  // Destructive: clear feed's existing articles first. A client that synced
  // before this runs (or was offline for it) needs a tombstone per article to
  // learn it's gone -- see deleteWithTombstones() in retention.ts for the
  // sibling path.
  writeTransaction((tx) => {
    const doomed = tx
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.feedId, feedId))
      .all();

    if (doomed.length > 0) {
      tx.insert(articleTombstones)
        .values(doomed.map((a) => ({ articleId: a.id, userId: feed.userId })))
        .run();
    }

    tx.delete(articles).where(eq(articles.feedId, feedId)).run();
  });

  // Re-aggregate with full allowance
  await handleAggregateJob(job);
}
