import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { RawArticle } from "../../base";
import type { ChromeLabels } from "../../chrome-labels";
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
  labels: ChromeLabels,
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

    const facadeHtml = buildDailymotionFacadeHtml(videoId, labels);
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
export async function extractMeinMmoContent(
  html: string,
  _article: RawArticle,
  selectorsToRemove: string[],
  labels: ChromeLabels,
): Promise<string> {
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
  processDailymotionBlocks($content, $, labels);

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
  await processEmbeds($content, $, labels);
  // Body `<img>` src values -- including any embedded by processEmbeds above,
  // e.g. a Bluesky post's images -- are resolved to real yana-img:// references
  // in MeinMmoAggregator.processContent() -- that step does a real fetch, and
  // runs one stage later, on this function's returned HTML.

  // Remove empty paragraphs and divs
  removeEmptyElements($, ["p", "div"]);

  // Clean data attributes (keep data-src/data-srcset for lazy loading, and
  // data-sanitized-class since embed processors set it directly on wrapper
  // elements rather than via a `class` attribute, so it must survive this
  // strip step to still be present when sanitizeClassNames() runs below).
  //
  // Keeping "data-sanitized-class" is a deliberate divergence from the Python
  // origin, not a parity fix: old/core/aggregators/mein_mmo/content_extraction.py:101
  // is `clean_data_attributes(content, keep=["data-src", "data-srcset"])` --
  // Django does NOT keep this attribute, so Django's own output strips it too,
  // matching the behavior this TS code had before this fix. The divergence is
  // worth it because without it, YouTube/Dailymotion/Bluesky wrapper divs lose
  // the marker before src/lib/aggregators/blocks/parser.ts's embedFacade() runs,
  // so it can no longer recognize the youtube-embed/dailymotion-embed/
  // bluesky-embed wrapper and the figure silently degrades to a plain
  // paragraph-with-link instead of a typed EmbedBlock.
  cleanDataAttributes($, ["data-src", "data-srcset", "data-sanitized-class"]);

  // Sanitize class names
  sanitizeClassNames($);

  return $.html($content);
}
