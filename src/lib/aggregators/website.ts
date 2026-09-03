import * as cheerio from "cheerio";

import { RawArticle } from "./base";
import type { ChromeLabels } from "./chrome-labels";
import { mapWithConcurrency } from "./concurrency";
import { ArticleSkipError } from "./errors";
import { cleanHtml, removeImageByUrl, sanitizeClassNames } from "./extract/clean";
import {
  DEFAULT_CONTENT_SELECTORS,
  DEFAULT_IGNORE_SELECTORS,
  extractMainContentIfPresent,
} from "./extract/content";
import { createYoutubeEmbedHtml, formatArticleContent } from "./extract/format";
import { localizeThumbnail } from "./embeds/youtube";
import { isYoutubeUrl, youtubeIdFrom } from "./embeds/youtube-url";
import type { HeaderElementData } from "./header/context";
import { getHeaderImageRef } from "./header/context";
import { fetchHtml } from "./http/fetcher";
import { RssAggregator } from "./rss";

export const IFRAME_SANITIZE_SELECTOR = ".iframe-sanitize";
export const GENERIC_CONTENT_MIN_TEXT_LENGTH = 80;

/**
 * Elements that make a body worth storing even with no text at all: a comic
 * feed's entire article is one `<img>`, and a video post's is one embed.
 */
const BODY_MEDIA_SELECTOR = "img, picture, figure, iframe, video, audio, object, embed, svg";

/**
 * Did content selection actually find an article body?
 *
 * A miss is not the only way to end up with nothing: a site aggregator's
 * `selectorsToRemove` can legitimately match every child of a container that
 * *was* found -- Heise strips a blanket `section`, and Heise puts body
 * paragraphs inside `<section>` on some templates -- so `extractContent()`
 * returns markup with no article in it and reports no error. Left unchecked
 * that reached `formatArticleContent()`, which prepends the header image
 * unconditionally, and the row stored was a header image above an empty
 * `<section>`. Text *or* media counts, because an image-only body is exactly
 * what a comic feed extracts.
 */
export function hasBodyContent(html: string): boolean {
  if (!html.trim()) {
    return false;
  }
  const $ = cheerio.load(html);
  if ($.text().trim().length > 0) {
    return true;
  }
  return $(BODY_MEDIA_SELECTOR).length > 0;
}

/**
 * Replace every raw YouTube iframe (and privacy-wrapper placeholder) with a
 * click-through facade -- localizing each video's thumbnail first, so the
 * facade shows a real preview image rather than a bare play button on black.
 */
export async function proxyYoutubeEmbeds(
  $: cheerio.CheerioAPI,
  labels: ChromeLabels,
): Promise<void> {
  const containers = $(".embed-privacy-container").toArray();
  for (const container of containers) {
    const $container = $(container);
    const link = $container.find(".embed-privacy-url a[href]").first();
    const href = link.attr("href");
    const videoId = href ? youtubeIdFrom(href) : null;
    if (videoId) {
      $container.replaceWith(`<iframe src="https://www.youtube.com/embed/${videoId}"></iframe>`);
    } else {
      $container.remove();
    }
  }

  const iframes = $("iframe").toArray();
  for (const iframe of iframes) {
    const $iframe = $(iframe);
    const src = $iframe.attr("src") || "";
    if (isYoutubeUrl(src)) {
      const videoId = youtubeIdFrom(src);
      if (videoId) {
        const thumbnailRef = await localizeThumbnail(videoId);
        $iframe.replaceWith(createYoutubeEmbedHtml(videoId, labels, "", thumbnailRef));
      }
    }
  }
}

/**
 * The subset of an aggregator's instance methods `enrichOne()` needs to run
 * the shared extract/process pipeline. A structural (not nominal) type, on
 * purpose: `reload.ts`'s tests replace `createAggregator()` with a plain
 * object literal carrying just these four methods, never a real
 * `BaseAggregator` subclass, and `reload.ts`'s production code passes a real
 * `BaseAggregator` -- which satisfies this interface with room to spare. Both
 * must keep working with no cast at either call site.
 */
export interface EnrichableAggregator {
  extractHeaderElement(article: RawArticle): Promise<HeaderElementData | null>;
  fetchArticleContent(url: string): Promise<string>;
  extractContent(html: string, article: RawArticle): string | Promise<string>;
  processContent(html: string, article: RawArticle): string | Promise<string>;
}

/**
 * Every way `aggregate.ts` (via `FullWebsiteAggregator.enrichArticles()`) and
 * `reload.ts` (via `handleReloadJob()`) diverge on what to do when
 * enrichment doesn't go cleanly -- stated once, here, as an explicit
 * parameter, instead of being implied by four different try/catch shapes
 * spread across two files. `enrichOne()` calls exactly one of these two hooks
 * when something goes wrong; which policy object a caller supplies is the
 * whole difference between "skip this article", "keep its original RSS
 * body", "write an error notice instead", or "throw and fail the job" --
 * see `FullWebsiteAggregator.enrichArticles()` and `handleReloadJob()` for the
 * two implementations.
 *
 * A handler may return the given `article` unchanged (keep it, no further
 * processing), `null` (drop it / stop -- the handler has already done
 * whatever side effect that implies, such as writing an error notice), or
 * throw (propagate a failure to `enrichOne()`'s own caller, e.g. to fail a
 * job).
 */
export interface EnrichmentPolicy {
  /** `fetchArticleContent()` threw. */
  onFetchFailed(article: RawArticle, err: unknown): RawArticle | null | Promise<RawArticle | null>;
  /** Extraction succeeded but produced no usable body (`hasBodyContent()` is false). */
  onEmptyBody(article: RawArticle): RawArticle | null | Promise<RawArticle | null>;
}

/**
 * The one enrichment pipeline: extractHeaderElement -> fetchArticleContent ->
 * extractContent -> hasBodyContent. `processContent()` is deliberately
 * *not* part of it -- `reload.ts` reports job progress between "content
 * extracted" and "content processed" (see its own `progress(job.id, 55)`
 * call), which only works if that boundary stays visible to the caller
 * rather than being swallowed inside a single shared function.
 *
 * `extractHeaderElement()` is not wrapped in its own try/catch, matching
 * `reload.ts`'s original narrower scope: only `fetchArticleContent()`'s own
 * failure goes through `policy.onFetchFailed()` from inside this function.
 * `FullWebsiteAggregator.enrichArticles()` restores its own wider "anything
 * in these four steps counts" catch by wrapping *its* call to `enrichOne()`
 * in an outer try/catch that calls the very same `policy.onFetchFailed()` --
 * so an exception from `extractHeaderElement()` or `extractContent()` still
 * lands on the same policy hook there, exactly as it did before this
 * function existed, while `reload.ts`'s call site adds no such outer catch
 * and therefore still lets those two calls' exceptions propagate uncaught,
 * exactly as they did before too. Neither caller's observable failure
 * behaviour changes; only the shared middle is no longer duplicated.
 */
export async function enrichOne(
  aggregator: EnrichableAggregator,
  article: RawArticle,
  policy: EnrichmentPolicy,
): Promise<
  { status: "content"; content: string } | { status: "resolved"; article: RawArticle | null }
> {
  const url = article.identifier;

  const headerData = await aggregator.extractHeaderElement(article);
  if (headerData) {
    article.header_data = headerData;
  }

  let rawHtml: string;
  try {
    rawHtml = await aggregator.fetchArticleContent(url);
  } catch (err) {
    return { status: "resolved", article: await policy.onFetchFailed(article, err) };
  }
  article.raw_content = rawHtml;

  const content = await aggregator.extractContent(rawHtml, article);

  if (!hasBodyContent(content)) {
    return { status: "resolved", article: await policy.onEmptyBody(article) };
  }

  return { status: "content", content };
}

export class FullWebsiteAggregator extends RssAggregator {
  static selectorsToRemove: string[] = [IFRAME_SANITIZE_SELECTOR];
  static contentSelectors: string[] = [...DEFAULT_CONTENT_SELECTORS];

  protected selectorsToRemove: string[] = [...FullWebsiteAggregator.selectorsToRemove];
  protected contentSelectors: string[] = [...FullWebsiteAggregator.contentSelectors];

  getContentSelectors(): string[] {
    const options = this.feed.options || {};
    const configured = options.content_selectors ?? options.contentSelectors;
    if (configured) {
      const cleaned = this.cleanSelectorList(configured);
      if (cleaned.length > 0) {
        return cleaned;
      }
    }
    return [...this.contentSelectors];
  }

  getIgnoreSelectors(): string[] {
    const options = this.feed.options || {};
    const configured = options.ignore_selectors ?? options.ignoreSelectors;
    let removeList: string[];
    if (configured) {
      removeList = this.cleanSelectorList(configured);
    } else {
      removeList = [...DEFAULT_IGNORE_SELECTORS];
    }
    return [...this.selectorsToRemove, ...removeList];
  }

  protected cleanSelectorList(value: unknown): string[] {
    if (typeof value === "string") {
      return value
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }
    return [];
  }

  /**
   * The article headline, read straight off the fetched page -- never a
   * page's raw `<title>`, which is the site's headline plus its own branding
   * (see `sourceTitle`'s doc comment in `./base`). The default reports
   * nothing; a site overrides this with a selector that isolates the real
   * headline from surrounding chrome once it has one (heise, merkur,
   * tagesschau, caschys_blog, mein_mmo, mactechnews). Comics
   * (oglaf/explosm/dark_legacy) have no headline distinct from the feed's and
   * deliberately leave this unset.
   */
  protected sourceTitleFrom(_$: cheerio.CheerioAPI): string | null {
    return null;
  }

  async fetchArticleContent(url: string): Promise<string> {
    const html = await fetchHtml(url, { timeout: 30000 });
    // Cheap: this parse is thrown away immediately, and the page gets parsed
    // again downstream (extractContent, processContent) regardless -- one
    // more pass costs nothing next to a full HTML document already in hand,
    // and it's what lets `sourceTitleFrom()` read the real page rather than
    // requiring a second network round-trip (an RSS re-fetch, the way
    // `RssAggregator.fetchArticleContent()` does it) just to name a title.
    this.noteSourceTitle(this.sourceTitleFrom(cheerio.load(html)));
    return html;
  }

  /**
   * Extract this site's article body, falling back through the same three
   * tiers every `FullWebsiteAggregator` subclass now shares instead of each
   * inventing its own answer to "the selector found nothing":
   *
   *   1. `primary` -- the site-specific selector's result -- when it has real
   *      body content (`hasBodyContent()`'s text-or-media rule).
   *   2. A generic content guess (`genericContentIfPresent()`), gated on a
   *      minimum text length so a stray sidebar snippet doesn't win.
   *   3. `article.content` -- the RSS entry's own summary, already on the
   *      `RawArticle` from `parseToRawArticles()` (or, on reload, from
   *      whatever the caller seeded it with).
   *
   * **Never `<body>`.** Falling back to the whole document (what
   * `extractMainContent()` used to do, and what `MerkurAggregator` reached via
   * `super.extractContent()`) can surface site navigation, cookie banners and
   * related-article rails as "the article" -- exactly the risk this ladder
   * exists to avoid. A selector miss now degrades to *less* content
   * (the RSS summary) rather than *wrong* content.
   *
   * `keepPrimaryRegardless` is the one deliberate escape hatch, for
   * `TagesschauAggregator`: its primary extraction can legitimately have no
   * text or media of its own (an audio/video report whose only content is a
   * separately-tracked media header, spliced in by `processContent()`), and
   * `hasBodyContent()` has no way to see that header -- it isn't in
   * `primary` at all.
   */
  protected extractContentWithFallback(
    html: string,
    article: RawArticle,
    primary: string | null,
    keepPrimaryRegardless = false,
  ): string {
    if (primary !== null && (keepPrimaryRegardless || hasBodyContent(primary))) {
      return primary;
    }
    const generic = this.genericContentIfPresent(html, article);
    if (generic) {
      return generic;
    }
    return article.content || "";
  }

  extractContent(html: string, article: RawArticle): string | Promise<string> {
    const primary = extractMainContentIfPresent(
      html,
      this.getContentSelectors(),
      this.getIgnoreSelectors(),
      this.usesFirstContentMatch,
    );
    return this.extractContentWithFallback(html, article, primary);
  }

  genericContentIfPresent(rawHtml: string, _article: RawArticle): string | null {
    const extracted = extractMainContentIfPresent(
      rawHtml,
      [...DEFAULT_CONTENT_SELECTORS],
      this.getIgnoreSelectors(),
    );
    if (!extracted) return null;

    const $ = cheerio.load(extracted);
    const text = $.text().trim();
    if (text.length < GENERIC_CONTENT_MIN_TEXT_LENGTH) {
      return null;
    }
    return extracted;
  }

  async processContent(html: string, article: RawArticle): Promise<string> {
    const labels = await this.chromeLabels();
    const $ = cheerio.load(html);

    await proxyYoutubeEmbeds($, labels);

    const headerData = article.header_data;
    if (headerData?.imageUrl) {
      removeImageByUrl($, headerData.imageUrl);
    }

    sanitizeClassNames($);

    const cleaned = cleanHtml($.html());
    const headerImageUrl = headerData ? getHeaderImageRef(headerData) : null;

    return formatArticleContent(cleaned, article.name, article.identifier, labels, headerImageUrl);
  }

  /**
   * `onFetchFailed()`/`onEmptyBody()` below are the aggregation half of
   * `EnrichmentPolicy` -- see its doc comment and `enrichOne()`'s in ./website
   * for how `reload.ts` supplies a different pair for the same shared
   * pipeline. Both hooks, and the outer try/catch around `enrichOne()` in the
   * loop below, reproduce this method's pre-unification behaviour exactly:
   * an `ArticleSkipError` (HTTP 4xx) from *any* of extractHeaderElement,
   * fetchArticleContent or extractContent drops the article silently; any
   * other exception from those same three calls keeps the article's original
   * (unenriched) content, logged; and an extraction that produces no body at
   * all (`hasBodyContent()` false) drops the article, logged.
   */
  async enrichArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    const onFetchFailed = (article: RawArticle, err: unknown): RawArticle | null => {
      if (err instanceof ArticleSkipError) {
        // Skip article on HTTP 4xx errors
        return null;
      }
      // Keep original RSS article on fetch/extraction errors -- but log
      // it, since silently falling back here looked identical to a
      // successful enrichment that just happened to find nothing.
      const detail = err instanceof Error ? err.message : String(err);
      const message = `[website] enrichment failed for ${article.identifier}, keeping original: ${detail}`;
      console.warn(message);
      this.onLog?.(message);
      return article;
    };

    const policy: EnrichmentPolicy = {
      onFetchFailed,
      // Skip rather than store: an article with no body is not a shorter
      // article, it is a failed extraction, and storing it is permanent --
      // an aggregation run only ever sees the entries the feed currently
      // lists, so once this one ages out of that window nothing refetches
      // it. Dropping it leaves the next run free to create it properly
      // while the entry is still there (a site that publishes a stub and
      // fills in the prose an hour later is the case this exists for).
      onEmptyBody: (article) => {
        const message = `[website] no body extracted for ${article.identifier}, skipping article`;
        console.warn(message);
        this.onLog?.(message);
        return null;
      },
    };

    const results = await mapWithConcurrency(
      articles,
      this.concurrency,
      async (article): Promise<RawArticle | null> => {
        try {
          const step = await enrichOne(this, article, policy);
          if (step.status === "resolved") {
            return step.article;
          }
          const processed = await this.processContent(step.content, article);
          article.content = processed;
          return article;
        } catch (err) {
          // extractHeaderElement()/extractContent() exceptions never reach
          // `enrichOne()`'s own try/catch (that only wraps fetchArticleContent
          // -- see its doc comment), so they surface here instead. Routed
          // through the same policy hook as a fetch failure, exactly as this
          // method's single try/catch treated them before the pipeline was
          // shared with reload.ts.
          return onFetchFailed(article, err);
        }
      },
    );

    return results.filter((a): a is RawArticle => a !== null);
  }
}

export class RssSummaryFallbackAggregator extends FullWebsiteAggregator {
  extractContent(html: string, article: RawArticle): string {
    const extracted = extractMainContentIfPresent(
      html,
      this.getContentSelectors(),
      this.getIgnoreSelectors(),
      this.usesFirstContentMatch,
    );

    if (extracted === null) {
      return article.content || "";
    }

    return extracted;
  }
}
