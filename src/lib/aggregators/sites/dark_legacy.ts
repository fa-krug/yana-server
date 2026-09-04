import * as cheerio from "cheerio";
import { RawArticle } from "../base";
import { isSafeUrl } from "../blocks/parser";
import { escapeHtml } from "../extract/format";
import { storeImageRefFromUrl } from "../images/store";
import { defineSite } from "../define-site";
import { FullWebsiteAggregator } from "../website";

// Comics here are tall vertical strips; the default 600x600 body-image cap
// (src/lib/aggregators/images/compression.ts) crushes them down to an
// unreadable width. This aggregator alone gets a taller ceiling.
const COMIC_MAX_DIMENSIONS = { width: 1600, height: 4800 };

export class DarkLegacyAggregator extends defineSite(FullWebsiteAggregator, {
  key: "dark_legacy",
  siteUrl: "https://darklegacycomics.com",
  content: ["#gallery"],
  remove: ["script", "style", "iframe", "noscript"],
  firstMatchOnly: true,
}) {
  // The comic panel *is* the article's content, not something with a
  // separate header image to fetch -- see BaseAggregator.
  static suppressesHeaderExtraction = true;

  override async processContent(htmlContent: string, article: RawArticle): Promise<string> {
    const options = (this.feed.options as Record<string, unknown> | null) || {};
    const showAltText = options.show_alt_text !== false;

    const $ = cheerio.load(htmlContent);
    const images = $("img").toArray();

    let newHtml = htmlContent;

    if (images.length > 0) {
      let htmlBuilder = "<div>";
      // A plain for-of, not `.each()`: cheerio's `.each()` callback cannot be
      // awaited, and a comic page can carry more than one image.
      for (const imgEl of images) {
        const $img = $(imgEl);
        let src = ($img.attr("src") || "").trim();
        if (
          src &&
          !src.startsWith("http://") &&
          !src.startsWith("https://") &&
          !src.startsWith("data:")
        ) {
          try {
            src = new URL(src, article.identifier).href;
          } catch {
            // Keep original src if URL resolution fails
          }
        }

        let imgSrc = src;
        if (isSafeUrl(src)) {
          const ref = await storeImageRefFromUrl(src, { maxDimensions: COMIC_MAX_DIMENSIONS });
          imgSrc = ref || src;
        }

        const alt = $img.attr("alt");
        const altText = alt !== undefined && alt !== null && alt !== "" ? alt : "";

        htmlBuilder += `<img src="${escapeHtml(imgSrc)}"`;
        if (altText) {
          htmlBuilder += ` alt="${escapeHtml(altText)}"`;
        }
        htmlBuilder += ">";

        if (showAltText && altText) {
          htmlBuilder += `<p style="font-style: italic; margin-top: 1em; color: #666; text-align: center;">${escapeHtml(altText)}</p>`;
        }
      }
      htmlBuilder += "</div>";
      newHtml = htmlBuilder;
    }

    return super.processContent(newHtml, article);
  }
}
