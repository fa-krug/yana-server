import * as cheerio from "cheerio";
import { RawArticle, FeedLike } from "../base";
import {
  removeEmptyElements,
  sanitizeHtmlAttributes,
  removeSanitizedAttributes,
} from "../extract/clean";
import { extractMainContentIfPresent } from "../extract/content";
import { YOUTUBE_IFRAME_KEEP_SELECTOR } from "../embeds/youtube-url";
import { FullWebsiteAggregator, proxyYoutubeEmbeds } from "../website";

export class MerkurAggregator extends FullWebsiteAggregator {
  static brandSiteUrl = "https://www.merkur.de/";

  static getDefaultIdentifier(): string {
    return "https://www.merkur.de/rssfeed.rdf";
  }

  static getIdentifierChoices(): Array<[string, string]> {
    return [
      ["https://www.merkur.de/rssfeed.rdf", "Main Feed"],
      [
        "https://www.merkur.de/lokales/garmisch-partenkirchen/rssfeed.rdf",
        "Garmisch-Partenkirchen",
      ],
      ["https://www.merkur.de/lokales/wuermtal/rssfeed.rdf", "Würmtal"],
      ["https://www.merkur.de/lokales/starnberg/rssfeed.rdf", "Starnberg"],
      ["https://www.merkur.de/lokales/fuerstenfeldbruck/rssfeed.rdf", "Fürstenfeldbruck"],
      ["https://www.merkur.de/lokales/dachau/rssfeed.rdf", "Dachau"],
      ["https://www.merkur.de/lokales/freising/rssfeed.rdf", "Freising"],
      ["https://www.merkur.de/lokales/erding/rssfeed.rdf", "Erding"],
      ["https://www.merkur.de/lokales/ebersberg/rssfeed.rdf", "Ebersberg"],
      ["https://www.merkur.de/lokales/muenchen/rssfeed.rdf", "München"],
      ["https://www.merkur.de/lokales/muenchen-lk/rssfeed.rdf", "München Landkreis"],
      ["https://www.merkur.de/lokales/holzkirchen/rssfeed.rdf", "Holzkirchen"],
      ["https://www.merkur.de/lokales/miesbach/rssfeed.rdf", "Miesbach"],
      ["https://www.merkur.de/lokales/region-tegernsee/rssfeed.rdf", "Region Tegernsee"],
      ["https://www.merkur.de/lokales/bad-toelz/rssfeed.rdf", "Bad Tölz"],
      ["https://www.merkur.de/lokales/wolfratshausen/rssfeed.rdf", "Wolfratshausen"],
      ["https://www.merkur.de/lokales/weilheim/rssfeed.rdf", "Weilheim"],
      ["https://www.merkur.de/lokales/schongau/rssfeed.rdf", "Schongau"],
    ];
  }

  static getConfigurationFields(): Record<string, unknown> {
    return {
      remove_empty_elements: {
        type: "boolean",
        initial: true,
        label: "Remove Empty Elements",
        help_text: "Cleanup empty paragraphs and divs from the article content.",
        required: false,
      },
    };
  }

  static contentSelectors = [".idjs-Story"];
  protected contentSelectors = [...MerkurAggregator.contentSelectors];

  static selectorsToRemove = [
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
  ];
  protected selectorsToRemove = [...MerkurAggregator.selectorsToRemove];

  usesFirstContentMatch = true;

  constructor(feed: FeedLike) {
    super(feed);
    if (!this.identifier) {
      this.identifier = "https://www.merkur.de/rssfeed.rdf";
    }
  }

  override getSourceUrl(): string {
    return "https://www.merkur.de";
  }

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

    $("p, h1, h2, h3, h4, h5, h6, li").each((_, elem) => {
      const contents = $(elem).contents();
      const first = contents.first();
      if (first.length > 0 && first.get(0)?.type === "text") {
        const text = first.text();
        if (/^\s+/.test(text)) {
          first.replaceWith(text.replace(/^\s+/, ""));
        }
      }
      const updatedContents = $(elem).contents();
      const last = updatedContents.last();
      if (last.length > 0 && last.get(0)?.type === "text") {
        const text = last.text();
        if (/\s+$/.test(text)) {
          last.replaceWith(text.replace(/\s+$/, ""));
        }
      }
    });

    return super.processContent($.html(), article);
  }
}
