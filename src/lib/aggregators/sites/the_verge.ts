import * as cheerio from "cheerio";
import { defineSite } from "../define-site";
import { IFRAME_SANITIZE_SELECTOR, RssSummaryFallbackAggregator } from "../website";

export class TheVergeAggregator extends defineSite(RssSummaryFallbackAggregator, {
  key: "the_verge",
  siteUrl: "https://www.theverge.com",
  content: [".duet--layout--entry-body .duet--article--article-body-component"],
  remove: [
    IFRAME_SANITIZE_SELECTOR,
    "aside",
    "[class*='duet--recirculation']",
    "[class*='duet--ad']",
    "[class*='newsletter']",
    "script",
    "style",
    "noscript",
    "svg",
  ],
  firstMatchOnly: false,
}) {
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
}
