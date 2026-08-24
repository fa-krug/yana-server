import { applyAiOptions } from "../ai/run";
import type { UserSettings } from "@/lib/db/schema";
import { resolveChromeLabels, type ChromeLabels } from "./chrome-labels";
import { rawArticleContentHash } from "./content-hash";
import type { HeaderElementData } from "./header/context";
import { extractHeaderElement } from "./header/extractor";

export interface FeedLike {
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
   * The fingerprint of this article *as fetched*, set by
   * `fingerprintArticles()` before any AI post-processing runs, and read back
   * by `handleAggregateJob()` instead of deriving a second one from the
   * already-rewritten article. See `rawArticleContentHash()` in
   * `./content-hash` for why it has to be computed at that point.
   */
  content_hash?: string;
  /**
   * `true` when `content_hash` equals the hash already stored for this
   * article, i.e. nothing about it changed since the last run. Set by
   * `fingerprintArticles()`; `applyAiProcessing()` sends no request for such
   * an article and `handleAggregateJob()` writes nothing for it.
   */
  unchanged?: boolean;
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

  /**
   * The `contentHash` already stored for one of this feed's articles, or
   * `null` when the article is new (or was left with a null hash by a run
   * that crashed part-way). Set by `aggregate.ts` right after
   * `createAggregator()`, alongside `onLog`.
   *
   * It is a hook rather than a query in here because `BaseAggregator` has no
   * database access of its own -- and it is a hook at all because the answer
   * is needed *inside* the pipeline, before `finalizeArticles()` spends a
   * provider request on an article the handler is about to discard anyway.
   * Left unset (every test that builds an aggregator directly, and
   * `reload.ts`, which works on a single article the user asked for by hand)
   * nothing is ever considered unchanged, so the behaviour is exactly what it
   * was before this existed.
   */
  public storedContentHash?: (identifier: string) => string | null;

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

  /**
   * Fingerprint every article as fetched, and mark the ones that have not
   * changed since the last run.
   *
   * This runs between `enrichArticles()` and `finalizeArticles()`, and the
   * position is the whole point: `finalizeArticles()` is where AI
   * post-processing lives, so this is the last moment at which "we already
   * have this exact article" is still knowable. The check used to sit in
   * `handleAggregateJob()`, *after* the pipeline had finished -- which meant
   * an unchanged article was still summarized, translated or rewritten by the
   * provider on every single cycle, and the skip only saved the local database
   * write. For a feed whose source keeps returning the same top entries (the
   * normal case: a 30-minute update interval against a site that publishes a
   * few times a day) that was one paid request per article per run, forever,
   * for a result thrown away moments later.
   */
  protected fingerprintArticles(articles: RawArticle[]): RawArticle[] {
    for (const article of articles) {
      article.content_hash = rawArticleContentHash(article);
      article.unchanged = Boolean(
        article.identifier && this.storedContentHash?.(article.identifier) === article.content_hash,
      );
    }
    return articles;
  }

  async finalizeArticles(
    articles: RawArticle[],
    userSettings?: AggregatorUserSettings,
  ): Promise<RawArticle[]> {
    return this.applyAiProcessing(articles, userSettings);
  }

  protected async applyAiProcessing(
    articles: RawArticle[],
    userSettings?: AggregatorUserSettings,
  ): Promise<RawArticle[]> {
    if (!this.feed.options) return articles;

    // `unchanged` articles are skipped outright -- see `fingerprintArticles()`.
    // The spacing delay is counted between *requests*, not between array
    // positions, or a run whose first few entries are all already stored would
    // sleep `aiRequestDelay` seconds before a request it never made.
    let requested = false;
    let skipped = 0;

    for (const article of articles) {
      if (article.unchanged) {
        skipped++;
        continue;
      }

      if (requested && userSettings) {
        const delay = (userSettings.aiRequestDelay ?? userSettings.ai_request_delay ?? 2) * 1000;
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      await applyAiOptions(article, this.feed.options, userSettings, this.onLog);
      requested = true;
    }

    if (skipped > 0) {
      this.onLog?.(`AI post-processing skipped for ${skipped} unchanged article(s)`);
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
    articles = this.fingerprintArticles(articles);
    onProgress?.(60);
    articles = await this.finalizeArticles(articles, userSettings);
    onProgress?.(80);
    return articles;
  }
}
