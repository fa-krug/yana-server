import { and, count, eq, gte } from "drizzle-orm";

import { parseBlocks, plainTextOf } from "@/lib/aggregators/blocks/parser";
import { writeBlocks } from "@/lib/aggregators/blocks/storage";
import { rawArticleContentHash } from "@/lib/aggregators/content-hash";
import { applyAiToBlocks } from "@/lib/ai/run";
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
  // `rawContent`/`plainText`, which is the whole point: comparing the large
  // columns directly would cost the very I/O the skip saves. Memoized because
  // it is now asked twice for the same article, once by the pipeline (below)
  // and once by this handler's own loop, and the two want the same answer: the
  // value as it stood before this run wrote anything.
  const storedHashes = new Map<string, string | null>();
  const storedContentHash = (identifier: string): string | null => {
    const cached = storedHashes.get(identifier);
    if (cached !== undefined) return cached;
    const value =
      db
        .select({ contentHash: articles.contentHash })
        .from(articles)
        .where(and(eq(articles.feedId, feedId), eq(articles.identifier, identifier)))
        .get()?.contentHash ?? null;
    storedHashes.set(identifier, value);
    return value;
  };
  const rawArticles = await aggregator.aggregate(undefined, collectedToday, (percent) =>
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

  // Whether this feed asks for AI at all, decided once. `applyAiToBlocks()`
  // answers `skipped` for a feed with no AI options, so this only governs the
  // inter-request spacing below -- there is no second copy of the "is AI on"
  // rule here to drift from the one in that function.
  const options = feed.options ?? {};
  const aiRequested = Boolean(
    options.ai_summarize ||
    options.ai_improve_writing ||
    options.ai_translate ||
    (options.ai_custom_prompt && options.ai_custom_prompt_text),
  );
  const aiRequestDelayMs = (settings?.aiRequestDelay ?? 2) * 1000;
  let aiRequests = 0;

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
    const rawContentToStore = raw.raw_content || raw.content || "";
    const rawDate = raw.date ?? null;

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
      raw_content: rawContentToStore,
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

    if (aiRequested) {
      // Spacing is counted between *requests*, not loop iterations: a run whose
      // first entries are all already stored must not sleep before a request it
      // never made.
      if (aiRequests > 0 && aiRequestDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, aiRequestDelayMs));
      }
      aiRequests++;
    }

    const ai = await applyAiToBlocks(
      { title: raw.name || "Untitled", blocks: parsed },
      feed.options,
      settings ?? undefined,
      (message) => appendLogLine(job.id, "stdout", message),
    );

    const blocks = ai.blocks;
    const plainText = plainTextOf(blocks);
    const name = ai.title || raw.name || "Untitled";

    let articleId = 0;

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

      if (existing) {
        articleId = existing.id;
        updated++;
        tx.update(articles)
          .set({
            name,
            rawContent: rawContentToStore,
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
            rawContent: rawContentToStore,
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

    if (articleId > 0) {
      // Written last, deliberately: a stored hash means "the row *and* its
      // block tree are current for this content". A crash anywhere above
      // leaves it stale or null, so the next run redoes the work rather than
      // trusting a fingerprint for a half-written article.
      writeTransaction((tx) => {
        tx.update(articles).set({ contentHash: hash }).where(eq(articles.id, articleId)).run();
      });
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
}
