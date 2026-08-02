import { eq } from "drizzle-orm";

import { parseBlocks, plainTextOf } from "@/lib/aggregators/blocks/parser";
import { writeBlocks } from "@/lib/aggregators/blocks/storage";
import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, type Job } from "@/lib/db/schema";

export async function handleReloadJob(job: Job): Promise<void> {
  const articleId = Number(job.payload?.articleId);
  if (!articleId) return;

  const db = getDb();
  const article = db.select().from(articles).where(eq(articles.id, articleId)).get();
  if (!article || !article.rawContent) return;

  const blocks = parseBlocks(article.rawContent, article.identifier);
  const plainText = plainTextOf(blocks);

  await writeBlocks(article.id, blocks);

  writeTransaction((tx) => {
    tx.update(articles)
      .set({ plainText, updatedAt: new Date() })
      .where(eq(articles.id, article.id))
      .run();
  });
}
