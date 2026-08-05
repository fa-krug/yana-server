import { applyAiOptions } from "../ai/run";
import type { UserSettings } from "@/lib/db/schema";
import type { HeaderElementData } from "./header/context";
import { extractHeaderElement } from "./header/extractor";

export interface FeedLike {
  identifier: string;
  dailyLimit: number;
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
 * Per-user preferences threaded through to AI post-processing
 * (`applyAiOptions` in `../ai/run`). No job handler wires a real value in yet
 * -- `src/lib/jobs/handlers/aggregate.ts` calls `aggregate()` with no
 * userSettings at all -- so this models the eventual caller: the real,
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
  public usesFirstContentMatch = false;

  constructor(public feed: FeedLike) {
    this.identifier = feed.identifier || "";
    this.dailyLimit = feed.dailyLimit ?? 20;
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
    const cutoffDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
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

  protected async applyAiProcessing(
    articles: RawArticle[],
    userSettings?: AggregatorUserSettings,
  ): Promise<RawArticle[]> {
    if (!this.feed.options) return articles;
    for (let i = 0; i < articles.length; i++) {
      if (i > 0 && userSettings) {
        const delay = (userSettings.aiRequestDelay ?? userSettings.ai_request_delay ?? 2) * 1000;
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      await applyAiOptions(articles[i], this.feed.options, userSettings);
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
    return extractHeaderElement(url, alt, userId);
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

  async aggregate(
    clock?: () => Date,
    collectedToday?: number,
    userSettings?: AggregatorUserSettings,
  ): Promise<RawArticle[]> {
    this.validate();
    const limit = this.getCurrentRunLimit(clock, collectedToday);
    if (limit === 0) {
      return [];
    }
    const sourceData = await this.fetchSourceData(limit);
    let articles = await this.parseToRawArticles(sourceData);
    articles = await this.filterArticles(articles);
    articles = await this.enrichArticles(articles);
    articles = await this.finalizeArticles(articles, userSettings);
    return articles;
  }
}
