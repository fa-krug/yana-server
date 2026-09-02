import { and, count, eq, gte } from "drizzle-orm";

import { parseBlocks, plainTextOf } from "@/lib/aggregators/blocks/parser";
import { writeBlocks } from "@/lib/aggregators/blocks/storage";
import { sourceFingerprint } from "@/lib/aggregators/source-fingerprint";
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

  // getCurrentRunLimit()'s pacing formula (see base.ts) is meant to spread a
  // feed's dailyLimit across the day rather than spending it all on the
  // first run -- but every call site left `collectedToday` at its default of
  // 0, so every run computed its allowance as though nothing had been
  // collected yet today, regardless of how many runs already had been.
  // `createdAt` is set once at insert and never revisited (the same property
  // sync.ts's cursor relies on), so counting today's rows for this feed is
  // exactly "how many articles has this feed collected today."
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const collectedToday =
    db
      .select({ value: count() })
      .from(articles)
      .where(and(eq(articles.feedId, feedId), gte(articles.createdAt, startOfToday)))
      .get()?.value ?? 0;

  appendLogLine(job.id, "stdout", `aggregating feed "${feed.name}" (${feed.aggregator})`);
  const aggregator = createAggregator(resolveFeedCredentials(feed, settings ?? null));
  aggregator.onLog = (message) => appendLogLine(job.id, "stdout", message);
  const rawArticles = await aggregator.aggregate(undefined, collectedToday, settings, (percent) =>
    progress(job.id, percent),
  );
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
  let unchanged = 0;
  // Articles whose configured AI post-processing did not run (see
  // `RawArticle.ai_failed_reason` in `@/lib/aggregators/base`). Counted so the
  // job can fail at the end rather than reporting a green run over content the
  // feed asked to have translated, summarized or rewritten and didn't.
  let aiFailed = 0;
  const aiFailureReasons = new Set<string>();

  for (let i = 0; i < total; i++) {
    if (isCancelRequested(job.id)) {
      throw new JobCancelledError();
    }

    const raw = rawArticles[i];
    if (!raw.identifier) continue;

    // `content` is what extractContent()/processContent() actually distilled
    // from the page -- that's what the block tree is built from. `raw_content`
    // is the whole fetched page a full-website aggregator (Tagesschau, Heise,
    // ...) stashes there unconditionally, nav and footer included, and is
    // empty for aggregators (plain RSS) that never fetch a full page at all --
    // so it is only a fallback for the block source here.
    //
    // Neither is persisted as-is any more. The `articles.raw_content` column
    // this used to fill is gone: it was written on every run and read by
    // nothing (see the note on the `articles` table). The distilled `content`
    // lives on as the block tree below.
    const htmlContent = raw.content || raw.raw_content || "";
    const rawDate = raw.date ?? null;

    if (raw.source_unchanged) {
      // `applyAiProcessing()` recognised this article's stored source
      // fingerprint and called no provider for it, so `raw.content` is the
      // *un*-processed text and the stored row is the processed one. Nothing
      // to compare and nothing to write -- writing would replace a translated
      // article with its original. See `articles.sourceHash`.
      unchanged++;
      progress(job.id, 80 + Math.floor(((i + 1) / total) * 20));
      continue;
    }

    // `content` here is the *un*-processed original, because the AI pass this
    // feed configured failed for this article.
    const aiIncomplete = typeof raw.ai_failed_reason === "string";
    if (aiIncomplete) {
      aiFailed++;
      aiFailureReasons.add(raw.ai_failed_reason as string);
    }

    /**
     * This article's source fingerprint -- the one thing the skip is decided
     * on, here and in `applyAiProcessing()`.
     *
     * **`raw.source_hash` when the aggregator handed one over**, which it does
     * for a feed with AI options: by this point AI has rewritten `name` and
     * `content` in place, so recomputing here would fingerprint the *output*
     * and never match the source again. For a feed with no AI options nothing
     * rewrote the article, so the same function over it now is the source
     * fingerprint, and the aggregator skips the work of taking it.
     */
    const fingerprint = raw.source_hash ?? sourceFingerprint(raw);

    // Read outside the write transaction, and narrow: one small column, never
    // `plainText`, the largest column on the table. This is the whole point --
    // comparing the content directly would cost the very I/O the skip saves.
    const known = db
      .select({ sourceHash: articles.sourceHash })
      .from(articles)
      .where(and(eq(articles.feedId, feedId), eq(articles.identifier, raw.identifier)))
      .get();

    if (known && known.sourceHash === fingerprint) {
      // The source has not moved since this row was written. Skipping is not
      // just cheaper: `articles.updatedAt` carries `$onUpdate`, so an
      // unconditional rewrite would put every unchanged article back into
      // /api/v1's sync `updated` stream on every aggregation cycle. For an AI
      // feed the identical decision was already made (and the provider call
      // already saved) in `applyAiProcessing()`; this is the sole gate for
      // every other feed.
      unchanged++;
      progress(job.id, 80 + Math.floor(((i + 1) / total) * 20));
      continue;
    }

    // Only now is the expensive parse worth doing.
    const blocks = parseBlocks(htmlContent, raw.identifier);
    const plainText = plainTextOf(blocks);

    let articleId = 0;
    /**
     * Set when the transaction below declines to touch an existing row.
     *
     * An article the feed already has may well be the *AI-processed* version
     * of this same item -- the one whose translated body no longer matches the
     * feed's own text, which is exactly why the hash comparison above did not
     * skip it. Rewriting it with `raw`'s untranslated content because this
     * run's AI call happened to fail would replace a good article with a worse
     * one over a transient provider error. Leaving it alone costs nothing: the
     * stored hash still does not match what a successful run will compute, so
     * the next run rewrites it properly.
     */
    let leftAlone = false;

    writeTransaction((tx) => {
      // Re-read inside the transaction rather than trusting `known` above:
      // that read was outside the write lock, and two worker loops can be
      // running an aggregate job for the same feed. The select/insert pair
      // has to stay atomic, exactly as it was before.
      const existing = tx
        .select({ id: articles.id, date: articles.date })
        .from(articles)
        .where(and(eq(articles.feedId, feedId), eq(articles.identifier, raw.identifier)))
        .get();

      if (existing && aiIncomplete) {
        // See `leftAlone` above. Deliberately not counted as `updated`.
        leftAlone = true;
        return;
      }

      if (existing) {
        articleId = existing.id;
        updated++;
        tx.update(articles)
          .set({
            name: raw.name || "Untitled",
            plainText,
            // Keep the stored date when the feed supplied none. Re-stamping
            // `new Date()` here would rewrite the column on every run and,
            // worse, make it disagree with the hash -- which covers the
            // feed's own value precisely so an undated feed can still settle.
            date: rawDate ?? existing.date,
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
            plainText,
            date: rawDate ?? new Date(),
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

    if (articleId > 0 && !aiIncomplete) {
      // Written last, deliberately: a stored fingerprint means "the row *and*
      // its block tree are a complete rendering of that source". A crash
      // anywhere above leaves it null, so the next run redoes the work rather
      // than trusting a fingerprint for a half-written article.
      //
      // `!aiIncomplete` is the same rule, one step further out: the feed asked
      // for this article to be translated/summarized/rewritten and it wasn't,
      // so the row is not a complete rendering either. A fingerprint here
      // would be permanent -- the next run computes the identical value from
      // the identical unchanged feed item, matches, and skips the article
      // forever. See `articles.sourceHash`, which binds every writer.
      writeTransaction((tx) => {
        tx.update(articles)
          .set({ sourceHash: fingerprint })
          .where(eq(articles.id, articleId))
          .run();
      });
    }

    if (leftAlone) {
      appendLogLine(
        job.id,
        "stdout",
        `kept the stored version of "${raw.name || raw.identifier}": ` +
          `AI post-processing did not complete (${raw.ai_failed_reason})`,
      );
    }

    // aggregator.aggregate() above already reported up to 80% for the slow
    // network/AI work; this loop is the fast local DB-write remainder, so it
    // only claims the last 20%.
    progress(job.id, 80 + Math.floor(((i + 1) / total) * 20));
  }

  writeTransaction((tx) => {
    tx.update(feeds).set({ updatedAt: new Date() }).where(eq(feeds.id, feedId)).run();
  });

  appendLogLine(
    job.id,
    "stdout",
    `upserted articles: ${created} created, ${updated} updated, ${unchanged} unchanged`,
  );

  if (aiFailed > 0) {
    // Everything above is already committed -- the articles are saved, just
    // without the processing the feed asked for, and without a fingerprint so
    // the next run redoes it. This only fails the job *report*, for
    // `reload.ts`'s stated reason: a feed configured to translate every
    // article that quietly keeps serving the original language, while every
    // job still shows green, is a failure an operator has no way to notice.
    // It is also what puts the run in `notifyJobFailure()`'s path.
    throw new Error(
      `AI processing did not complete for ${aiFailed} of ${total} articles ` +
        `(${[...aiFailureReasons].sort().join(", ")})`,
    );
  }
}
