import { eq } from "drizzle-orm";

import type { RawArticle } from "@/lib/aggregators/base";
import { parseBlocks, plainTextOf } from "@/lib/aggregators/blocks/parser";
import { writeBlocks } from "@/lib/aggregators/blocks/storage";
import type { Block } from "@/lib/aggregators/blocks/types";
import { resolveFeedCredentials } from "@/lib/aggregators/credential-resolution";
import { createAggregator } from "@/lib/aggregators/factory";
import { applyAiOptions } from "@/lib/ai/run";
import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, feeds, userSettings, type Job } from "@/lib/db/schema";
import { appendLogLine } from "../queue";

function buildErrorBlocks(message: string): Block[] {
  return [
    {
      kind: "paragraph",
      runs: [{ text: message }],
    },
  ];
}

/**
 * Reload re-fetches the article's original page through the same
 * `fetchArticleContent()` a fresh aggregation run would call, then re-runs
 * `extractContent()`/`processContent()` on that fresh page -- not on the
 * previously stored `rawContent`, which is exactly the stale copy the user
 * is asking to be replaced. A stored `rawContent` is what gates reload to
 * feeds whose aggregator genuinely fetches a full page (website-based,
 * YouTube, Reddit -- see `fetchArticleContent()` on each); a plain RSS feed
 * never populates it, so it is never reached here.
 *
 * When the source page can no longer be fetched (removed, gone offline,
 * ...), the article's content is replaced with a short error notice instead:
 * leaving the old content in place would look like the reload succeeded, and
 * retrying the job would not help with a deterministic failure
 * (fetchArticleContent already exhausts its own retry budget for transient
 * ones).
 *
 * The feed is run through `resolveFeedCredentials()` before
 * `createAggregator()`, the same as `aggregate.ts` and `logo.ts` -- without it
 * `feed.options` carries none of the owner's stored YouTube/Reddit
 * credentials, and YouTube's `fetchArticleContent()` (which needs an API key
 * to call `videos.list`) fails every time, landing in the error-notice branch
 * above instead of ever reaching the source.
 *
 * AI post-processing (`applyAiOptions()`, the feed's summarize/improve/translate
 * options) runs between `extractContent()` and `processContent()`, mirroring
 * `enrichArticles()` -> `finalizeArticles()`'s order on a fresh aggregation run:
 * it needs the *distilled* content extractContent() produced, before
 * processContent() splices in embeds/header markup the AI call has no reason
 * to see. A translated title is written back too, since that is a field
 * `applyAiOptions()` can change.
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

  // Read once, up front, and handed to both resolveFeedCredentials() (which
  // would otherwise re-run this same query itself) and applyAiOptions() below.
  const settings = db.select().from(userSettings).where(eq(userSettings.userId, feed.userId)).get();

  const aggregator = createAggregator(resolveFeedCredentials(feed, settings ?? null));

  let freshHtml: string;
  try {
    freshHtml = await aggregator.fetchArticleContent(article.identifier);
    if (!freshHtml) {
      throw new Error("fetchArticleContent returned no content");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLogLine(job.id, "stdout", `failed to refetch original page: ${message}`);

    const blocks = buildErrorBlocks(
      `This article could not be reloaded: the original page could not be fetched (${message}).`,
    );
    const plainText = plainTextOf(blocks);

    await writeBlocks(article.id, blocks);
    writeTransaction((tx) => {
      tx.update(articles)
        .set({ plainText, updatedAt: new Date() })
        .where(eq(articles.id, article.id))
        .run();
    });

    appendLogLine(job.id, "stdout", "wrote error article after failed refetch");
    return;
  }

  const rawArticle: RawArticle = {
    name: article.name,
    identifier: article.identifier,
    raw_content: freshHtml,
    content: "",
    date: article.date,
    author: article.author || "",
  };

  const headerData = await aggregator.extractHeaderElement(rawArticle);
  if (headerData) rawArticle.header_data = headerData;

  rawArticle.content = await aggregator.extractContent(freshHtml, rawArticle);

  await applyAiOptions(rawArticle, feed.options, settings);

  const processed = await aggregator.processContent(rawArticle.content || "", rawArticle);

  const blocks = parseBlocks(processed, article.identifier);
  const plainText = plainTextOf(blocks);

  await writeBlocks(article.id, blocks);

  writeTransaction((tx) => {
    tx.update(articles)
      .set({
        name: rawArticle.name || article.name,
        rawContent: freshHtml,
        plainText,
        updatedAt: new Date(),
      })
      .where(eq(articles.id, article.id))
      .run();
  });

  appendLogLine(job.id, "stdout", "reloaded article content");
}
