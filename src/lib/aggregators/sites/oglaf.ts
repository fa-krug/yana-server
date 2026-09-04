import * as cheerio from "cheerio";
import { RawArticle } from "../base";
import { isSafeUrl } from "../blocks/parser";
import { escapeHtml, formatArticleContent } from "../extract/format";
import { storeImageRefFromUrl } from "../images/store";
import { defineSite } from "../define-site";
import { FullWebsiteAggregator } from "../website";

// A comic panel is the whole article; the default 600x600 body-image cap
// (src/lib/aggregators/images/compression.ts) shrinks Oglaf's ~800-1000px
// strips until the lettering stops being readable. Same ceiling as
// dark_legacy.ts, which is here for the same reason.
const COMIC_MAX_DIMENSIONS = { width: 1600, height: 4800 };

export class OglafAggregator extends defineSite(FullWebsiteAggregator, {
  key: "oglaf",
  siteUrl: "https://www.oglaf.com",
  content: ["div.content"],
  remove: ["#nav", "#tt", ".align", "#ll", "script", "style", "div.clear", "#ad_btm"],
  firstMatchOnly: true,
}) {
  // The comic panel *is* the article's content, not something with a
  // separate header image to fetch -- see BaseAggregator.
  static suppressesHeaderExtraction = true;

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
