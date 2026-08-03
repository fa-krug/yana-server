import crypto from "node:crypto";
import * as cheerio from "cheerio";
import { FeedLike, RawArticle } from "../base";
import { isSafeUrl } from "../blocks/parser";
import { escapeHtml } from "../extract/format";
import { HeaderElementData } from "../header/context";
import { buildImageRef } from "../images/store";
import { FullWebsiteAggregator } from "../website";

export function storeImageRefFromUrlSync(url: string): string | null {
  if (!url || !isSafeUrl(url)) return null;
  const hash = crypto.createHash("sha256").update(url).digest("hex");
  return buildImageRef(hash);
}

export class ExplosmAggregator extends FullWebsiteAggregator {
  static brandSiteUrl = "https://explosm.net/";

  static getDefaultIdentifier(): string {
    return "https://explosm.net/rss.xml";
  }

  static getIdentifierChoices(): Array<[string, string]> {
    return [["https://explosm.net/rss.xml", "Cyanide & Happiness (Main RSS)"]];
  }

  static getConfigurationFields(): Record<string, unknown> {
    return {
      show_alt_text: {
        type: "boolean",
        initial: true,
        label: "Show Alt Text",
        help_text: "Display the comic's alt text below the image.",
        required: false,
      },
    };
  }

  static contentSelectors = ["#comic"];
  protected contentSelectors = [...ExplosmAggregator.contentSelectors];

  static selectorsToRemove = [
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
  ];
  protected selectorsToRemove = [...ExplosmAggregator.selectorsToRemove];

  usesFirstContentMatch = true;

  constructor(feed: FeedLike) {
    super(feed);
    if (!this.identifier) {
      this.identifier = "https://explosm.net/rss.xml";
    }
  }

  override getSourceUrl(): string {
    return "https://explosm.net";
  }

  override async extractHeaderElement(_article: RawArticle): Promise<HeaderElementData | null> {
    return null;
  }

  override processContent(htmlContent: string, article: RawArticle): string | Promise<string> {
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
        imgSrc = storeImageRefFromUrlSync(comicImgSrc) || comicImgSrc;
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
