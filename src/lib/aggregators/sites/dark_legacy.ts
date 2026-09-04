import * as cheerio from "cheerio";
import { RawArticle } from "../base";
import { resolveIfRelative } from "../extract/clean";
import { escapeHtml } from "../extract/format";
import {
  COMIC_CAPTION_STYLE,
  COMIC_MAX_DIMENSIONS,
  resolveComicImageSrc,
  wantsComicAltText,
} from "./comic-support";
import { defineSite } from "../define-site";
import { FullWebsiteAggregator } from "../website";

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
    const showAltText = wantsComicAltText(this.feed);

    const $ = cheerio.load(htmlContent);
    const images = $("img").toArray();

    let newHtml = htmlContent;

    if (images.length > 0) {
      let htmlBuilder = "<div>";
      // A plain for-of, not `.each()`: cheerio's `.each()` callback cannot be
      // awaited, and a comic page can carry more than one image.
      for (const imgEl of images) {
        const $img = $(imgEl);
        const src = resolveIfRelative(($img.attr("src") || "").trim(), article.identifier);
        const imgSrc = await resolveComicImageSrc(src, { maxDimensions: COMIC_MAX_DIMENSIONS });

        const alt = $img.attr("alt");
        const altText = alt !== undefined && alt !== null && alt !== "" ? alt : "";

        htmlBuilder += `<img src="${escapeHtml(imgSrc)}"`;
        if (altText) {
          htmlBuilder += ` alt="${escapeHtml(altText)}"`;
        }
        htmlBuilder += ">";

        if (showAltText && altText) {
          htmlBuilder += `<p style="${COMIC_CAPTION_STYLE} text-align: center;">${escapeHtml(altText)}</p>`;
        }
      }
      htmlBuilder += "</div>";
      newHtml = htmlBuilder;
    }

    return super.processContent(newHtml, article);
  }
}
