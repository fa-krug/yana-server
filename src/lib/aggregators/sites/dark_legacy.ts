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

export class DarkLegacyAggregator extends FullWebsiteAggregator {
  static brandSiteUrl = "https://darklegacycomics.com/";

  static getDefaultIdentifier(): string {
    return "https://darklegacycomics.com/feed.xml";
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

  static contentSelectors = ["#gallery"];
  protected contentSelectors = [...DarkLegacyAggregator.contentSelectors];

  static selectorsToRemove = ["script", "style", "iframe", "noscript"];
  protected selectorsToRemove = [...DarkLegacyAggregator.selectorsToRemove];

  usesFirstContentMatch = true;

  constructor(feed: FeedLike) {
    super(feed);
    if (!this.identifier) {
      this.identifier = "https://darklegacycomics.com/feed.xml";
    }
  }

  override getSourceUrl(): string {
    return "https://darklegacycomics.com";
  }

  override async extractHeaderElement(_article: RawArticle): Promise<HeaderElementData | null> {
    return null;
  }

  override processContent(htmlContent: string, article: RawArticle): string {
    const options = (this.feed.options as Record<string, unknown> | null) || {};
    const showAltText = options.show_alt_text !== false;

    const $ = cheerio.load(htmlContent);
    const $images = $("img");

    let newHtml = htmlContent;

    if ($images.length > 0) {
      let htmlBuilder = "<div>";
      $images.each((_, imgEl) => {
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
          imgSrc = storeImageRefFromUrlSync(src) || src;
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
      });
      htmlBuilder += "</div>";
      newHtml = htmlBuilder;
    }

    return super.processContent(newHtml, article);
  }
}
