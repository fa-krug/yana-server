import * as cheerio from "cheerio";
import { selectContentElements } from "./extract/content";

/**
 * The result of combining a multi-page article's pages into one, alongside
 * the raw, un-truncated first page -- see `firstPage`'s doc comment for why
 * a caller needs both rather than just `combined`.
 */
export interface CombinedPages {
  /**
   * Every page's matched content container (`contentSelectors`), joined in
   * page order. This is what a site's `extractContent()` selector runs
   * against next -- it is *not* the whole first page (see `firstPage`).
   */
  combined: string;
  /**
   * The raw, un-truncated HTML of page 1, exactly as fetched -- before any
   * content selector narrowed it down to just the article body. Some
   * comment sections (MacTechNews' `div.MtnCommentScroll`, Mein-MMO's
   * wpDiscuz thread) live *outside* the site's content selectors, so a
   * comment extractor handed only `combined` -- which only ever contains
   * `contentSelectors` matches from every page -- finds nothing. Returning
   * this alongside `combined`, rather than leaving each call site to
   * separately remember the already-fetched first page, is what makes it
   * structurally impossible to combine pages and lose the one page a
   * comment extractor needs (see `FirstPageStash` below for how a call site
   * carries it forward to `processContent()`).
   */
  firstPage: string;
}

/**
 * Builds the URL for page N (N > 1) of a paginated article; page 1 is
 * always `baseUrl` itself, so implementations never need to handle it.
 */
export type PageUrlBuilder = (baseUrl: string, pageNum: number) => string;

/**
 * Fetch every page of a paginated article and combine each page's matched
 * content container into one HTML string, in page order.
 *
 * Shared by MacTechNews and Mein-MMO (`sites/mactechnews/multipage.ts`,
 * `sites/mein_mmo/multipage.ts`), whose per-site modules used to each
 * hand-roll this same ~35-line loop, differing only in how a page's URL is
 * built (`?page=N` vs `/N/` -- each site's own `buildPageUrl()`, passed in
 * here) and which selectors mark the content container (`contentSelectors`,
 * also passed in). `detectPagination()` legitimately differs per site --
 * each has its own DOM shape for the pagination widget itself -- and stays
 * in each site's own module, not here.
 *
 * @param baseUrl - Page 1's URL.
 * @param pageNumbers - Every page number to fetch (from `detectPagination()`).
 * @param contentSelectors - CSS selectors for the content container.
 * @param fetcher - Fetches a page's HTML (page 2+ only -- page 1 is already
 *   in hand as `firstPageHtml`, so this is never called for page 1).
 * @param firstPageHtml - Page 1's HTML, already fetched by the caller.
 * @param buildPageUrl - This site's page-N URL builder.
 */
export async function fetchAllPages(
  baseUrl: string,
  pageNumbers: Set<number>,
  contentSelectors: string[],
  fetcher: (url: string) => Promise<string>,
  firstPageHtml: string,
  buildPageUrl: PageUrlBuilder,
): Promise<CombinedPages> {
  const sortedPages = Array.from(pageNumbers).sort((a, b) => a - b);
  const contentParts: string[] = [];

  for (const pageNum of sortedPages) {
    const pageUrl = pageNum === 1 ? baseUrl : buildPageUrl(baseUrl, pageNum);

    try {
      const pageHtml = pageNum === 1 ? firstPageHtml : await fetcher(pageUrl);
      const $ = cheerio.load(pageHtml);
      const matches = selectContentElements($, contentSelectors, true);

      if (matches.length > 0) {
        contentParts.push($.html(matches[0]));
      }
    } catch {
      continue;
    }
  }

  return {
    combined: contentParts.length > 0 ? contentParts.join("\n\n") : "",
    firstPage: firstPageHtml,
  };
}

/**
 * Per-run scratch space associating a paginated article's URL with its raw,
 * un-truncated first page -- for a comment extractor that must read the
 * whole first page rather than `fetchAllPages()`'s `combined` result (see
 * `CombinedPages.firstPage`'s doc comment for why `combined` alone can't
 * serve this).
 *
 * Keyed by URL, not a single field: `FullWebsiteAggregator.enrichArticles()`
 * runs `fetchArticleContent()` for up to `this.concurrency` articles
 * concurrently on one aggregator instance, so a single field would be
 * overwritten by a sibling article's fetch while this article's own
 * `processContent()` was still awaiting its own work (this is exactly the
 * race Mein-MMO's original `firstPageHtml` field hit, before it became a
 * map -- see the regression test in `sites/mein_mmo/aggregator.test.ts`).
 * Each entry is deleted once read: one aggregator instance only ever
 * processes one feed's articles in one run, so this is a bounded per-run
 * scratch space, never a cache.
 */
export class FirstPageStash {
  private byUrl = new Map<string, string>();

  set(url: string, html: string): void {
    this.byUrl.set(url, html);
  }

  /**
   * Reads and clears this URL's stashed page. `null` when nothing was
   * stashed for it (e.g. `fetchArticleContent()` was never called for this
   * URL on this instance).
   */
  take(url: string): string | null {
    const html = this.byUrl.get(url);
    this.byUrl.delete(url);
    return html ?? null;
  }
}
