import * as cheerio from "cheerio";
import { FeedLike, RawArticle } from "../base";
import { isSafeUrl } from "../blocks/parser";
import { escapeHtml, formatArticleContent } from "../extract/format";
import { HeaderElementData } from "../header/context";
import { storeImageRefFromUrl } from "../images/store";
import { FullWebsiteAggregator } from "../website";

// A comic panel is the whole article; the default 600x600 body-image cap
// (src/lib/aggregators/images/compression.ts) shrinks Oglaf's ~800-1000px
// strips until the lettering stops being readable. Same ceiling as
// dark_legacy.ts, which is here for the same reason.
const COMIC_MAX_DIMENSIONS = { width: 1600, height: 4800 };

export class OglafAggregator extends FullWebsiteAggregator {
  static brandSiteUrl = "https://www.oglaf.com/";

  static getDefaultIdentifier(): string {
    return "https://www.oglaf.com/feeds/rss/";
  }

  static getIdentifierChoices(): Array<[string, string]> {
    return [["https://www.oglaf.com/feeds/rss/", "Oglaf (Main Feed)"]];
  }

  static resolvesFeedUrl(): boolean {
    return false;
  }

  static getConfigurationFields(): Record<string, unknown> {
    return {
      show_alt_text: {
        type: "boolean",
        initial: true,
        label: "Show Alt Text",
        help_text:
          "Display the comic's 'title' text (often containing a second joke) below the image.",
        required: false,
      },
    };
  }

  static contentSelectors = ["div.content"];
  protected contentSelectors = [...OglafAggregator.contentSelectors];

  static selectorsToRemove = [
    "#nav",
    "#tt",
    ".align",
    "#ll",
    "script",
    "style",
    "div.clear",
    "#ad_btm",
  ];
  protected selectorsToRemove = [...OglafAggregator.selectorsToRemove];

  usesFirstContentMatch = true;

  constructor(feed: FeedLike) {
    super(feed);
    if (!this.identifier) {
      this.identifier = "https://www.oglaf.com/feeds/rss/";
    }
  }

  override getSourceUrl(): string {
    return "https://www.oglaf.com";
  }

  override async extractHeaderElement(_article: RawArticle): Promise<HeaderElementData | null> {
    return null;
  }

  override async processContent(htmlContent: string, article: RawArticle): Promise<string> {
    const labels = await this.chromeLabels();
    const options = (this.feed.options as Record<string, unknown> | null) || {};
    const showAltText = options.show_alt_text !== false;

    const $ = cheerio.load(htmlContent);

    let $comicImg = $("#strip").first();
    if (!$comicImg.length) {
      $comicImg = $(".content img, #content img, .comic img").first();
    }

    let newHtml: string;

    if ($comicImg.length > 0) {
      let imgUrl = ($comicImg.attr("src") || "").trim();
      if (imgUrl.startsWith("/")) {
        imgUrl = "https://www.oglaf.com" + imgUrl;
      } else if (!imgUrl.startsWith("http") && !imgUrl.includes("media.oglaf.com")) {
        imgUrl = "https://media.oglaf.com/comic/" + imgUrl;
      }

      const altAttr = $comicImg.attr("alt");
      const altText = escapeHtml(
        altAttr !== undefined && altAttr !== null && altAttr !== "" ? altAttr : "Oglaf comic",
      );
      const titleAttr = $comicImg.attr("title");
      const jokeText =
        titleAttr !== undefined && titleAttr !== null && titleAttr !== "None"
          ? escapeHtml(titleAttr)
          : "";

      let imgSrc: string | null = null;
      if (isSafeUrl(imgUrl)) {
        const ref = await storeImageRefFromUrl(imgUrl, { maxDimensions: COMIC_MAX_DIMENSIONS });
        imgSrc = escapeHtml(ref || imgUrl);
      }

      newHtml = '<figure style="text-align: center;">';
      if (imgSrc) {
        newHtml += `<img src="${imgSrc}" alt="${altText}" style="max-width: 100%; height: auto;">`;
      }
      if (showAltText && jokeText) {
        newHtml += `<figcaption style="font-style: italic; margin-top: 1em; color: #666;">${jokeText}</figcaption>`;
      }
      newHtml += "</figure>";
    } else {
      newHtml = htmlContent;
    }

    return formatArticleContent(newHtml, article.name, article.identifier, labels);
  }
}
