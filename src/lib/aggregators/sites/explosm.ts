import * as cheerio from "cheerio";
import { RawArticle } from "../base";
import { isSafeUrl } from "../blocks/parser";
import { escapeHtml } from "../extract/format";
import { storeImageRefFromUrl } from "../images/store";
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
    const options = (this.feed.options as Record<string, unknown> | null) || {};
    const showAltText = options.show_alt_text !== false;

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
      let imgSrc = comicImgSrc;
      if (isSafeUrl(comicImgSrc)) {
        const ref = await storeImageRefFromUrl(comicImgSrc);
        imgSrc = ref || comicImgSrc;
      }

      let builder = "<div>";
      builder += `<img src="${escapeHtml(imgSrc)}"`;
      if (comicImgAlt) {
        builder += ` alt="${escapeHtml(comicImgAlt)}"`;
      }
      builder += ">";

      if (showAltText && comicImgAlt) {
        builder += `<p style="font-style: italic; margin-top: 1em; color: #666; text-align: center;">${escapeHtml(
          comicImgAlt,
        )}</p>`;
      }
      builder += "</div>";

      newHtml = builder;
    }

    return super.processContent(newHtml, article);
  }
}
