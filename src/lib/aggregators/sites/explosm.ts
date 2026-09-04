import * as cheerio from "cheerio";
import { RawArticle } from "../base";
import { escapeHtml } from "../extract/format";
import { COMIC_CAPTION_STYLE, resolveComicImageSrc, wantsComicAltText } from "./comic-support";
import { defineSite } from "../define-site";
import { FullWebsiteAggregator } from "../website";

export class ExplosmAggregator extends defineSite(FullWebsiteAggregator, {
  key: "explosm",
  siteUrl: "https://explosm.net",
  content: ["#comic"],
  remove: [
    "script",
    "style",
    "iframe",
    "noscript",
    "aside",
    'div[class*="MainComic__LinkContainer"]',
    'div[class*="MainComic__MetaContainer"]',
    'div[class*="ComicSelector__Container"]',
    'div[class*="ComicShare__Container"]',
    'img[loading~="lazy"]',
  ],
  firstMatchOnly: true,
}) {
  // The comic panel *is* the article's content, not something with a
  // separate header image to fetch -- see BaseAggregator.
  static suppressesHeaderExtraction = true;

  override async processContent(htmlContent: string, article: RawArticle): Promise<string> {
    const showAltText = wantsComicAltText(this.feed);

    const $ = cheerio.load(htmlContent);

    let comicImgSrc = "";
    let comicImgAlt = "";

    $("img").each((_, imgEl) => {
      const $img = $(imgEl);
      const src = ($img.attr("src") || "").trim();
      if (!src || src.startsWith("data:")) return;

      if (src.includes("static.explosm.net")) {
        comicImgSrc = src;
        const alt = $img.attr("alt");
        if (alt !== undefined && alt !== null && alt !== "") {
          comicImgAlt = alt;
        }
        return false;
      }
    });

    let newHtml = htmlContent;
    if (comicImgSrc) {
      // No maxDimensions override here -- explosm's strips are fine under the
      // default 600x600 body-image cap; see comic-support.ts.
      const imgSrc = await resolveComicImageSrc(comicImgSrc);

      let builder = "<div>";
      builder += `<img src="${escapeHtml(imgSrc)}"`;
      if (comicImgAlt) {
        builder += ` alt="${escapeHtml(comicImgAlt)}"`;
      }
      builder += ">";

      if (showAltText && comicImgAlt) {
        builder += `<p style="${COMIC_CAPTION_STYLE} text-align: center;">${escapeHtml(
          comicImgAlt,
        )}</p>`;
      }
      builder += "</div>";

      newHtml = builder;
    }

    return super.processContent(newHtml, article);
  }
}
