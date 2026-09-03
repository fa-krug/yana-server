import * as cheerio from "cheerio";

/**
 * Detect page numbers from MacTechNews pagination elements.
 *
 * MacTechNews uses ?page=N query parameters for multi-page articles.
 * The pagination section contains links with ?page=N and the current page
 * as plain (non-linked) text inside <strong>N</strong>.
 *
 * @param html - HTML content to parse
 * @returns Set of page numbers (always includes 1)
 */
export function detectPagination(html: string): Set<number> {
  const $ = cheerio.load(html);
  const pageNumbers = new Set<number>([1]);

  // Find all links containing ?page=N or &page=N
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/[?&]page=(\d+)/);
    if (match) {
      pageNumbers.add(parseInt(match[1], 10));
    }
  });

  // Detect the current page (rendered as <strong>N</strong> without a link)
  $("strong").each((_, el) => {
    const text = $(el).text().trim();
    if (/^\d+$/.test(text)) {
      pageNumbers.add(parseInt(text, 10));
    }
  });

  return pageNumbers;
}

/**
 * Build URL for a specific page number using query parameters -- the one
 * genuine difference from Mein-MMO's path-segment pagination (`/N/`, see
 * ../mein_mmo/multipage.ts's `buildPageUrl()`). Everything else about
 * fetching and combining a paginated article's pages is shared, in
 * `../../multipage.ts`.
 */
export function buildPageUrl(baseUrl: string, pageNum: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set("page", String(pageNum));
  return url.toString();
}
