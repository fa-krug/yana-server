import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { RawArticle } from "../base";
import { absolutizeUrls } from "../extract/clean";
import { defineSite } from "../define-site";
import { FullWebsiteAggregator } from "../website";

export class CaschysBlogAggregator extends defineSite(FullWebsiteAggregator, {
  key: "caschys_blog",
  siteUrl: "https://stadt-bremerhaven.de",
  content: [".entry-inner"],
  remove: [".aawp", ".aawp-disclaimer", "script", "style", "noscript", "svg"],
  firstMatchOnly: true,
}) {
  protected override sourceTitleFrom($: cheerio.CheerioAPI): string | null {
    const title = $("h1.entry-title").first().text().trim();
    return title || null;
  }

  /**
   * Only the weekly link-dump digest is site-specific now.
   *
   * The "(Anzeige)" title test that used to live here is the base class's
   * advertising filter -- generalised, still gated on this feed's own
   * `skip_ads` option, and now also reading the publisher's categories, which
   * is what makes it work for feeds that label there instead of in the title.
   * Leaving a copy behind would mean two vocabularies to keep agreed.
   */
  override async filterArticles(
    articles: RawArticle[],
    clock: () => Date = () => new Date(),
  ): Promise<RawArticle[]> {
    const filtered = await super.filterArticles(articles, clock);
    return filtered.filter((article) => !(article.name || "").includes("Immer wieder sonntags KW"));
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

    // Resolve relative image and link URLs
    absolutizeUrls($, baseUrl);

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
