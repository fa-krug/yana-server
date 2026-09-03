import * as cheerio from "cheerio";

/**
 * Detect page numbers from pagination elements in Mein-MMO articles.
 *
 * Looks for:
 * - div.page-links (contains a.post-page-numbers and span.post-page-numbers)
 *
 * @param html - HTML content to parse
 * @returns Set of page numbers (always includes 1)
 */
export function detectPagination(html: string): Set<number> {
  const $ = cheerio.load(html);
  const pageNumbers = new Set<number>([1]);

  // Try to find pagination within the content area first to avoid header/footer pagination
  const contentDiv = $("div.entry-content, div.gp-entry-content").first();
  let pagination = contentDiv.length > 0 ? contentDiv.find("div.page-links").first() : null;

  // Fallback to global search if not found in content div
  if (!pagination || pagination.length === 0) {
    pagination = $("div.page-links").first();
  }

  if (!pagination || pagination.length === 0) {
    return pageNumbers;
  }

  // Extract page numbers from links (a.post-page-numbers)
  pagination.find("a.post-page-numbers").each((_, link) => {
    const text = $(link).text().trim();
    if (/^\d+$/.test(text)) {
      pageNumbers.add(parseInt(text, 10));
    }

    // Try URL pattern: /article-name/2/
    const href = $(link).attr("href") || "";
    if (href) {
      const match = href.match(/\/(\d+)\/?$/);
      if (match && match[1]) {
        pageNumbers.add(parseInt(match[1], 10));
      }
    }
  });

  // Extract current page from spans (span.post-page-numbers)
  pagination.find("span.post-page-numbers").each((_, span) => {
    const text = $(span).text().trim();
    if (/^\d+$/.test(text)) {
      pageNumbers.add(parseInt(text, 10));
    }
  });

  return pageNumbers;
}

/**
 * Build URL for a specific page number using path-segment pagination
 * (`/N/`) -- the one genuine difference from MacTechNews' query-parameter
 * form (`?page=N`, see ../mactechnews/multipage.ts's `buildPageUrl()`).
 * Everything else about fetching and combining a paginated article's pages
 * is shared, in ../../multipage.ts.
 */
export function buildPageUrl(baseUrl: string, pageNum: number): string {
  return baseUrl.endsWith("/") ? `${baseUrl}${pageNum}/` : `${baseUrl}/${pageNum}/`;
}
