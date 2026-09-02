import { and, eq, inArray } from "drizzle-orm";

import { aiOptionsEnabled, applyAiOptions } from "../ai/run";
import { getDb } from "@/lib/db/client";
import { articles, type UserSettings } from "@/lib/db/schema";
import { resolveChromeLabels, type ChromeLabels } from "./chrome-labels";
import { sourceFingerprint } from "./source-fingerprint";
import type { HeaderElementData } from "./header/context";
import { extractHeaderElement } from "./header/extractor";

export interface FeedLike {
  /**
   * The `feeds` row id, when this aggregator was built from a stored feed.
   *
   * Optional because a `FeedLike` is also constructed ad hoc (the feed form's
   * preview, every test fixture in `base.test.ts`), and everything an
   * aggregator does works without it. `applyAiProcessing()` is the one place
   * it changes behaviour: without an id there is no row to compare an
   * article against, so nothing is skipped and every article is processed --
   * the pre-`sourceHash` behaviour, which is correct, just not free.
   */
  id?: number;
  identifier: string;
  dailyLimit: number;
  concurrency?: number;
  maxArticleAgeDays?: number;
  aggregator?: string;
  options?: Record<string, unknown> | null;
  userId?: string | number | null;
  [key: string]: unknown;
}

export interface RawArticle {
  name: string;
  identifier: string;
  raw_content: string;
  content: string;
  date: Date;
  author?: string;
  icon?: string | null;
  header_data?: HeaderElementData | null;
  /**
   * Set by `applyAiProcessing()` when the feed asked for AI post-processing
   * (summarize / improve-writing / translate / custom prompt) and it did not
   * happen -- the `reason` from `applyAiOptions()`'s `failed` outcome.
   *
   * It exists because the alternative is invisible: this article's `content`
   * is the *untranslated* original, indistinguishable to `aggregate.ts` from
   * one that never asked for AI at all. Persisted that way and stamped with a
   * fingerprint, the row is marked "fully processed" forever -- the next run
   * computes the same fingerprint from the same unchanged feed item and skips
   * it. `aggregate.ts` reads this field to withhold the hash (and, for a row
   * that already exists, to leave the stored version alone rather than
   * downgrade it) and to fail the job instead of reporting a green run over
   * silently untranslated articles.
   */
  ai_failed_reason?: string;
  /**
   * The article's fingerprint **as the source gave it**, taken by
   * `applyAiProcessing()` before any AI call and stored by the handler as
   * `articles.sourceHash`.
   *
   * The handler cannot compute it itself: by the time it sees the article, AI
   * post-processing has already rewritten `name` and `content` in place, and
   * the fingerprint it would take there is over that rewritten body.
   */
  source_hash?: string;
  /**
   * Set when this article's stored `sourceHash` still matches, so no provider
   * was called for it -- and, because `content` is therefore the
   * *un*-processed text, the handler must not write the row either. See
   * `articles.sourceHash` in `@/lib/db/schema/articles`.
   */
  source_unchanged?: boolean;
  [key: string]: unknown;
}

/**
 * Per-user preferences threaded through to AI post-processing
 * (`applyAiOptions` in `../ai/run`). Both `src/lib/jobs/handlers/aggregate.ts`
 * and `reload.ts` read the feed owner's row directly (there is no session to
 * call `getSettings()` from in a job handler) and pass it in here: the real,
 * camelCase `UserSettings` row from `src/lib/db/schema/users.ts` (the same
 * type `getSettings()` returns), plus the snake_case fallback keys `AIClient`
 * (`../ai/run`) also reads for parity with the retired Django settings object.
 */
export type AggregatorUserSettings = Partial<UserSettings> & {
  ai_request_delay?: number;
  [key: string]: unknown;
};

export abstract class BaseAggregator {
  static identifierField = "identifier";
  static supportsIdentifierSearch = false;
  static brandSiteUrl: string | null = null;

  static getIdentifierFromRelated(relatedObj: unknown): string {
    return String(relatedObj);
  }

  static resolvesFeedUrl(): boolean {
    if (this.identifierField !== "identifier") {
      return false;
    }
    return !this.getIdentifierChoices().length;
  }

  static getIdentifierChoices(_query?: string, _user?: unknown): Array<[string, string]> {
    return [];
  }

  static getConfigurationFields(): Record<string, unknown> {
    return {};
  }

  static getDefaultIdentifier(): string {
    return "";
  }

  public identifier: string;
  public dailyLimit: number;
  public concurrency: number;
  public maxArticleAgeDays: number;
  public usesFirstContentMatch = false;
  private chromeLabelsPromise?: Promise<ChromeLabels>;

  /**
   * The job handler's own job-output channel (`appendLogLine`), set by
   * `reload.ts`/`aggregate.ts` right after `createAggregator()`. Extraction
   * failures deep in `header/extractor.ts` and `images/extractor.ts` were
   * previously only ever `console.warn`ed to the server log -- invisible to
   * whoever is watching the job that triggered them.
   */
  public onLog?: (message: string) => void;

  constructor(public feed: FeedLike) {
    this.identifier = feed.identifier || "";
    this.dailyLimit = feed.dailyLimit ?? 20;
    this.concurrency = feed.concurrency ?? 4;
    this.maxArticleAgeDays = feed.maxArticleAgeDays ?? 30;
  }

  /**
   * The feed owner's own-language versions of the chrome text aggregators
   * splice into article content ("Comments" headings, per-comment "source"
   * links, ...). Memoized per instance: a feed's aggregator processes every
   * one of its articles in a single run, and this way that run does one
   * database read total instead of one per article.
   */
  protected chromeLabels(): Promise<ChromeLabels> {
    if (!this.chromeLabelsPromise) {
      this.chromeLabelsPromise = resolveChromeLabels(this.feed.userId);
    }
    return this.chromeLabelsPromise;
  }

  logoImageUrl(): Promise<string | null> {
    return Promise.resolve(null);
  }

  validate(): void {
    if (!this.identifier) {
      throw new Error("Feed identifier is required");
    }
  }

  normalizeIdentifier(identifier: string): string {
    const normalized = identifier.trim();
    const choices = (this.constructor as typeof BaseAggregator).getIdentifierChoices();
    for (const [val, label] of choices) {
      if (normalized === label) {
        return String(val);
      }
    }
    return normalized;
  }

  getIdentifierLabel(identifier: string): string {
    const choices = (this.constructor as typeof BaseAggregator).getIdentifierChoices();
    for (const [val, label] of choices) {
      if (String(identifier) === String(val)) {
        return String(label);
      }
    }
    return identifier;
  }

  getAggregatorType(): string {
    return this.constructor.name.replace(/Aggregator$/i, "").toLowerCase();
  }

  getSourceUrl(): string {
    return this.identifier || "";
  }

  getCurrentRunLimit(clock: () => Date = () => new Date(), collectedToday = 0): number {
    const collected = collectedToday;
    if (collected >= this.dailyLimit) {
      return 0;
    }

    const now = clock();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const secondsSinceStart = Math.floor((now.getTime() - startOfDay.getTime()) / 1000);
    const totalSecondsInDay = 24 * 3600;

    const targetQuota = Math.ceil(this.dailyLimit * (secondsSinceStart / totalSecondsInDay));
    const remainingTotal = this.dailyLimit - collected;
    const gapToTarget = Math.max(0, targetQuota - collected);

    const baseAllowance = Math.max(1, Math.floor(this.dailyLimit / 48));
    const proportionalAllowance = Math.floor(remainingTotal * 0.2);

    let runLimit = Math.max(baseAllowance, gapToTarget, proportionalAllowance);

    if (now.getHours() < 10) {
      runLimit = Math.max(runLimit, Math.floor(remainingTotal * 0.4));
    }

    return Math.min(runLimit, remainingTotal);
  }

  abstract fetchSourceData(limit?: number): Promise<unknown>;

  abstract parseToRawArticles(sourceData: unknown): Promise<RawArticle[]>;

  async filterArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    if (this.maxArticleAgeDays === 0) {
      return articles;
    }

    const cutoffDate = new Date(Date.now() - this.maxArticleAgeDays * 24 * 60 * 60 * 1000);
    const filtered: RawArticle[] = [];

    for (const article of articles) {
      if (article.date && article.date < cutoffDate) {
        continue;
      }
      filtered.push(article);
    }
    return filtered;
  }

  async enrichArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    return articles;
  }

  async finalizeArticles(
    articles: RawArticle[],
    userSettings?: AggregatorUserSettings,
  ): Promise<RawArticle[]> {
    return this.applyAiProcessing(articles, userSettings);
  }

  /**
   * What this feed has already stored for each of these articles: the source
   * fingerprint it was last processed from, and whether that processing
   * finished.
   *
   * One query for the whole batch rather than one per article, and two small
   * columns rather than the row -- `plainText` is the largest column on the
   * table and reading it here would cost more than the skip saves. `articles_feed_identifier_idx` covers the lookup.
   */
  private storedFingerprints(identifiers: string[]): Map<string, string> {
    const feedId = this.feed.id;
    if (typeof feedId !== "number" || identifiers.length === 0) return new Map();

    const rows = getDb()
      .select({ identifier: articles.identifier, sourceHash: articles.sourceHash })
      .from(articles)
      .where(and(eq(articles.feedId, feedId), inArray(articles.identifier, identifiers)))
      .all();

    // A null fingerprint means "needs work" -- the row was never completed (a
    // crash mid-write, an AI pass that didn't finish, a failed reload's error
    // notice, a row predating the column). Dropping those here is what lets
    // the caller decide with a single `===`. See `articles.sourceHash`.
    return new Map(
      rows
        .filter((row): row is { identifier: string; sourceHash: string } => row.sourceHash !== null)
        .map((row) => [row.identifier, row.sourceHash]),
    );
  }

  protected async applyAiProcessing(
    articles: RawArticle[],
    userSettings?: AggregatorUserSettings,
  ): Promise<RawArticle[]> {
    // Not `if (!this.feed.options)`: a feed can carry options that ask for no
    // AI at all (a header image toggle, comment inclusion), and there is no
    // provider call to save on such a feed -- so fingerprinting it would buy
    // nothing while adding a second skip path in front of the handler's own
    // comparison of the same fingerprint. Returning here also stops the
    // `aiRequestDelay` sleep below from pacing a loop that makes no calls.
    if (!aiOptionsEnabled(this.feed.options)) return articles;

    const stored = this.storedFingerprints(articles.map((article) => article.identifier));
    let processed = 0;

    for (const article of articles) {
      // Taken before AI runs and carried to the handler, which stores it. The
      // handler's own fingerprint is taken *after*, so it cannot recompute
      // this one.
      const fingerprint = sourceFingerprint(article);
      article.source_hash = fingerprint;

      if (stored.get(article.identifier) === fingerprint) {
        // The source has not moved since this article was last processed, and
        // what is stored is complete. Calling a provider would spend a request
        // to reproduce a translation that is already in the database -- the
        // waste that made the daily budget unreachable. The handler skips the
        // row entirely on this flag; it must, because `article.content` here
        // is the *un*-processed text and writing it would overwrite the
        // processed version with it.
        article.source_unchanged = true;
        continue;
      }

      // The delay is between *provider calls*, so it is counted in processed
      // articles rather than loop iterations -- otherwise a run that skipped
      // everything would still sleep its way through the whole batch.
      if (processed > 0 && userSettings) {
        const delay = (userSettings.aiRequestDelay ?? userSettings.ai_request_delay ?? 2) * 1000;
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      processed++;

      const outcome = await applyAiOptions(article, this.feed.options, userSettings, this.onLog);
      // The outcome used to be discarded here, which is what made a failed AI
      // pass indistinguishable from a feed that never configured one. See
      // `RawArticle.ai_failed_reason` for what the caller does with it.
      if (outcome.status === "failed") {
        article.ai_failed_reason = outcome.reason;
      }
    }

    const skipped = articles.length - processed;
    if (skipped > 0) {
      this.onLog?.(`AI processing skipped for ${skipped} unchanged article(s)`);
    }

    return articles;
  }

  async extractHeaderElement(article: RawArticle): Promise<HeaderElementData | null> {
    const url = article.identifier;
    const alt = article.name || "Article image";
    if (!url) return null;
    const userId =
      typeof this.feed.userId === "number"
        ? this.feed.userId
        : typeof this.feed.userId === "string"
          ? parseInt(this.feed.userId, 10) || null
          : null;
    return extractHeaderElement(url, alt, userId, this.onLog);
  }

  fetchArticleContent(_url: string): Promise<string> {
    return Promise.resolve("");
  }

  extractContent(html: string, _article: RawArticle): string | Promise<string> {
    return html;
  }

  processContent(content: string, _article: RawArticle): string | Promise<string> {
    return content;
  }

  saveOptions(formCleanedData: Record<string, unknown>): void {
    const configFields = (this.constructor as typeof BaseAggregator).getConfigurationFields();
    const options = (this.feed.options as Record<string, unknown>) || {};
    for (const fieldName of Object.keys(configFields)) {
      if (!(fieldName in formCleanedData)) continue;
      const val = formCleanedData[fieldName];
      if (val === null || val === undefined) {
        delete options[fieldName];
      } else {
        options[fieldName] = val;
      }
    }
    this.feed.options = options;
  }

  /**
   * `onProgress`, if given, is called with a coarse 0-100 estimate after each
   * pipeline stage. `aggregate.ts`'s own per-article DB-write loop is fast
   * (local SQLite writes only) next to everything in here -- the source
   * fetch, per-article enrichment (comments, header images, full-page
   * fetches) and now AI summarize/improve/translate -- so without this a
   * job's progress sat at 0% for nearly its whole real duration and then
   * jumped straight to 100% during the cheap part, which reads as "stuck"
   * to anyone watching a running job. The percentages are deliberately
   * coarse boundaries, not a measured fraction of work done (there's no way
   * to know how long a given feed's enrichment will take up front) --
   * they exist so the number moves, not so it's precise.
   */
  async aggregate(
    clock?: () => Date,
    collectedToday?: number,
    userSettings?: AggregatorUserSettings,
    onProgress?: (percent: number) => void,
  ): Promise<RawArticle[]> {
    this.validate();
    const limit = this.getCurrentRunLimit(clock, collectedToday);
    if (limit === 0) {
      return [];
    }
    const sourceData = await this.fetchSourceData(limit);
    onProgress?.(10);
    let articles = await this.parseToRawArticles(sourceData);
    articles = await this.filterArticles(articles);
    onProgress?.(20);
    articles = await this.enrichArticles(articles);
    onProgress?.(60);
    articles = await this.finalizeArticles(articles, userSettings);
    onProgress?.(80);
    return articles;
  }
}
