import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { RawArticle } from "../../base";
import {
  cleanDataAttributes,
  removeEmptyElements,
  removeSelectors,
  sanitizeClassNames,
} from "../../extract/clean";
import { buildDailymotionFacadeHtml } from "../../extract/format";
import { processEmbeds } from "./embeds";

/**
 * Convert div.wp-block-mmo-video blocks to click-through Dailymotion facades.
 */
export function processDailymotionBlocks(
  $content: cheerio.Cheerio<Element>,
  $: cheerio.CheerioAPI,
): void {
  const videoBlocks = $content.find("div.wp-block-mmo-video");
  if (videoBlocks.length === 0) return;

  videoBlocks.each((_, block) => {
    const $block = $(block);
    let videoId: string | null = null;
    $block.find("script").each((_, script) => {
      const scriptText = $(script).text() || "";
      const match = scriptText.match(/dmVideoId:\s*'([^']+)'/);
      if (match) {
        videoId = match[1]!;
      }
    });

    if (!videoId) return;

    const titleDiv = $block.find("div.title").first();
    const title = titleDiv.length > 0 ? titleDiv.text().trim() : "";

    const facadeHtml = buildDailymotionFacadeHtml(videoId);
    const $facade = $(facadeHtml);
    const $wrapper = $("<div>").addClass("dailymotion-embed-container");
    const dataEmbed = $facade.attr("data-embed");
    if (dataEmbed) {
      $wrapper.attr("data-embed", dataEmbed);
    }
    $wrapper.append($facade.contents());

    if (title) {
      $wrapper.append($("<p>").text(title));
    }

    $block.replaceWith($wrapper);
  });
}

/**
 * Extract and process Mein-MMO specific content.
 *
 * Steps:
 * 1. Parse HTML
 * 2. Find all content divs (multi-page support)
 * 3. Combine content from multiple pages
 * 4. Remove unwanted elements
 * 5. Process embeds (YouTube, Twitter, Reddit, Bluesky)
 * 6. Remove empty elements
 * 7. Clean data attributes
 * 8. Sanitize class names
 */
export function extractMeinMmoContent(
  html: string,
  _article: RawArticle,
  selectorsToRemove: string[],
): string {
  const $ = cheerio.load(html);

  const contentDivs = $("div.entry-content, div.gp-entry-content");
  if (contentDivs.length === 0) {
    return html;
  }

  let $content: cheerio.Cheerio<Element>;
  if (contentDivs.length > 1) {
    const $wrapper = ($("<div>") as cheerio.Cheerio<Element>).addClass("entry-content");
    contentDivs.each((_, div) => {
      $wrapper.append($(div).contents());
    });
    $content = $wrapper;
  } else {
    $content = contentDivs.first();
  }

  // Convert Dailymotion video blocks before removal
  processDailymotionBlocks($content, $);

  // Remove unwanted elements
  removeSelectors($content, selectorsToRemove);

  // Remove pagination markers like "Weiter geht es auf Seite 2."
  $content.find("em").each((_, em) => {
    const text = $(em).text();
    if (text && text.includes("Weiter geht es auf Seite")) {
      const $p = $(em).closest("p");
      if ($p.length > 0) {
        $p.remove();
      } else {
        $(em).remove();
      }
    }
  });

  // Process embeds (YouTube, Twitter, Reddit, Bluesky, TikTok, YouTubeFallback)
  processEmbeds($content, $);
  // Body `<img>` src values are resolved to real yana-img:// references in
  // MeinMmoAggregator.processContent() -- that step is async (a real fetch),
  // and this function runs inside the synchronous extractContent().

  // Remove empty paragraphs and divs
  removeEmptyElements($, ["p", "div"]);

  // Clean data attributes (keep data-src and data-srcset for lazy loading)
  cleanDataAttributes($, ["data-src", "data-srcset"]);

  // Sanitize class names
  sanitizeClassNames($);

  return $.html($content);
}
