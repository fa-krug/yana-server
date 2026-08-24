import type { UserSettings } from "@/lib/db/schema";
import { resolveChromeLabels, type ChromeLabels } from "./chrome-labels";
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
  [key: string]: unknown;
}

/**
 * The feed owner's preferences, as the AI stage reads them: the real, camelCase
 * `UserSettings` row from `src/lib/db/schema/users.ts` (the same type
 * `getSettings()` returns), plus the snake_case fallback keys `AIClient`
 * (`../ai/run`) also accepts for parity with the retired Django settings
 * object.
 *
 * **No longer threaded through this pipeline.** It used to reach AI
 * post-processing via `aggregate()` -> `finalizeArticles()`, and that was its
 * only consumer here -- so when the AI stage moved to the job handlers (where
 * `parseBlocks()` runs, and therefore where a block tree exists to work on),
 * the parameter went with it. `aggregate.ts` and `reload.ts` read the row
 * themselves and hand it straight to `applyAiToBlocks()`. The type stays here
 * because it is the aggregator layer's own vocabulary for that row and both
 * handlers import it from here.
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

  /**
   * A hook for the aggregators that still have post-fetch work of their own
   * (YouTube and Reddit splice in embeds and header media). The base
   * implementation does nothing.
   *
   * **AI post-processing is deliberately not here any more.** It works on the
   * block tree now (`applyAiToBlocks()` in `@/lib/ai/run`), and blocks only
   * exist once `parseBlocks()` has run -- which happens in the job handlers,
   * downstream of this whole pipeline. Running AI here would mean serializing
   * blocks back to HTML for the handler to re-parse, and there is no
   * blocks -> HTML direction. The handlers call it themselves, after the
   * "nothing changed" check, which is also what keeps an unchanged article from
   * costing a provider request.
   */
  async finalizeArticles(articles: RawArticle[]): Promise<RawArticle[]> {
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
    articles = await this.finalizeArticles(articles);
    onProgress?.(80);
    return articles;
  }
}
