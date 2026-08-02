import { BaseAggregator, RawArticle } from "./base";
import { discoverFeedUrl, parseRssFeed, ParsedFeed, unescapeEntities } from "./rss-parser";

export class RssAggregator extends BaseAggregator {
  static unescapeEntities = unescapeEntities;

  protected parseDate(dateStr?: string | null): Date {
    if (!dateStr) return new Date();
    const parsed = new Date(dateStr);
    if (isNaN(parsed.getTime())) {
      return new Date();
    }
    return parsed;
  }

  async fetchSourceData(_limit?: number): Promise<ParsedFeed> {
    try {
      return await parseRssFeed(this.identifier);
    } catch (err) {
      let isUrl = false;
      try {
        const u = new URL(this.identifier);
        isUrl = Boolean(u.protocol && u.host);
      } catch {
        isUrl = false;
      }

      if (!isUrl) {
        throw err;
      }

      const discovered = await discoverFeedUrl(this.identifier);
      if (!discovered || discovered === this.identifier) {
        throw err;
      }

      return await parseRssFeed(discovered);
    }
  }

  async parseToRawArticles(sourceData: unknown): Promise<RawArticle[]> {
    const feed = sourceData as ParsedFeed;
    const entries = feed?.entries || [];
    const articles: RawArticle[] = [];
    const limit = this.getCurrentRunLimit();

    for (const entry of entries.slice(0, limit > 0 ? limit : entries.length)) {
      articles.push({
        name: unescapeEntities(entry.title || ""),
        identifier: entry.link || "",
        raw_content: "",
        content: entry.summary || "",
        date: this.parseDate(entry.published),
        author: unescapeEntities(entry.author || ""),
        icon: null,
      });
    }

    return articles;
  }
}
