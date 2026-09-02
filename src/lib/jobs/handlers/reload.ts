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
 * Reload re-fetches the article from source through the same
 * `fetchArticleContent()` a fresh aggregation run would call, then re-runs
 * `extractContent()`/`processContent()` on that fresh result. It always calls
 * `fetchArticleContent()` -- it never read a stored copy of the page, which
 * is why the `articles.raw_content` column that held one turned out to have
 * no readers at all and was dropped.
 * What "source" means depends on the aggregator: a full-page aggregator
 * (`FullWebsiteAggregator` and its site-specific subclasses -- Heise,
 * Tagesschau, ...) refetches the article's own page; a plain RSS/"Feed
 * Content" feed (`RssAggregator`) has no page of its own to fetch -- its
 * `fetchArticleContent()` instead re-fetches the *feed* and looks up this
 * article's entry again by link, since the entry's `summary` is, and always
 * was, the article's content (see `parseToRawArticles()` in `rss.ts`).
 * Either way, an empty result means source no longer has this article (page
 * gone, or the entry aged out of the feed) and lands in the error-notice
 * branch below.
 *
 * **A successful reload is authoritative**: the row keeps the fingerprints the
 * aggregator wrote, so the next aggregation run recognises the source as
 * unchanged and leaves the reloaded article alone. See the long comment on the
 * `sourceHash` line below -- it used to be nulled here, which made every
 * reload provisional until the next cycle overwrote it.
 *
 * When the source page can no longer be fetched (removed, gone offline,
 * ...), the article's content is replaced with a short error notice instead:
 * leaving the old content in place would look like the reload succeeded, and
 * retrying the job would not help with a deterministic failure
 * (fetchArticleContent already exhausts its own retry budget for transient
 * ones). **That** branch does null `sourceHash`, and must: an error notice is
 * not a completed article, and the next aggregation run replacing it with the
 * real one is the only thing that heals it.
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
 *
 * It is the same call `aggregate.ts` makes, with no per-user budget to opt
 * out of any more: the `bypassUsageLimit: true` this used to pass existed only
 * so a deliberate one-off reload would not spend the daily/monthly AI request
 * caps that unattended aggregation relied on, and both caps are gone.
 *
 * The fresh content is still written to the article even when AI processing
 * fails (translating/summarizing it is a bonus on top of a real refetch, not
 * a precondition for one) -- but the job is then thrown into failure rather
 * than reported as a plain success. A feed configured to translate every
 * reload that silently keeps serving the original language, while every job
 * still shows green, is a failure an operator has no way to notice.
 */
export async function handleReloadJob(job: Job): Promise<void> {
  const articleId = Number(job.payload?.articleId);
  if (!articleId) {
    appendLogLine(job.id, "stdout", "no articleId in payload, skipping");
    return;
  }

  const db = getDb();
  const article = db.select().from(articles).where(eq(articles.id, articleId)).get();
  if (!article) {
    appendLogLine(job.id, "stdout", "article not found, skipping");
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
  aggregator.onLog = (message) => appendLogLine(job.id, "stdout", message);

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
        // `sourceHash: null` is mandatory, not tidiness: this row is now an
        // error notice, which is not a complete rendering of anything. Left in
        // place, the next aggregation run would compare the feed's unchanged
        // article against a fingerprint that still matches, skip it, and leave
        // this notice standing *permanently*. Nulling it is the only thing
        // that heals the article on the next cycle. See
        // `articles.sourceHash`.
        .set({ plainText, sourceHash: null, updatedAt: new Date() })
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
  if (!rawArticle.content) {
    appendLogLine(job.id, "stdout", "extracted content is empty");
  }

  const aiOutcome = await applyAiOptions(rawArticle, feed.options, settings, aggregator.onLog);

  const processed = await aggregator.processContent(rawArticle.content || "", rawArticle);

  const blocks = parseBlocks(processed, article.identifier);
  const plainText = plainTextOf(blocks);

  await writeBlocks(article.id, blocks);

  writeTransaction((tx) => {
    tx.update(articles)
      .set({
        name: rawArticle.name || article.name,
        plainText,
        /**
         * **`sourceHash` is deliberately not written here.**
         *
         * This used to null it (as `contentHash`) on the reasoning that
         * reload's inputs are not the aggregator's, so the honest answer was
         * "unknown". The consequence was that a reload was *provisional*: the
         * next cycle re-derived the article from the feed and threw away what
         * an operator had just deliberately asked for. A manual reload is the
         * one place a human says "redo this article now" -- it has to win.
         *
         * Leaving the stored value is what makes it win, and it stays correct
         * in both directions, because the fingerprint describes **the source
         * this row came from** rather than the bytes now stored: while the
         * source is unchanged the next run computes the same value, matches,
         * and skips -- and when the source *does* change the values no longer
         * match, aggregation reprocesses, and the fresh upstream article
         * correctly replaces the reloaded one.
         *
         * The one case a reload cannot make stick is a row whose fingerprint
         * is already null -- never aggregated, or left null by a previous
         * failure. Reload cannot fill it in: the value has to be one the
         * *aggregator* would compute, over the feed's own article rather than
         * the page reload fetched, and it has no way to know it. Such a row is
         * reprocessed once and settles after that.
         */
        updatedAt: new Date(),
      })
      .where(eq(articles.id, article.id))
      .run();
  });

  appendLogLine(job.id, "stdout", "reloaded article content");

  if (aiOutcome.status === "failed") {
    // The fresh content above is already saved -- this only fails the job
    // report, so the feed's configured AI processing not having happened is
    // visible instead of hiding behind a green "completed".
    throw new Error(`AI processing did not complete (${aiOutcome.reason})`);
  }
}
