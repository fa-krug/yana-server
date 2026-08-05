import { and, eq } from "drizzle-orm";

import { parseBlocks, plainTextOf } from "@/lib/aggregators/blocks/parser";
import { writeBlocks } from "@/lib/aggregators/blocks/storage";
import { createAggregator } from "@/lib/aggregators/factory";
import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, feeds, type Job } from "@/lib/db/schema";
import { appendLogLine, progress } from "../queue";

export async function handleAggregateJob(job: Job): Promise<void> {
  const feedId = Number(job.payload?.feedId);
  if (!feedId) {
    appendLogLine(job.id, "stdout", "no feedId in payload, skipping");
    return;
  }

  const db = getDb();
  const feed = db.select().from(feeds).where(eq(feeds.id, feedId)).get();
  if (!feed || !feed.enabled) {
    appendLogLine(job.id, "stdout", "feed not found or disabled, skipping");
    return;
  }

  const aggregator = createAggregator(feed);
  const rawArticles = await aggregator.aggregate();
  appendLogLine(job.id, "stdout", `fetched ${rawArticles.length} articles`);

  if (rawArticles.length === 0) {
    writeTransaction((tx) => {
      tx.update(feeds).set({ updatedAt: new Date() }).where(eq(feeds.id, feedId)).run();
    });
    return;
  }

  const total = rawArticles.length;
  let created = 0;
  let updated = 0;

  for (let i = 0; i < total; i++) {
    const raw = rawArticles[i];
    if (!raw.identifier) continue;

    const htmlContent = raw.raw_content || raw.content || "";
    const blocks = parseBlocks(htmlContent, raw.identifier);
    const plainText = plainTextOf(blocks);

    let articleId = 0;

    writeTransaction((tx) => {
      const existing = tx
        .select({ id: articles.id })
        .from(articles)
        .where(and(eq(articles.feedId, feedId), eq(articles.identifier, raw.identifier)))
        .get();

      if (existing) {
        articleId = existing.id;
        updated++;
        tx.update(articles)
          .set({
            name: raw.name || "Untitled",
            rawContent: htmlContent,
            plainText,
            date: raw.date || new Date(),
            author: raw.author || "",
            icon: raw.icon || null,
          })
          .where(eq(articles.id, articleId))
          .run();
      } else {
        const inserted = tx
          .insert(articles)
          .values({
            feedId,
            name: raw.name || "Untitled",
            identifier: raw.identifier,
            rawContent: htmlContent,
            plainText,
            date: raw.date || new Date(),
            author: raw.author || "",
            icon: raw.icon || null,
          })
          .returning({ id: articles.id })
          .get();
        articleId = inserted.id;
        created++;
      }
    });

    if (articleId > 0 && blocks.length > 0) {
      await writeBlocks(articleId, blocks);
    }

    progress(job.id, Math.floor(((i + 1) / total) * 100));
  }

  writeTransaction((tx) => {
    tx.update(feeds).set({ updatedAt: new Date() }).where(eq(feeds.id, feedId)).run();
  });

  appendLogLine(job.id, "stdout", `upserted articles: ${created} created, ${updated} updated`);
}
