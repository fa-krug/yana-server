import * as cheerio from "cheerio";

import { RawArticle } from "./base";
import type { ChromeLabels } from "./chrome-labels";
import { mapWithConcurrency } from "./concurrency";
import { ArticleSkipError } from "./errors";
import { cleanHtml, removeImageByUrl, sanitizeClassNames } from "./extract/clean";
import {
  DEFAULT_CONTENT_SELECTORS,
  DEFAULT_IGNORE_SELECTORS,
  extractMainContent,
  extractMainContentIfPresent,
} from "./extract/content";
import {
  createYoutubeEmbedHtml,
  extractYoutubeVideoId,
  formatArticleContent,
} from "./extract/format";
import { localizeThumbnail } from "./embeds/youtube";
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

export function isYoutubeUrl(url: string): boolean {
  if (!url) return false;
  const youtubeDomains = ["youtube.com", "youtu.be", "m.youtube.com", "youtube-nocookie.com"];
  return youtubeDomains.some((domain) => url.includes(domain));
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
    const videoId = href ? extractYoutubeVideoId(href) : null;
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
      const videoId = extractYoutubeVideoId(src);
      if (videoId) {
        const thumbnailRef = await localizeThumbnail(videoId);
        $iframe.replaceWith(createYoutubeEmbedHtml(videoId, labels, "", thumbnailRef));
      }
    }
  }
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

  async fetchArticleContent(url: string): Promise<string> {
    return fetchHtml(url, { timeout: 30000 });
  }

  extractContent(html: string, _article: RawArticle): string | Promise<string> {
    return extractMainContent(
      html,
      this.getContentSelectors(),
      this.getIgnoreSelectors(),
      this.usesFirstContentMatch,
    );
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

  async enrichArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    const results = await mapWithConcurrency(
      articles,
      this.concurrency,
      async (article): Promise<RawArticle | null> => {
        const url = article.identifier;
        try {
          const headerData = await this.extractHeaderElement(article);
          if (headerData) {
            article.header_data = headerData;
          }

          const rawHtml = await this.fetchArticleContent(url);
          article.raw_content = rawHtml;

          const content = await this.extractContent(rawHtml, article);

          // Skip rather than store: an article with no body is not a shorter
          // article, it is a failed extraction, and storing it is permanent --
          // an aggregation run only ever sees the entries the feed currently
          // lists, so once this one ages out of that window nothing refetches
          // it. Dropping it leaves the next run free to create it properly
          // while the entry is still there (a site that publishes a stub and
          // fills in the prose an hour later is the case this exists for).
          if (!hasBodyContent(content)) {
            const message = `[website] no body extracted for ${url}, skipping article`;
            console.warn(message);
            this.onLog?.(message);
            return null;
          }

          const processed = await this.processContent(content, article);
          article.content = processed;

          return article;
        } catch (err) {
          if (err instanceof ArticleSkipError) {
            // Skip article on HTTP 4xx errors
            return null;
          }
          // Keep original RSS article on fetch/extraction errors -- but log
          // it, since silently falling back here looked identical to a
          // successful enrichment that just happened to find nothing.
          const detail = err instanceof Error ? err.message : String(err);
          const message = `[website] enrichment failed for ${url}, keeping original: ${detail}`;
          console.warn(message);
          this.onLog?.(message);
          return article;
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
