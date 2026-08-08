import { and, eq } from "drizzle-orm";

import { parseBlocks, plainTextOf } from "@/lib/aggregators/blocks/parser";
import { writeBlocks } from "@/lib/aggregators/blocks/storage";
import { resolveFeedCredentials } from "@/lib/aggregators/credential-resolution";
import { createAggregator } from "@/lib/aggregators/factory";
import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, feeds, userSettings, type Job } from "@/lib/db/schema";
import { JobCancelledError } from "../errors";
import { appendLogLine, isCancelRequested, progress } from "../queue";

export async function handleAggregateJob(job: Job): Promise<void> {
  const feedId = Number(job.payload?.feedId);
  if (!feedId) {
    appendLogLine(job.id, "stdout", "no feedId in payload, skipping");
    return;
  }

  const db = getDb();
  const feed = db.select().from(feeds).where(eq(feeds.id, feedId)).get();
  if (!feed || !feed.enabled) {
    appendLogLine(job.id, "stdout", `feed ${feedId} not found or disabled, skipping`);
    return;
  }

  // Without this, `aggregate()` -> `finalizeArticles()` -> `applyAiProcessing()`
  // calls `applyAiOptions()` with `userSettings` undefined, which is an early
  // return (see its own "No userSettings provided" guard) -- so a feed's
  // summarize/improve-writing/translate options never ran on a freshly
  // aggregated article at all, not just on reload. Read once and handed to
  // resolveFeedCredentials() too, which would otherwise re-run the identical
  // query for the same row.
  const settings = db.select().from(userSettings).where(eq(userSettings.userId, feed.userId)).get();

  appendLogLine(job.id, "stdout", `aggregating feed "${feed.name}" (${feed.aggregator})`);
  const aggregator = createAggregator(resolveFeedCredentials(feed, settings ?? null));
  const rawArticles = await aggregator.aggregate(undefined, undefined, settings);
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
    if (isCancelRequested(job.id)) {
      throw new JobCancelledError();
    }

    const raw = rawArticles[i];
    if (!raw.identifier) continue;

    // `content` is what extractContent()/processContent() actually distilled
    // from the page -- that's what the initial block tree is built from.
    // `raw_content` is the whole fetched page a full-website aggregator
    // (Tagesschau, Heise, ...) stashes there unconditionally, nav and footer
    // included, and is only empty for aggregators (plain RSS) that never
    // fetch a full page at all -- for those, `content` is the only thing
    // there is to persist as `articles.rawContent`.
    //
    // `articles.rawContent` MUST be `raw.raw_content` (the true page), never
    // `raw.content` (the distilled one): reload.ts re-runs the same
    // aggregator's extractContent()/processContent() against whatever is
    // stored there, on the assumption that it's a full raw page. Storing the
    // already-distilled `content` there instead breaks that silently -- the
    // site-specific selectors and markers extractContent() looks for (CSS
    // classes, `data-v-type="MediaPlayer"` divs, ...) no longer exist once
    // sanitizeClassNames() and friends have already run once, so reload finds
    // no body text at all and overwrites a perfectly good article with just
    // its header image.
    const htmlContent = raw.content || raw.raw_content || "";
    const blocks = parseBlocks(htmlContent, raw.identifier);
    const plainText = plainTextOf(blocks);
    const rawContentToStore = raw.raw_content || raw.content || "";

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
            rawContent: rawContentToStore,
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
            rawContent: rawContentToStore,
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
