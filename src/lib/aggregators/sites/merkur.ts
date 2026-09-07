import * as cheerio from "cheerio";
import { RawArticle } from "../base";
import {
  removeEmptyElements,
  sanitizeHtmlAttributes,
  removeSanitizedAttributes,
  trimEdgeWhitespace,
} from "../extract/clean";
import { extractMainContentIfPresent } from "../extract/content";
import { YOUTUBE_IFRAME_KEEP_SELECTOR } from "../embeds/youtube-url";
import { defineSite } from "../define-site";
import { FullWebsiteAggregator, proxyYoutubeEmbeds } from "../website";

export class MerkurAggregator extends defineSite(FullWebsiteAggregator, {
  key: "merkur",
  siteUrl: "https://www.merkur.de",
  content: [".idjs-Story"],
  remove: [
    ".id-DonaldBreadcrumb--default",
    ".id-StoryElement-headline",
    ".id-StoryElement-image",
    ".lp_west_printAction",
    ".lp_west_webshareAction",
    ".id-Recommendation",
    ".enclosure",
    ".id-Story-timestamp",
    ".id-Story-authors",
    ".id-Story-interactionBar",
    "[class*='FollowButton']",
    ".id-Comments",
    ".id-ClsPrevention",
    "egy-discussion",
    "figcaption",
    "script",
    "style",
    YOUTUBE_IFRAME_KEEP_SELECTOR,
    "noscript",
    "svg",
    ".id-StoryElement-intestitialLink",
    ".id-StoryElement-embed--fanq",
  ],
  firstMatchOnly: true,
}) {
  /**
   * The article headline. `.id-StoryElement-headline` is itself in
   * `selectorsToRemove` (stripped from the extracted body so it isn't
   * duplicated inside the content), so it has to come from the *raw* page,
   * before that removal runs -- same reasoning as heise.ts's override.
   */
  protected override sourceTitleFrom($: cheerio.CheerioAPI): string | null {
    const title = $(".id-StoryElement-headline").first().text().trim();
    return title || null;
  }

  /**
   * Was `extractMainContent()` (not the `...IfPresent()` variant), which
   * silently falls back to `<body>` on a selector miss -- and, when even that
   * came back empty, recursed into `super.extractContent()` for a *second*
   * `<body>` fallback. Both can surface site navigation/chrome as "the
   * article" rather than reporting the miss. Switched to
   * `extractMainContentIfPresent()` (which reports a miss as `null`) feeding
   * the shared three-tier ladder every `FullWebsiteAggregator` subclass now
   * uses -- see `extractContentWithFallback()` in ../website. This is the one
   * genuine behaviour change in that unification: a selector miss here now
   * degrades to a generic-content guess or the RSS summary, never to `<body>`.
   */
  override extractContent(html: string, article: RawArticle): string {
    const extracted = extractMainContentIfPresent(
      html,
      this.getContentSelectors(),
      this.getIgnoreSelectors(),
      this.usesFirstContentMatch,
    );

    return this.extractContentWithFallback(html, article, extracted);
  }

  override async processContent(html: string, article: RawArticle): Promise<string> {
    const options = (this.feed.options as Record<string, unknown> | null) || {};
    const removeEmpty = options.remove_empty_elements !== false;

    const $ = cheerio.load(html);

    if (removeEmpty) {
      removeEmptyElements($, ["p", "div", "span"]);
    }

    const labels = await this.chromeLabels();
    await proxyYoutubeEmbeds($, labels);

    sanitizeHtmlAttributes($);

    removeSanitizedAttributes($);

    trimEdgeWhitespace($, "p, h1, h2, h3, h4, h5, h6, li");

    return super.processContent($.html(), article);
  }
}
