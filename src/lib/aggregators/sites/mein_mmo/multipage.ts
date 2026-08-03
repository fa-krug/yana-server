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
 * Fetch all pages and combine content divs.
 *
 * @param baseUrl - Base article URL
 * @param pageNumbers - Set of page numbers to fetch
 * @param fetcher - Function to fetch HTML from URL
 * @param firstPageHtml - Already fetched HTML for the first page
 * @returns Combined HTML with all content divs
 */
export async function fetchAllPages(
  baseUrl: string,
  pageNumbers: Set<number>,
  fetcher: (pageUrl: string) => Promise<string>,
  firstPageHtml?: string | null,
): Promise<string> {
  const sortedPages = Array.from(pageNumbers).sort((a, b) => a - b);
  const contentParts: string[] = [];

  for (const pageNum of sortedPages) {
    let pageUrl: string;
    if (pageNum === 1) {
      pageUrl = baseUrl;
    } else {
      pageUrl = baseUrl.endsWith("/") ? `${baseUrl}${pageNum}/` : `${baseUrl}/${pageNum}/`;
    }

    try {
      let pageHtml: string;
      if (pageNum === 1 && firstPageHtml) {
        pageHtml = firstPageHtml;
      } else {
        pageHtml = await fetcher(pageUrl);
      }

      const $ = cheerio.load(pageHtml);
      const contentDiv = $("div.entry-content, div.gp-entry-content").first();

      if (contentDiv.length > 0) {
        contentParts.push($.html(contentDiv));
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
