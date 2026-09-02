import { eq } from "drizzle-orm";

import type { RawArticle } from "@/lib/aggregators/base";
import { parseBlocks, plainTextOf } from "@/lib/aggregators/blocks/parser";
import { writeBlocks } from "@/lib/aggregators/blocks/storage";
import type { Block } from "@/lib/aggregators/blocks/types";
import { resolveFeedCredentials } from "@/lib/aggregators/credential-resolution";
import { createAggregator } from "@/lib/aggregators/factory";
import { hasBodyContent } from "@/lib/aggregators/website";
import { applyAiToBlocks } from "@/lib/ai/run";
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
 * `extractContent()`/`processContent()` on that fresh result. It always calls
 * `fetchArticleContent()` -- it never read a stored copy of the page, which is
 * why the `articles.raw_content` column that held one turned out to have no
 * readers at all and was dropped.
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
 * A page that *does* fetch but yields no article body is the opposite case and
 * is handled the opposite way: nothing is written at all, and the job fails.
 * The page still exists, so the stored article remains the best copy anyone
 * has -- replacing it would put `processContent()`'s header image over an
 * empty body, which is precisely the shape `hasBodyContent()` exists to refuse
 * on the aggregation path (see `enrichArticles()` in
 * `@/lib/aggregators/website`). Reload cannot answer it the way aggregation
 * does, by skipping the article, because the row already exists; failing the
 * job is the equivalent, and it is what puts the reason in front of the
 * operator -- `jobs.error` is rendered verbatim in the job list, so a reload
 * that deliberately changed nothing says so instead of reporting a green
 * "completed".
 *
 * The feed is run through `resolveFeedCredentials()` before
 * `createAggregator()`, the same as `aggregate.ts` and `logo.ts` -- without it
 * `feed.options` carries none of the owner's stored YouTube/Reddit
 * credentials, and YouTube's `fetchArticleContent()` (which needs an API key
 * to call `videos.list`) fails every time, landing in the error-notice branch
 * above instead of ever reaching the source.
 *
 * AI post-processing (`applyAiToBlocks()`, the feed's summarize/improve/translate
 * options) runs **last**, below `parseBlocks()`, because the stage works on the
 * block tree rather than on HTML -- `parseBlocks()` is one-way and has no
 * inverse, so there is nowhere above it for a blocks-shaped stage to sit. That
 * also makes this path's order identical to `aggregate.ts`'s (extract, process,
 * parse, then AI), where the two used to differ: AI ran before
 * `processContent()` here and after it there, so the same article came out with
 * its summary nested one way on a reload and another on an aggregation run. A
 * translated title is written back too, since that is a field
 * `applyAiToBlocks()` can change.
 *
 * **The title the AI stage is given comes from source, not from
 * `articles.name`** -- `aggregator.sourceTitle`, when the aggregator saw one
 * while refetching (see `noteSourceTitle()` in
 * `@/lib/aggregators/base`). `articles.name` is not source text on a feed with
 * an AI option on: it is the model's own previous answer. Handing that back as
 * "the article's title" made a reload ask for a rewrite of a rewrite (a title
 * drifting a little further on every reload) and, worse, made a *translate*
 * request self-contradictory -- `{"title": "<already German>", "document":
 * "<English>"}` under "translate this to German", which a model can reasonably
 * read as "already translated" and answer with the document unchanged. An
 * unchanged document still parses, so the article was then stored with a
 * translated title and an untranslated body, silently, on a job that reported
 * success: exactly the "reload only translates the title" a user reported for a
 * Reddit post. An aggregator that cannot know the source's title (the
 * `FullWebsiteAggregator` family) reports `null` and the stored name is used, as
 * before.
 *
 * One thing distinguishes this call from `aggregate.ts`'s equivalent one:
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
  // would otherwise re-run this same query itself) and applyAiToBlocks() below.
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

  // Prefer what the source calls this article right now -- see the note above.
  // `null` from an aggregator that cannot know means the stored name, which is
  // what every reload used before this.
  const sourceTitle = aggregator.sourceTitle;

  const rawArticle: RawArticle = {
    name: sourceTitle ?? article.name,
    identifier: article.identifier,
    raw_content: freshHtml,
    content: "",
    date: article.date,
    author: article.author || "",
  };

  const headerData = await aggregator.extractHeaderElement(rawArticle);
  if (headerData) rawArticle.header_data = headerData;

  rawArticle.content = await aggregator.extractContent(freshHtml, rawArticle);

  // A fetched page with no article body in it is a failed reload, not a
  // shorter article -- and unlike the failed-refetch branch above it must
  // write *nothing*: the page still exists, so the stored article is the best
  // copy anyone has, and overwriting it with `processContent()`'s output would
  // leave the header image standing over an empty body. The stored row is
  // therefore left exactly as it was, `contentHash` included, and the job is
  // failed so the reason reaches the operator instead of a green
  // "completed" that changed nothing. Checked here rather than after
  // `processContent()`, so the AI stage below is never reached: there is no
  // point spending a provider request on a body that is not there.
  if (!hasBodyContent(rawArticle.content)) {
    const message =
      "The reloaded page contained no article body, so the stored article was left unchanged.";
    appendLogLine(job.id, "stdout", message);
    throw new Error(message);
  }

  // Content extraction is done *and* produced a usable body: the guard above
  // throws otherwise, so this phase is only ever reached by a reload that
  // still has something to write. A reload that fails that guard stays at 30,
  // which is the honest answer -- it got the page back and nothing further.
  progress(job.id, 55);

  // AI runs *after* processContent() now, not before it, and both call paths
  // are the same order for the first time: extract, process, parse, then AI on
  // the block tree. The old ordering existed so the model would not see the
  // embed and header markup processContent() splices in -- with blocks it
  // cannot, because every image, embed and code block crosses as an opaque
  // index (see `@/lib/ai/block-text`), so the reason for the asymmetry is gone.
  const processed = await aggregator.processContent(rawArticle.content || "", rawArticle);

  const ai = await applyAiToBlocks(
    { title: rawArticle.name || article.name, blocks: parseBlocks(processed, article.identifier) },
    feed.options,
    settings,
    aggregator.onLog,
  );
  // The AI stage has been applied (or has declined to run, or has failed --
  // `applyAiToBlocks()` reports that in `ai.outcome` rather than throwing, and
  // the failure is only turned into a thrown error at the very bottom, after
  // the write). Either way the pipeline is past its slowest step here, which
  // is what this phase marks. It sits *after* processContent() because that is
  // where the AI call now lives: the branch this came from ran AI between
  // extractContent() and processContent(), and main reordered the stage to run
  // last, on the block tree.
  progress(job.id, 80);

  const aiOutcome = ai.outcome;

  const plainText = plainTextOf(ai.blocks);

  await writeBlocks(article.id, ai.blocks);

  writeTransaction((tx) => {
    tx.update(articles)
      .set({
        // `ai.title` is the AI stage's answer when it ran and the source's own
        // title when it did not (it echoes its input), so a reload of a feed
        // with AI off now also picks up a title the source has changed --
        // the same thing an aggregation run does with every content change.
        name: ai.title || sourceTitle || article.name,
        plainText,
        // **`contentHash` is deliberately not written here.**
        //
        // This used to null it, on the reasoning that reload's inputs are not
        // the aggregator's so the honest answer was "unknown". The consequence
        // was that a reload was *provisional*: the next cycle re-derived the
        // article from the feed and threw away what an operator had just
        // deliberately asked for. A manual reload is the one place a human says
        // "redo this article now" -- it has to win. The empty-body branch above
        // already reasons this way ("`contentHash` included") for the case
        // where it writes nothing.
        //
        // Leaving the stored value is what makes it win, and it stays correct
        // in both directions, because the fingerprint is taken over the article
        // as *fetched from source* (see `rawArticleContentHash()`) rather than
        // over the bytes stored: while the source is unchanged the next run
        // computes the same value, matches, and skips -- and when the source
        // does change the values no longer match, aggregation reprocesses, and
        // the fresh upstream article correctly replaces the reloaded one.
        //
        // A row whose fingerprint is already null is the exception: reload
        // cannot fill it in, because the value has to be one the *aggregator*
        // would compute over the feed's own article rather than the page reload
        // fetched. Such a row is reprocessed once and settles.
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
