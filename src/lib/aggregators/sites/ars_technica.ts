import * as cheerio from "cheerio";
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
    return "https://arstechnica.com";
  }
}
