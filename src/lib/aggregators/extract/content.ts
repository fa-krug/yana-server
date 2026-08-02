import * as cheerio from "cheerio";
import type { Element } from "domhandler";

/**
 * Selectors always removed before content selection.
 * Emptying ignore_selectors must never disable sanitization of these elements.
 */
export const MANDATORY_REMOVE_SELECTORS: string[] = ["script", "style", "noscript", "template"];

/**
 * Defaults mirrored from the iOS client's shipped AggregatorOptions.swift.
 */
export const DEFAULT_CONTENT_SELECTORS: string[] = [
  "article",
  ".article-content",
  ".entry-content",
  "main",
];

export const DEFAULT_IGNORE_SELECTORS: string[] = [
  ".advertisement",
  ".ad",
  ".ads",
  "[class*='advert']",
  "[class*='sponsor']",
  ".social-share",
  ".newsletter",
  ".related-articles",
];

function removeMatching(
  $: cheerio.CheerioAPI,
  rootElement: Element | cheerio.CheerioAPI,
  selectors: string[],
): void {
  for (const selector of selectors) {
    try {
      if (typeof rootElement === "function") {
        rootElement(selector).remove();
      } else {
        $(rootElement as Element)
          .find(selector)
          .remove();
      }
    } catch {
      // Skip invalid remove selectors
    }
  }
}

/**
 * Collect the content containers matching any of `contentSelectors`.
 *
 * Matches are returned in document order, de-duplicated, and reduced to the
 * outermost elements -- a match nested inside another match is dropped so its body
 * is not captured twice.
 */
export function selectContentElements(
  root: cheerio.CheerioAPI | cheerio.Cheerio<Element>,
  contentSelectors: string[],
  firstMatchOnly = false,
): Element[] {
  const matchedNodes = new Set<Element>();

  for (const selector of contentSelectors) {
    try {
      const matches = typeof root === "function" ? root(selector) : root.find(selector);
      matches.each((_, elem) => {
        if (elem.type === "tag") {
          matchedNodes.add(elem as Element);
        }
      });
    } catch {
      // Skip invalid content selectors
    }
  }

  if (matchedNodes.size === 0) {
    return [];
  }

  // Walking all tags yields document order
  const allElements: Element[] = [];
  const searchRoot = typeof root === "function" ? root("*") : root.find("*");
  searchRoot.each((_, elem) => {
    if (elem.type === "tag") {
      allElements.push(elem as Element);
    }
  });

  const ordered = allElements.filter((elem) => matchedNodes.has(elem));

  const getParents = (elem: Element): Element[] => {
    const parents: Element[] = [];
    let curr = elem.parentNode;
    while (curr) {
      if (curr.type === "tag") {
        parents.push(curr as Element);
      }
      curr = curr.parentNode;
    }
    return parents;
  };

  const outermost = ordered.filter((tag) => {
    const parents = getParents(tag);
    return !parents.some((parent) => matchedNodes.has(parent));
  });

  if (firstMatchOnly) {
    return outermost.slice(0, 1);
  }
  return outermost;
}

/**
 * Extract article content, reporting a miss (null) instead of falling back to <body>.
 *
 * Used by scrapers with a dedicated article container, where a `<body>`
 * fallback would surface site navigation as the article.
 */
export function extractMainContentIfPresent(
  html: string,
  contentSelectors: string[],
  removeSelectors: string[] = [],
  firstMatchOnly = false,
): string | null {
  const $ = cheerio.load(html);
  removeMatching($, $, MANDATORY_REMOVE_SELECTORS);

  const elements = selectContentElements($, contentSelectors, firstMatchOnly);
  if (elements.length === 0) {
    return null;
  }

  for (const elem of elements) {
    if (removeSelectors.length > 0) {
      removeMatching($, elem, removeSelectors);
    }
  }

  return elements.map((elem) => $.html(elem)).join("\n");
}

/**
 * Extract main content from HTML using a list of CSS selectors.
 *
 * Every selector is applied and the surviving containers are concatenated, so
 * an article split across sibling containers is no longer truncated.
 * Falls back to <body> when nothing matched.
 */
export function extractMainContent(
  html: string,
  contentSelectors: string[],
  removeSelectors: string[] = [],
  firstMatchOnly = false,
): string {
  const extracted = extractMainContentIfPresent(
    html,
    contentSelectors,
    removeSelectors,
    firstMatchOnly,
  );
  if (extracted !== null) {
    return extracted;
  }

  const $ = cheerio.load(html);
  removeMatching($, $, MANDATORY_REMOVE_SELECTORS);

  const body = $("body");
  if (body.length > 0) {
    if (removeSelectors.length > 0) {
      removeMatching($, body.get(0) as Element, removeSelectors);
    }
    return $.html(body);
  } else {
    if (removeSelectors.length > 0) {
      removeMatching($, $, removeSelectors);
    }
    return $.html();
  }
}
