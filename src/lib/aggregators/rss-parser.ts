import * as cheerio from "cheerio";

import { fetchHtml } from "./http/fetcher";

export interface FeedEntry {
  title: string;
  link: string;
  summary: string;
  published?: string;
  author?: string;
}

export interface ParsedFeed {
  title?: string;
  link?: string;
  entries: FeedEntry[];
}

export const RSS_TYPE = "application/rss+xml";
export const ATOM_TYPE = "application/atom+xml";
export const FEED_TYPE_PRIORITY = [RSS_TYPE, ATOM_TYPE];

/**
 * Undo HTML-entity encoding in plain-text feed metadata (title, author).
 */
export function unescapeEntities(value: string): string {
  if (!value) return "";
  return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z0-9]+));/g, (match, dec, hex, name) => {
    if (dec) return String.fromCharCode(parseInt(dec, 10));
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    const entities: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " ",
      rsquo: "’",
      lsquo: "‘",
      rdquo: "”",
      ldquo: "“",
      mdash: "—",
      ndash: "–",
    };
    return entities[name] ?? match;
  });
}

/**
 * First alternate RSS/Atom feed href in `html`, resolved absolute.
 */
export function feedUrlInHtml(html: string, baseUrl?: string): string | null {
  if (!html) return null;
  const $ = cheerio.load(html);
  const firstByType: Record<string, string> = {};

  $("link").each((_, elem) => {
    const relAttr = ($(elem).attr("rel") || "").toLowerCase();
    const rels = relAttr.split(/\s+/);
    if (!rels.includes("alternate")) return;

    const linkType = ($(elem).attr("type") || "").trim().toLowerCase();
    if (!FEED_TYPE_PRIORITY.includes(linkType)) return;

    const href = ($(elem).attr("href") || "").trim();
    if (!href) return;

    if (!firstByType[linkType]) {
      firstByType[linkType] = href;
    }
  });

  for (const wanted of FEED_TYPE_PRIORITY) {
    const feedHref = firstByType[wanted];
    if (feedHref) {
      if (baseUrl) {
        try {
          return new URL(feedHref, baseUrl).toString();
        } catch {
          return feedHref;
        }
      }
      return feedHref;
    }
  }

  return null;
}

/**
 * Fetch `pageUrl` and return its advertised feed URL, or `null`.
 */
export async function discoverFeedUrl(pageUrl: string): Promise<string | null> {
  try {
    const html = await fetchHtml(pageUrl, { timeout: 30000 });
    return feedUrlInHtml(html, pageUrl);
  } catch {
    return null;
  }
}

/**
 * Parse an XML string representing an RSS 2.0 or Atom feed.
 */
export function parseXmlFeed(xml: string): ParsedFeed {
  if (!xml || typeof xml !== "string") {
    throw new Error("Invalid feed data: empty content");
  }

  const $ = cheerio.load(xml, { xmlMode: true });
  const entries: FeedEntry[] = [];

  // 1. Try RSS items (<item>)
  const items = $("item");
  if (items.length > 0) {
    items.each((_, elem) => {
      const $item = $(elem);
      const title = $item.find("title").first().text().trim();
      let link = $item.find("link").first().text().trim();
      if (!link) {
        link = $item.find("link").first().attr("href")?.trim() || "";
      }
      const summary =
        $item.find("content\\:encoded").first().text() ||
        $item.find("encoded").first().text() ||
        $item.find("description").first().text();
      const published =
        $item.find("pubDate").first().text().trim() ||
        $item.find("dc\\:date").first().text().trim() ||
        $item.find("date").first().text().trim();
      const author =
        $item.find("dc\\:creator").first().text().trim() ||
        $item.find("author").first().text().trim();

      entries.push({ title, link, summary, published, author });
    });
  } else {
    // 2. Try Atom entries (<entry>)
    const atomEntries = $("entry");
    if (atomEntries.length > 0) {
      atomEntries.each((_, elem) => {
        const $entry = $(elem);
        const title = $entry.find("title").first().text().trim();

        let link = $entry.find("link[rel='alternate']").attr("href")?.trim();
        if (!link) {
          link =
            $entry.find("link").first().attr("href")?.trim() ||
            $entry.find("link").first().text().trim();
        }

        const summary =
          $entry.find("content").first().text() || $entry.find("summary").first().text();
        const published =
          $entry.find("published").first().text().trim() ||
          $entry.find("updated").first().text().trim();
        const author =
          $entry.find("author name").first().text().trim() ||
          $entry.find("author").first().text().trim();

        entries.push({ title, link, summary, published, author });
      });
    }
  }

  if (entries.length === 0) {
    throw new Error("No feed entries found");
  }

  const feedTitle = $("channel > title, feed > title").first().text().trim();
  const feedLink = $("channel > link, feed > link").first().text().trim();

  return {
    title: feedTitle,
    link: feedLink,
    entries,
  };
}

/**
 * Fetch and parse an RSS or Atom feed from a URL or raw XML string.
 */
export async function parseRssFeed(input: string): Promise<ParsedFeed> {
  if (!input) {
    throw new Error("Feed identifier is required");
  }

  let xml = input;
  if (input.startsWith("http://") || input.startsWith("https://")) {
    xml = await fetchHtml(input, { timeout: 30000 });
  }

  return parseXmlFeed(xml);
}
