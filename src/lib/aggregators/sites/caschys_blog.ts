import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { FeedLike, RawArticle } from "../base";
import { FullWebsiteAggregator } from "../website";

export class CaschysBlogAggregator extends FullWebsiteAggregator {
  static brandSiteUrl = "https://stadt-bremerhaven.de/";

  static getDefaultIdentifier(): string {
    return "https://stadt-bremerhaven.de/feed/";
  }

  static getIdentifierChoices(): Array<[string, string]> {
    return [["https://stadt-bremerhaven.de/feed/", "Caschy's Blog (Main Feed)"]];
  }

  static getConfigurationFields(): Record<string, unknown> {
    return {
      skip_ads: {
        type: "boolean",
        initial: true,
        label: "Skip Advertisements",
        help_text: "Filter out articles marked as '(Anzeige)'.",
        required: false,
      },
    };
  }

  static contentSelectors = [".entry-inner"];
  protected contentSelectors = [...CaschysBlogAggregator.contentSelectors];

  static selectorsToRemove = [".aawp", ".aawp-disclaimer", "script", "style", "noscript", "svg"];
  protected selectorsToRemove = [...CaschysBlogAggregator.selectorsToRemove];

  usesFirstContentMatch = true;

  constructor(feed: FeedLike) {
    super(feed);
    if (!this.identifier) {
      this.identifier = "https://stadt-bremerhaven.de/feed/";
    }
  }

  override getSourceUrl(): string {
    return "https://stadt-bremerhaven.de";
  }

  override async filterArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    const filtered = await super.filterArticles(articles);
    const options = (this.feed.options as Record<string, unknown> | null) || {};
    const skipAds = options.skip_ads !== false;

    const result: RawArticle[] = [];
    for (const article of filtered) {
      const name = article.name || "";

      if (skipAds && name.includes("(Anzeige)")) {
        continue;
      }

      if (name.includes("Immer wieder sonntags KW")) {
        continue;
      }

      result.push(article);
    }
    return result;
  }

  override processContent(html: string, article: RawArticle): Promise<string> {
    const $ = cheerio.load(html);
    const baseUrl = article.identifier;

    // Filter iframes (only allow YouTube and Twitter/X)
    $("iframe").each((_, iframe) => {
      const $iframe = $(iframe);
      const src = $iframe.attr("src") || "";
      if (!src) {
        $iframe.remove();
        return;
      }

      const isYoutube = src.includes("youtube.com") || src.includes("youtu.be");
      const isTwitter = src.includes("twitter.com") || src.includes("x.com");

      if (!isYoutube && !isTwitter) {
        $iframe.remove();
      }
    });

    // Resolve relative URLs for images
    $("img").each((_, img) => {
      const $img = $(img);
      const src = $img.attr("src");
      if (
        src &&
        !src.startsWith("http://") &&
        !src.startsWith("https://") &&
        !src.startsWith("data:")
      ) {
        try {
          $img.attr("src", new URL(src, baseUrl).toString());
        } catch {
          // ignore invalid URLs
        }
      }
    });

    // Resolve relative URLs for links
    $("a").each((_, a) => {
      const $a = $(a);
      const href = $a.attr("href");
      if (
        href &&
        !href.startsWith("http://") &&
        !href.startsWith("https://") &&
        !href.startsWith("mailto:") &&
        !href.startsWith("tel:") &&
        !href.startsWith("#")
      ) {
        try {
          $a.attr("href", new URL(href, baseUrl).toString());
        } catch {
          // ignore invalid URLs
        }
      }
    });

    // Remove first image if we have a header image (avoid duplication)
    if (article.header_data) {
      let $container = ($("body").length > 0 ? $("body") : $("html")) as cheerio.Cheerio<Element>;
      const topLevelTags = $container.children().toArray();
      if (topLevelTags.length === 1) {
        $container = $(topLevelTags[0]);
      }

      const containerNodes = $container.contents().toArray();
      for (const element of containerNodes) {
        if (element.type === "text") {
          const text = (element as unknown as { data?: string }).data || "";
          if (text.trim()) {
            break;
          }
          continue;
        }

        if (element.type !== "tag") {
          continue;
        }

        const tagName = element.tagName.toLowerCase();

        if (tagName === "img") {
          $(element).remove();
          break;
        }

        if (tagName === "p") {
          let foundImage = false;
          const pChildren = $(element).contents().toArray();
          for (const pChild of pChildren) {
            if (pChild.type === "text") {
              const pText = (pChild as unknown as { data?: string }).data || "";
              if (pText.trim()) {
                break;
              }
              continue;
            }

            if (pChild.type !== "tag") {
              continue;
            }

            const pChildTag = pChild.tagName.toLowerCase();

            if (pChildTag === "img") {
              $(pChild).remove();
              foundImage = true;
              break;
            }

            if (pChildTag === "a") {
              const hasImg = $(pChild).children("img").length > 0;
              if (hasImg) {
                $(pChild).remove();
                foundImage = true;
                break;
              }
            }

            if (pChildTag === "br") {
              continue;
            }

            break;
          }

          if (foundImage) {
            // Clean up leading <br> and leading whitespace from the paragraph after image removal
            while (true) {
              const remaining = $(element).contents().toArray();
              if (remaining.length === 0) break;
              const firstChild = remaining[0];
              if (firstChild.type === "tag" && firstChild.tagName.toLowerCase() === "br") {
                $(firstChild).remove();
              } else if (firstChild.type === "text") {
                const nodeData = (firstChild as unknown as { data?: string }).data || "";
                if (!nodeData.trim()) {
                  $(firstChild).remove();
                } else {
                  $(firstChild).replaceWith(nodeData.replace(/^\s+/, ""));
                  break;
                }
              } else {
                break;
              }
            }
            break;
          }
        }

        break;
      }
    }

    // Clean up leading and trailing whitespace in all paragraphs
    $("p").each((_, p) => {
      const contents = $(p).contents();
      const first = contents.first();
      if (first.length > 0 && first.get(0)?.type === "text") {
        const text = first.text();
        if (/^\s+/.test(text)) {
          first.replaceWith(text.replace(/^\s+/, ""));
        }
      }
      const updatedContents = $(p).contents();
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
