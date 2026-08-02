import { and, eq, inArray, lte } from "drizzle-orm";

import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, feeds, userSettings, type Job } from "@/lib/db/schema";

export async function handleRetentionJob(_job: Job): Promise<void> {
  const db = getDb();
  const settingsList = db.select().from(userSettings).all();

  const defaultRetentionDays = 60;

  if (settingsList.length === 0) {
    const cutoff = new Date(Date.now() - defaultRetentionDays * 24 * 60 * 60_000);
    writeTransaction((tx) => {
      tx.delete(articles)
        .where(and(eq(articles.starred, false), lte(articles.createdAt, cutoff)))
        .run();
    });
    return;
  }

  for (const settings of settingsList) {
    const retentionDays = settings.articleRetentionDays ?? defaultRetentionDays;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60_000);

    const userFeeds = db
      .select({ id: feeds.id })
      .from(feeds)
      .where(eq(feeds.userId, settings.userId))
      .all();

    const feedIds = userFeeds.map((f) => f.id);
    if (feedIds.length === 0) continue;

    writeTransaction((tx) => {
      tx.delete(articles)
        .where(
          and(
            inArray(articles.feedId, feedIds),
            eq(articles.starred, false),
            lte(articles.createdAt, cutoff),
          ),
        )
        .run();
    });
  }
}
