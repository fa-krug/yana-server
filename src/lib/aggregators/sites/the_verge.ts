import * as cheerio from "cheerio";
import { FeedLike } from "../base";
import { IFRAME_SANITIZE_SELECTOR, RssSummaryFallbackAggregator } from "../website";

export class TheVergeAggregator extends RssSummaryFallbackAggregator {
  static contentSelectors = [".duet--layout--entry-body .duet--article--article-body-component"];
  protected contentSelectors = [...TheVergeAggregator.contentSelectors];

  static selectorsToRemove = [
    IFRAME_SANITIZE_SELECTOR,
    "aside",
    "[class*='duet--recirculation']",
    "[class*='duet--ad']",
    "[class*='newsletter']",
    "script",
    "style",
    "noscript",
    "svg",
  ];
  protected selectorsToRemove = [...TheVergeAggregator.selectorsToRemove];

  usesFirstContentMatch = false;

  constructor(feed: FeedLike) {
    super(feed);
    if (!this.identifier) {
      this.identifier = "https://www.theverge.com/rss/index.xml";
    }
  }

  /**
   * The article headline, read via Open Graph off the raw fetched page.
   * This CMS's `og:title` convention carries the article's own headline
   * (branding lives separately in `og:site_name`), the same convention
   * `MeinMmoAggregator.sourceTitleFrom()` already relies on as its own
   * fallback tier. A miss degrades to `null` -- the stored name is kept --
   * so an absent or wrong tag never risks storing branding as the title.
   */
  protected override sourceTitleFrom($: cheerio.CheerioAPI): string | null {
    const title = $('meta[property="og:title"]').attr("content");
    return title?.trim() || null;
  }

  override getSourceUrl(): string {
    return "https://www.theverge.com";
  }
}
