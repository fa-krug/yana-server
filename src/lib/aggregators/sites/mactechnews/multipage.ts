import * as cheerio from "cheerio";
import { selectContentElements } from "../../extract/content";

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
 * Build URL for a specific page number using query parameters.
 */
export function buildPageUrl(baseUrl: string, pageNum: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set("page", String(pageNum));
  return url.toString();
}

/**
 * Fetch all pages and combine content.
 *
 * @param baseUrl - Base article URL
 * @param pageNumbers - Set of page numbers to fetch
 * @param contentSelectors - CSS selectors for the content container
 * @param fetcher - Function to fetch HTML from URL
 * @param firstPageHtml - Already fetched HTML for the first page
 * @returns Combined HTML with content from all pages
 */
export async function fetchAllPages(
  baseUrl: string,
  pageNumbers: Set<number>,
  contentSelectors: string[],
  fetcher: (url: string) => Promise<string>,
  firstPageHtml?: string | null,
): Promise<string> {
  const sortedPages = Array.from(pageNumbers).sort((a, b) => a - b);
  const contentParts: string[] = [];

  for (const pageNum of sortedPages) {
    const pageUrl = pageNum === 1 ? baseUrl : buildPageUrl(baseUrl, pageNum);

    try {
      let pageHtml: string;
      if (pageNum === 1 && firstPageHtml) {
        pageHtml = firstPageHtml;
      } else {
        pageHtml = await fetcher(pageUrl);
      }

      const $ = cheerio.load(pageHtml);
      const matches = selectContentElements($, contentSelectors, true);

      if (matches.length > 0) {
        const contentHtml = $.html(matches[0]);
        contentParts.push(contentHtml);
      }
    } catch {
      continue;
    }
  }

  if (contentParts.length === 0) {
    return "";
  }

  return contentParts.join("\n\n");
}
