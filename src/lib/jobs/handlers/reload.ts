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
import { appendLogLine, progress } from "../queue";

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
 * `extractContent()`/`processContent()` on that fresh result -- not on the
 * previously stored `rawContent`, which is exactly the stale copy the user
 * is asking to be replaced. This always calls `fetchArticleContent()`,
 * regardless of whether the article already has a stored `rawContent`.
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
 *
 * Two things distinguish this call from `aggregate.ts`'s equivalent one:
 *
 * `bypassUsageLimit: true` -- a reload is a single, deliberate action an
 * operator just asked for, not the unattended bulk processing the daily/
 * monthly AI request caps exist to bound; see the doc comment on
 * `AIClient.generateResponse()`. It is deliberately *not* threaded into
 * `enrichArticles()`/`finalizeArticles()` on the aggregation path, which can
 * process many articles in one run and is exactly the case those caps are
 * for.
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

  // Fixed phase numbers, not computed fractions: a reload has no countable
  // unit of work to divide progress over (it is one article, refetched and
  // re-processed through a handful of sequential steps), unlike aggregate's
  // per-article progress. These five values just mark that sequence's
  // boundaries so a client polling mid-reload sees the job moving.
  progress(job.id, 5);

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
        // `contentHash: null` is mandatory, not tidiness: this row's content is
        // now an error notice, which the stored fingerprint no longer
        // describes. Left in place, the next aggregation run would compare the
        // feed's unchanged article against a hash that still matches, skip it,
        // and leave this notice standing *permanently* -- where it used to be
        // replaced by the real article on the very next cycle. See the
        // `contentHash` comment in `@/lib/db/schema/articles`.
        .set({ plainText, contentHash: null, updatedAt: new Date() })
        .where(eq(articles.id, article.id))
        .run();
    });

    appendLogLine(job.id, "stdout", "wrote error article after failed refetch");
    return;
  }

  // No progress call on the failed-refetch branch above: that branch returns
  // normally (it is a handled outcome, not a thrown error -- see the doc
  // comment above), so the job still finishes as a plain success. complete()
  // (called by the worker once this handler returns) always forces progress
  // to 100 regardless of the last value written here, so a reload that hits
  // that branch still reports 100% done rather than getting stuck at 5.
  progress(job.id, 30);

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
  progress(job.id, 55);

  const aiOutcome = await applyAiOptions(
    rawArticle,
    feed.options,
    settings,
    aggregator.onLog,
    true, // bypassUsageLimit -- see the doc comment above.
  );
  progress(job.id, 80);

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
        // Same reason as the failed-refetch branch above: reload has just
        // rewritten the name, the raw page and the whole block tree, so the
        // stored fingerprint describes content that no longer exists. Null it
        // rather than recompute it -- reload's inputs are not the aggregator's
        // (AI post-processing may have rewritten the name and body), so the
        // honest answer is "unknown", which makes the next aggregation run
        // re-derive it.
        contentHash: null,
        updatedAt: new Date(),
      })
      .where(eq(articles.id, article.id))
      .run();
  });

  appendLogLine(job.id, "stdout", "reloaded article content");
  progress(job.id, 100);

  if (aiOutcome.status === "failed") {
    // The fresh content above is already saved -- this only fails the job
    // report, so the feed's configured AI processing not having happened is
    // visible instead of hiding behind a green "completed".
    throw new Error(`AI processing did not complete (${aiOutcome.reason})`);
  }
}
