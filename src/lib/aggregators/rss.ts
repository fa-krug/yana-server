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

  /**
   * A plain RSS/"Feed Content" feed never fetches a full page -- the entry's
   * own `summary` *is* the article's content, both on first aggregation
   * (`parseToRawArticles()` below) and here on reload. So "fetch from
   * source" for this aggregator means re-fetching the feed itself and
   * finding this article's entry again by its link, not fetching `url` as a
   * page. Returns "" (reload.ts's existing "could not be reloaded" branch)
   * when the feed can no longer be reached or no longer lists this entry --
   * e.g. it aged out of the feed's own window.
   */
  async fetchArticleContent(url: string): Promise<string> {
    try {
      const feed = await this.fetchSourceData();
      const entry = feed.entries.find((e) => e.link === url);
      // Unescaped exactly as parseToRawArticles() below does it, so reload and
      // a fresh aggregation run report the same title for the same entry. It is
      // what keeps reload from feeding a previous AI run's title back into the
      // AI stage -- see `noteSourceTitle()` in ./base.
      this.noteSourceTitle(entry ? unescapeEntities(entry.title || "") : null);
      return entry?.summary || "";
    } catch {
      return "";
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
