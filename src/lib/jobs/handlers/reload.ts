import { eq } from "drizzle-orm";

import type { RawArticle } from "@/lib/aggregators/base";
import { parseBlocks, plainTextOf } from "@/lib/aggregators/blocks/parser";
import { writeBlocks } from "@/lib/aggregators/blocks/storage";
import { createAggregator } from "@/lib/aggregators/factory";
import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, feeds, type Job } from "@/lib/db/schema";
import { appendLogLine } from "../queue";

/**
 * `article.rawContent` is the whole fetched page for a full-website
 * aggregator (Tagesschau, Heise, ...) -- nav, header and footer included --
 * never content ready to parse into blocks as-is. Re-running the same
 * aggregator's extractContent()/processContent() on it is what
 * handleAggregateJob does for a fresh fetch; reload must match that, or a
 * "Reload" brings back exactly the unfiltered page a real aggregation run
 * would have distilled.
 */
export async function handleReloadJob(job: Job): Promise<void> {
  const articleId = Number(job.payload?.articleId);
  if (!articleId) {
    appendLogLine(job.id, "stdout", "no articleId in payload, skipping");
    return;
  }

  const db = getDb();
  const article = db.select().from(articles).where(eq(articles.id, articleId)).get();
  if (!article || !article.rawContent) {
    appendLogLine(job.id, "stdout", "article not found or has no stored content, skipping");
    return;
  }

  const feed = db.select().from(feeds).where(eq(feeds.id, article.feedId)).get();
  if (!feed) {
    appendLogLine(job.id, "stdout", "article's feed not found, skipping");
    return;
  }

  const aggregator = createAggregator(feed);
  const rawArticle: RawArticle = {
    name: article.name,
    identifier: article.identifier,
    raw_content: article.rawContent,
    content: "",
    date: article.date,
    author: article.author || "",
  };

  const headerData = await aggregator.extractHeaderElement(rawArticle);
  if (headerData) rawArticle.header_data = headerData;

  const extracted = aggregator.extractContent(article.rawContent, rawArticle);
  const processed = await aggregator.processContent(extracted, rawArticle);

  const blocks = parseBlocks(processed, article.identifier);
  const plainText = plainTextOf(blocks);

  await writeBlocks(article.id, blocks);

  writeTransaction((tx) => {
    tx.update(articles)
      .set({ plainText, updatedAt: new Date() })
      .where(eq(articles.id, article.id))
      .run();
  });

  appendLogLine(job.id, "stdout", "reloaded article content");
}
