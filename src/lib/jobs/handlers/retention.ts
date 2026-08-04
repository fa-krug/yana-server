import { and, eq, inArray, lte } from "drizzle-orm";

import { getDb, writeTransaction } from "@/lib/db/client";
import { articleTombstones, articles, feeds, userSettings, type Job } from "@/lib/db/schema";

/**
 * Tombstones themselves can't usefully outlive the window a sync cursor can
 * still trust (src/lib/api/sync.ts's cursor-expiry check) -- see the client
 * API design doc, sync section.
 */
const RETENTION_TOMBSTONE_DAYS = 90;

/**
 * Deletes every unstarred article past `cutoff` among `feedIds`, writing a
 * tombstone for each one first, in the same transaction as the delete. Every
 * hard-delete path on `articles` must follow this shape: a client that missed
 * the delete (offline, or synced before it happened) has to be told the
 * article is gone, and the tombstone is the only record of that once the row
 * itself is removed.
 */
function deleteWithTombstones(
  tx: ReturnType<typeof getDb>,
  userId: string,
  feedIds: number[],
  cutoff: Date,
): void {
  const doomed = tx
    .select({ id: articles.id })
    .from(articles)
    .where(
      and(
        inArray(articles.feedId, feedIds),
        eq(articles.starred, false),
        lte(articles.createdAt, cutoff),
      ),
    )
    .all();

  if (doomed.length === 0) return;

  const doomedIds = doomed.map((a) => a.id);

  tx.insert(articleTombstones)
    .values(doomedIds.map((articleId) => ({ articleId, userId })))
    .run();

  tx.delete(articles).where(inArray(articles.id, doomedIds)).run();
}

export async function handleRetentionJob(_job: Job): Promise<void> {
  const db = getDb();
  const settingsList = db.select().from(userSettings).all();

  const defaultRetentionDays = 60;

  if (settingsList.length === 0) {
    // No per-user settings rows exist (a database with no users at all --
    // unreachable in practice, since the startup bootstrap always creates
    // one via ensureAdminExists()). There is no owner to attribute a
    // tombstone to, so nothing is deleted: writing an unattributed
    // tombstone isn't an option, and deleting without one would silently
    // reintroduce the pre-tombstone hazard this task closes.
  } else {
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

      writeTransaction((tx) => deleteWithTombstones(tx, settings.userId, feedIds, cutoff));
    }
  }

  // Prune tombstones a sync cursor could no longer trust anyway.
  const tombstoneCutoff = new Date(Date.now() - RETENTION_TOMBSTONE_DAYS * 24 * 60 * 60_000);
  writeTransaction((tx) => {
    tx.delete(articleTombstones).where(lte(articleTombstones.deletedAt, tombstoneCutoff)).run();
  });
}
