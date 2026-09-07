import { and, count, eq, gte } from "drizzle-orm";

import { parseBlocks, plainTextOf } from "@/lib/aggregators/blocks/parser";
import { writeBlocksIn } from "@/lib/aggregators/blocks/storage";
import { rawArticleContentHash } from "@/lib/aggregators/content-hash";
import { hasBodyContent } from "@/lib/aggregators/website";
import { applyAiToBlocks, wantsAi } from "@/lib/ai/run";
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

  // The feed owner's row, read once and used twice: `resolveFeedCredentials()`
  // below needs it, and so does `applyAiToBlocks()` further down -- handed
  // `undefined`, that returns early on its own "no userSettings" guard, so a
  // feed's summarize/improve-writing/translate options would silently never
  // run. (It used to reach the AI stage by being threaded through
  // `aggregate()` into `finalizeArticles()`; the stage moved here, and that
  // parameter went away with it.)
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
  // One narrow indexed read per identifier -- one small column, never
  // `plainText`, the largest column on the table, which is the whole point:
  // comparing the content directly would cost the very I/O the skip saves. Asked exactly once
  // per article, by the loop below, so there is nothing here to memoize; the
  // one case where the same identifier comes round twice in a single run is a
  // feed that listed it twice, and reading the hash the first copy just wrote
  // is what makes the second one skip.
  const storedContentHash = (identifier: string): string | null =>
    db
      .select({ contentHash: articles.contentHash })
      .from(articles)
      .where(and(eq(articles.feedId, feedId), eq(articles.identifier, identifier)))
      .get()?.contentHash ?? null;
  const rawArticles = await aggregator.aggregate(undefined, collectedToday, (percent) =>
    progress(job.id, percent),
  );
  appendLogLine(job.id, "stdout", `fetched ${rawArticles.length} articles`);

  if (rawArticles.length === 0) {
    // No `feeds` touch here: that used to be a bare `set({ updatedAt: new
    // Date() })` whose only purpose was to bump the row so the scheduler
    // would see it as "just aggregated" -- redundant now that the scheduler
    // reads its own dedicated `lastAggregationStartedAt` clock, stamped at
    // claim() time (src/lib/jobs/queue.ts), not here.
    return;
  }

  const total = rawArticles.length;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  // Articles with neither text nor media -- a failed extraction, not a short
  // article. Counted for the same reason as `aiFailed` below: a run that
  // stored fewer articles than the feed listed should say why.
  let emptyBodySkipped = 0;
  // Articles the AI stage could not complete, so nothing was written for them
  // at all. Counted for the summary line: a run that stored fewer articles
  // than the feed listed should say why rather than look like a quiet feed.
  let aiFailed = 0;
  const aiFailureReasons = new Set<string>();
  // Articles that *were* stored, with a kept rewrite, but whose AI request
  // only partially completed (`ApplyAiOutcome`'s `degraded` arm -- today only
  // a rewrite that came back with no summary). Distinct from `aiFailed`: this
  // article is not missing, it is stored as the best available version.
  let aiDegraded = 0;
  const aiDegradedReasons = new Set<string>();

  // Whether this feed asks for AI at all, decided once -- by `wantsAi()`, the
  // same predicate `applyAiToBlocks()` itself uses, so there is no second copy
  // of the "is AI on" rule here to drift from the one in that function. It only
  // governs the inter-request spacing below; the stage answers `skipped` on its
  // own for a feed with no AI options.
  const aiOn = wantsAi(feed.options);
  const aiRequestDelayMs = (settings?.aiRequestDelay ?? 2) * 1000;
  let aiRequests = 0;

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
    // empty for aggregators (plain RSS) that never fetch a full page at all,
    // so it is only a fallback for the block source here.
    //
    // Neither is persisted as-is any more: the `articles.raw_content` column
    // this used to fill was written on every run and read by nothing (see the
    // note on the `articles` table). It is still passed to the fingerprint
    // below, which ignores it -- see `rawArticleContentHash()`.
    const htmlContent = raw.content || raw.raw_content || "";
    const rawDate = raw.date ?? null;

    // An article with neither text nor media is a failed extraction, not a
    // short one, and storing it is permanent -- an aggregation run only ever
    // sees the entries the feed currently lists, so once this one ages out of
    // that window nothing refetches it (see the "An article with no body is
    // skipped, never stored" note in CLAUDE.md). `website.ts`'s
    // `FullWebsiteAggregator.enrichArticles()` already refuses this earlier,
    // via the same `hasBodyContent()`, so such an article never reaches this
    // loop at all -- this hoisted check is what closes the same gap for every
    // other aggregator (Reddit, YouTube, Podcast, plain RSS), none of which
    // had a guard of their own. `hasBodyContent()`'s "text or media" rule
    // still applies here, so a comic feed's bare `<img>` or a podcast's
    // `<audio>` embed is not caught by this.
    if (!hasBodyContent(htmlContent)) {
      const message = `no body content for "${raw.name || raw.identifier}", skipping article`;
      console.warn(`[aggregate] ${message}`);
      appendLogLine(job.id, "stdout", message);
      emptyBodySkipped++;
      progress(job.id, 80 + Math.floor(((i + 1) / total) * 20));
      continue;
    }

    // Computed here, from the article exactly as the aggregator produced it.
    // That is a fingerprint of the *source*, which is what makes it stable:
    // AI post-processing now runs below this check rather than upstream of it,
    // so nothing in this value can depend on model output. (It could, once:
    // the AI stage (then `applyAiOptions()`) rewrote `raw.name`/`raw.content`
    // in place before this
    // ran, so for any feed with an AI option enabled the hash was a hash of a
    // non-deterministic answer and this skip could never fire.)
    const hash = rawArticleContentHash({
      name: raw.name,
      content: htmlContent,
      date: rawDate,
      author: raw.author,
      icon: raw.icon,
    });

    if (storedContentHash(raw.identifier) === hash) {
      // Nothing about this article changed since the last run. Skipping is
      // not just cheaper: `articles.updatedAt` carries `$onUpdate`, so an
      // unconditional rewrite would put every unchanged article back into
      // /api/v1's sync `updated` stream on every aggregation cycle. It is also
      // where the far larger saving now comes from: `applyAiToBlocks()` below
      // is never reached for an unchanged article, so a feed whose source keeps
      // returning the same top entries costs nothing per cycle instead of one
      // paid request per article per run.
      unchanged++;
      progress(job.id, 80 + Math.floor(((i + 1) / total) * 20));
      continue;
    }

    // Only now is the expensive parse worth doing -- and only now is an AI
    // request worth making. `applyAiToBlocks()` works on the block tree rather
    // than HTML: the tree is what gets stored, and rendering it as text means
    // every URL, image, embed and code block crosses as an opaque index the
    // model cannot alter (see `@/lib/ai/block-text`).
    const parsed = parseBlocks(htmlContent, raw.identifier);

    // Spacing is counted between *requests*, not loop iterations: a run whose
    // first entries are all already stored must not sleep before a request it
    // never made -- and neither must one whose AI stage declined to call the
    // provider at all, which is why the counter below is incremented from the
    // stage's own `requested` rather than from this gate.
    if (aiOn && aiRequests > 0 && aiRequestDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, aiRequestDelayMs));
    }

    const ai = await applyAiToBlocks(
      { title: raw.name || "Untitled", blocks: parsed },
      feed.options,
      settings ?? undefined,
      (message) => appendLogLine(job.id, "stdout", message),
    );

    if (ai.requested) aiRequests++;

    if (ai.outcome.status === "failed") {
      /**
       * **This per-article skip-and-retry is correct only for *transient*
       * failures** -- a 429, a 503, a provider hiccup on one article of many.
       * It used to also catch the *permanent* case: a feed with an AI option
       * on and no working AI provider, where `applyAiToBlocks()` returns
       * `reason: "noProvider"` for every single article, forever. Retrying
       * "next run" never helps a permanent misconfiguration, and every
       * skipped article still ages out of the feed's source window and is
       * lost for good -- while this job keeps reporting success. That case is
       * refused *before* a job is even enqueued now (`aiReadinessFor()` in
       * `@/lib/ai/readiness`, consulted by the scheduler and
       * `updateFeedsBulk()`), so a `"noProvider"` outcome reaching this arm
       * today means the owner's provider broke *mid-run* -- genuinely
       * transient from this job's point of view, since the pre-flight check
       * already passed. Do not "simplify" this arm away because the
       * permanent cause was moved upstream: it still has to exist for a 429,
       * a 503, and everything else that is transient by nature.
       *
       * **Write nothing at all, so the next run can store the article whole.**
       *
       * The feed asked for this article to be summarized, translated or
       * rewritten and it wasn't, so what is in hand is not the article this
       * feed is configured to have. Storing it anyway produced the wrong thing
       * in both directions: a *new* article appeared in its original language
       * and stayed that way until its source happened to change, and an
       * article already stored -- possibly the successfully processed version
       * of this very item -- was overwritten with the un-processed one over a
       * transient 503.
       *
       * Skipping costs only a cycle's delay. The fingerprint is not written
       * either (there is no row write at all for a new article, and an
       * existing row keeps whatever it had), so the next run treats the item
       * as outstanding and tries again -- which is what makes "next time it
       * adds the full article" true rather than aspirational.
       */
      aiFailed++;
      aiFailureReasons.add(ai.outcome.reason);
      appendLogLine(
        job.id,
        "stdout",
        `skipped "${raw.name || raw.identifier}": AI processing did not complete ` +
          `(${ai.outcome.reason}); it will be retried on the next run`,
      );
      progress(job.id, 80 + Math.floor(((i + 1) / total) * 20));
      continue;
    }

    if (ai.outcome.status === "degraded") {
      // Unlike `failed`, `ai.blocks`/`ai.title` here are a genuine, applied
      // rewrite -- only a secondary part of the request (today: the summary)
      // did not come back. Storing it is the whole point of the `degraded`
      // arm existing: falling into the skip-and-retry branch above would
      // throw away a rewrite that succeeded, over one field that didn't.
      // Logged, not silently accepted, so a run that stored an article this
      // way is visible in its own output rather than looking identical to a
      // fully clean one.
      aiDegraded++;
      aiDegradedReasons.add(ai.outcome.reason);
      appendLogLine(
        job.id,
        "stdout",
        `stored "${raw.name || raw.identifier}" with a degraded AI result ` +
          `(${ai.outcome.reason}); the rewrite was kept`,
      );
    }

    if (ai.droppedMedia) {
      appendLogLine(
        job.id,
        "stdout",
        `withholding the content fingerprint for "${raw.name || raw.identifier}" so the next ` +
          "aggregation run retries the media the AI stage dropped",
      );
    }

    const blocks = ai.blocks;
    const plainText = plainTextOf(blocks);
    const name = ai.title || raw.name || "Untitled";

    // The row write, the block tree write and the (conditional) contentHash
    // write all happen in this one writeTransaction now, rather than as three
    // separate top-level transactions with awaits between them. Either
    // everything for this article lands, or (on a thrown error, or a process
    // crash) none of it does -- there is no window in which the row exists
    // with zero blocks and a stale hash. The contentHash column's "written
    // last" reasoning (see schema/articles.ts) still holds and is now
    // automatic rather than depending on three separate commits to enforce
    // it: a fully failed AI stage never reaches here at all (that article is
    // skipped whole, above), so a fingerprint written here always describes a
    // row whose block tree is current for this content -- and the one case
    // that does reach here without a current fingerprint (`ai.droppedMedia`)
    // skips the hash write itself, below, rather than skipping the whole
    // transaction.
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

      let articleId: number;

      if (existing) {
        articleId = existing.id;
        updated++;
        tx.update(articles)
          .set({
            name,
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
            name,
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

      if (blocks.length > 0) {
        writeBlocksIn(tx, articleId, blocks);
      }

      // Withheld when the AI stage dropped a media/code block
      // (`ai.droppedMedia`, logged above): `hash` fingerprints the unchanged
      // *source*, so writing it here would make the next cycle's comparison
      // match, skip this article, and leave the dropped media gone for the
      // life of that source article -- exactly the permanence a stale hash
      // causes everywhere else in this file. Not writing it leaves whatever
      // was there before (a new article's is `null`; an existing one's is
      // already known to differ from `hash`, or this article would not have
      // reached this loop iteration at all), so either way the next run's
      // comparison misses again and this article is retried, not lost.
      if (!ai.droppedMedia) {
        tx.update(articles).set({ contentHash: hash }).where(eq(articles.id, articleId)).run();
      }
    });

    // The 80-100% band is this loop, and it is no longer the cheap part: AI
    // moved in here, so a feed with AI options on sits in this band for the
    // whole provider run while `aggregate()` above covered the fetch.
    progress(job.id, 80 + Math.floor(((i + 1) / total) * 20));
  }

  // No `feeds` touch here either -- see the same note above the
  // empty-`rawArticles` early return. The scheduler's clock is stamped once,
  // at claim(), and completion no longer needs to touch this row at all.

  appendLogLine(
    job.id,
    "stdout",
    `upserted articles: ${created} created, ${updated} updated, ${unchanged} unchanged` +
      (emptyBodySkipped > 0 ? `, ${emptyBodySkipped} skipped (empty body)` : "") +
      (aiFailed > 0
        ? `, ${aiFailed} skipped (AI: ${[...aiFailureReasons].sort().join(", ")})`
        : "") +
      (aiDegraded > 0
        ? `, ${aiDegraded} stored degraded (AI: ${[...aiDegradedReasons].sort().join(", ")})`
        : ""),
  );
}
