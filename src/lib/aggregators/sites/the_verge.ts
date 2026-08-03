import { FeedLike } from "../base";
import { IFRAME_SANITIZE_SELECTOR, RssSummaryFallbackAggregator } from "../website";

export class TheVergeAggregator extends RssSummaryFallbackAggregator {
  static brandSiteUrl = "https://www.theverge.com/";

  static getDefaultIdentifier(): string {
    return "https://www.theverge.com/rss/index.xml";
  }

  static getIdentifierChoices(): Array<[string, string]> {
    return [["https://www.theverge.com/rss/index.xml", "Main Feed"]];
  }

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

  override getSourceUrl(): string {
    return "https://www.theverge.com";
  }
}
