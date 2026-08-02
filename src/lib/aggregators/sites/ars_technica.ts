import { FeedLike } from "../base";
import { IFRAME_SANITIZE_SELECTOR, RssSummaryFallbackAggregator } from "../website";

export class ArsTechnicaAggregator extends RssSummaryFallbackAggregator {
  static brandSiteUrl = "https://arstechnica.com/";

  static getDefaultIdentifier(): string {
    return "https://arstechnica.com/feed/";
  }

  static getIdentifierChoices(): Array<[string, string]> {
    return [
      ["https://arstechnica.com/feed/", "Main Feed"],
      ["https://arstechnica.com/gadgets/feed/", "Gadgets"],
      ["https://arstechnica.com/science/feed/", "Science"],
      ["https://arstechnica.com/gaming/feed/", "Gaming"],
    ];
  }

  static contentSelectors = [".post-content"];
  protected contentSelectors = [...ArsTechnicaAggregator.contentSelectors];

  static selectorsToRemove = [
    IFRAME_SANITIZE_SELECTOR,
    ".ad",
    "[class*='ad-wrapper']",
    ".ad--mid-content",
    ".ad--rail",
    ".social-share",
    "aside",
    "script",
    "style",
    "noscript",
    "svg",
  ];
  protected selectorsToRemove = [...ArsTechnicaAggregator.selectorsToRemove];

  usesFirstContentMatch = false;

  constructor(feed: FeedLike) {
    super(feed);
    if (!this.identifier) {
      this.identifier = "https://arstechnica.com/feed/";
    }
  }

  override getSourceUrl(): string {
    return "https://arstechnica.com";
  }
}
