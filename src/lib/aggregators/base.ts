import { resolveChromeLabels, type ChromeLabels } from "./chrome-labels";
import { promotionalLabelOf } from "./promotional";
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
  /**
   * The publisher's own categories for this entry, when the source has them
   * (`RssAggregator` and everything built on it -- see `FeedEntry.categories`
   * in ./rss-parser). Read by `filterArticles()` below and by nothing else; an
   * aggregator whose source has no such field (YouTube, Reddit) leaves it
   * undefined, which is not the same as an empty list only in that it never
   * had one.
   */
  categories?: string[];
  icon?: string | null;
  header_data?: HeaderElementData | null;
  [key: string]: unknown;
}

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

  /**
   * Computes how many entries this run may collect, pacing `dailyLimit`
   * across the day rather than spending it all on the first run. Private
   * because it is only ever correct when fed the *real* `collectedToday` --
   * `aggregate()` below computes it once and passes the result down as an
   * ordinary parameter (`fetchSourceData(limit)`, `parseToRawArticles(...,
   * limit)`), so nothing downstream can recompute it with the wrong inputs.
   * That used to be exactly the bug: `RssAggregator.parseToRawArticles()`
   * and `PodcastAggregator.parseToRawArticles()` both called this with no
   * arguments, silently falling back to `collectedToday = 0` and discarding
   * the pacing `aggregate()` had already worked out.
   */
  private getCurrentRunLimit(clock: () => Date = () => new Date(), collectedToday = 0): number {
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

  /**
   * `limit` is the paced allowance `aggregate()` already computed via the
   * now-private `getCurrentRunLimit()` -- an override must slice by this
   * value and must never recompute its own via `getCurrentRunLimit()`. See
   * that method's doc comment for the bug this signature exists to prevent.
   */
  abstract parseToRawArticles(sourceData: unknown, limit: number): Promise<RawArticle[]>;

  /**
   * Drops what this run must not store: articles older than
   * `maxArticleAgeDays`, and articles the publisher itself labelled as
   * advertising.
   *
   * **The advertising half is a real deletion, not a flag**, so it is the one
   * stage of the pipeline whose mistakes leave nothing behind to inspect -- a
   * dropped article is not in the list, not in the API, and not recoverable
   * until the source changes. Two things follow, and neither is optional:
   * `promotionalLabelOf()` reads *declared* labels only and errs towards
   * letting an article through (see the asymmetry note in ./promotional), and
   * every drop is logged to the triggering job's own output with the label that
   * caused it. The age filter above is deliberately silent by comparison,
   * because "older than the feed's own cutoff" is a date arithmetic an operator
   * can redo; "this looked like an ad" is a judgement they cannot.
   *
   * `skip_ads` turns the advertising half off per feed. It reads `!== false` --
   * absent means on -- which is both the pre-existing spelling in
   * `sites/caschys_blog.ts` (where this check began, as a title-only test for
   * "(Anzeige)") and the answer that keeps a feed subscribed to *for* its deals
   * from silently losing them once the option is understood.
   */
  async filterArticles(
    articles: RawArticle[],
    clock: () => Date = () => new Date(),
  ): Promise<RawArticle[]> {
    const options = (this.feed.options as Record<string, unknown> | null) || {};
    const skipPromotional = options.skip_ads !== false;
    const cutoffDate =
      this.maxArticleAgeDays === 0
        ? null
        : new Date(clock().getTime() - this.maxArticleAgeDays * 24 * 60 * 60 * 1000);

    const filtered: RawArticle[] = [];

    for (const article of articles) {
      if (cutoffDate && article.date && article.date < cutoffDate) {
        continue;
      }

      if (skipPromotional) {
        const label = promotionalLabelOf(article);
        if (label) {
          this.onLog?.(
            `skipping "${article.name}": the source labels it as advertising ("${label}")`,
          );
          continue;
        }
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

  private _sourceTitle: string | null = null;

  /**
   * The title the last `fetchArticleContent()` saw at the source, or `null`
   * when this aggregator has no way to know one.
   *
   * **This exists because `articles.name` is not necessarily source text.** A
   * feed with an AI option on stores the model's own title there (see
   * `applyAiToBlocks()` in `@/lib/ai/run`), so `reload.ts` -- which re-derives
   * everything else from source -- used to hand that value straight back to
   * the AI stage as the article's title. Two things came of it, and the second
   * is what a user reported: a repeated reload asked the model to improve an
   * already-improved title (drift), and a *translate* request arrived carrying
   * a title already in the target language beside a document that was not,
   * which is a contradictory instruction -- "translate this to German" over
   * `{"title": "<German>", "document": "<English>"}`. A model that reads that
   * as "already translated" answers with the document unchanged, and because
   * an unchanged document still parses, the article was stored with a
   * translated title and an untranslated body, silently, with a green job.
   *
   * So an aggregator that *does* see the source's own title while refetching
   * says so through `noteSourceTitle()`, and `reload.ts` prefers it over the
   * stored name -- the same value a fresh aggregation run would have used.
   *
   * **Only meaningful after a single `fetchArticleContent()` call**, which is
   * exactly reload's shape (one article, one aggregator instance) and is the
   * same restriction Reddit's `_lastReloaded*` stash already carries. The
   * `FullWebsiteAggregator` family deliberately notes nothing: its
   * `fetchArticleContent()` also runs *concurrently, per article* inside
   * `enrichArticles()`, where one instance-level value could only be the last
   * writer's -- and a scraped page's `<title>` is the site's headline plus its
   * own branding, not the feed's title for the article. Those feeds keep the
   * stored name on reload, as before.
   */
  get sourceTitle(): string | null {
    return this._sourceTitle;
  }

  /**
   * Record the source's own title for the article `fetchArticleContent()` just
   * fetched. Empty and whitespace-only titles are `null`: a caller must be able
   * to treat "no title" as one case, not two.
   */
  protected noteSourceTitle(title: string | null | undefined): void {
    this._sourceTitle = (title ?? "").trim() || null;
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
   * pipeline stage. Everything in here -- the source fetch and per-article
   * enrichment (comments, header images, full-page fetches) -- used to run
   * without reporting anything, so a job's progress sat at 0% for nearly its
   * whole real duration and then jumped straight to 100% during
   * `aggregate.ts`'s own loop, which reads as "stuck" to anyone watching a
   * running job. (That loop is no longer the cheap part it was when this was
   * written: the AI stage moved into it, so a feed with AI options on now
   * spends most of a run inside the 80-100% band instead of below it.) The percentages are deliberately
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
    let articles = await this.parseToRawArticles(sourceData, limit);
    articles = await this.filterArticles(articles, clock);
    onProgress?.(20);
    articles = await this.enrichArticles(articles);
    onProgress?.(60);
    articles = await this.finalizeArticles(articles);
    onProgress?.(80);
    return articles;
  }
}
