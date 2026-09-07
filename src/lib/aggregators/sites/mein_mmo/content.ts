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
import { localizeThumbnail } from "../../embeds/dailymotion";
import { buildDailymotionFacadeHtml } from "../../extract/format";
import { storeImageRefFromUrl } from "../../images/store";
import { processEmbeds } from "./embeds";

/** Pull the URL out of a `background-image: url(...)` declaration. */
const BACKGROUND_IMAGE_URL = /background-image:\s*url\(\s*['"]?\s*(https?:\/\/[^'")\s]+)/i;

/**
 * The content-container selectors this module matches against, below --
 * the one place this pair is declared. `extractMeinMmoContent()` hardcodes
 * these and never reads a feed's `content_selectors` override, so every
 * other place in this site's aggregator that needs to agree with it (the
 * multi-page combine step in `../multipage.ts`, and `aggregator.ts`'s
 * pagination-detection scan) imports this constant rather than restating
 * the literal -- a copy that drifted from this one would make those steps
 * disagree with what extraction actually recognises.
 */
export const MEIN_MMO_CONTENT_SELECTORS = ["div.entry-content", "div.gp-entry-content"];

/**
 * The poster Mein-MMO's own player shows before playback -- carried as an
 * inline `background-image` on the block's `div.thumbnail` (and, identically,
 * on its `div.video-player`) rather than as an `<img>`.
 *
 * Preferred over Dailymotion's `/thumbnail/video/<id>`, which is a frame grab:
 * whatever happened to be on screen at that moment, subtitles burnt in and
 * all. The article's editors picked this one.
 */
function posterUrlFrom($block: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI): string | null {
  for (const el of $block.find("[style*='background-image']").toArray()) {
    const match = BACKGROUND_IMAGE_URL.exec($(el).attr("style") || "");
    if (match) return match[1]!;
  }
  return null;
}

/**
 * Handle the `div.wp-block-mmo-video` blocks Mein-MMO's CMS drops into an
 * article body.
 *
 * These are not authored content: the block carries `hasAdvertising: true`,
 * `videoAutoplayCms: true` and `section_name: 'articledetail-incontent'`, and
 * the video it plays is picked by the CMS -- frequently one with nothing to do
 * with the text it is sitting in. So `includeVideos` defaults to off in
 * `MeinMmoAggregator`'s configuration and the whole block is dropped; switched
 * on, each becomes a click-through Dailymotion facade as before.
 *
 * Author-inserted Gutenberg Dailymotion embeds (`wp-block-embed-dailymotion`,
 * `is-provider-dailymotion`) are a different thing entirely and are untouched
 * by this option -- `src/lib/aggregators/embeds/dailymotion.ts` handles those,
 * and they really are part of the article.
 */
export async function processDailymotionBlocks(
  $content: cheerio.Cheerio<Element>,
  $: cheerio.CheerioAPI,
  labels: ChromeLabels,
  includeVideos: boolean,
): Promise<void> {
  const videoBlocks = $content.find("div.wp-block-mmo-video").toArray();
  if (videoBlocks.length === 0) return;

  if (!includeVideos) {
    // Removed here rather than via `selectorsToRemove` so the thumbnail fetch
    // below is skipped too -- one avoidable request per article, per run.
    for (const block of videoBlocks) {
      $(block).remove();
    }
    return;
  }

  for (const block of videoBlocks) {
    const $block = $(block);
    let videoId: string | null = null;
    $block.find("script").each((_, script) => {
      const scriptText = $(script).text() || "";
      const match = scriptText.match(/dmVideoId:\s*'([^']+)'/);
      if (match) {
        videoId = match[1]!;
      }
    });

    if (!videoId) continue;

    // `.title`, not `div.title`: the CMS emits the caption as
    // `<figcaption class="title">`, so the narrower selector this ported from
    // matched nothing and every kept video lost its caption silently.
    const titleEl = $block.find(".title").first();
    const title = titleEl.length > 0 ? titleEl.text().trim() : "";

    const posterUrl = posterUrlFrom($block, $);
    const thumbnailRef =
      (posterUrl ? await storeImageRefFromUrl(posterUrl, { isHeader: true }) : null) ??
      (await localizeThumbnail(videoId));
    const facadeHtml = buildDailymotionFacadeHtml(videoId, labels, thumbnailRef);
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
  }
}

/**
 * Extract and process Mein-MMO specific content.
 *
 * Steps:
 * 1. Parse HTML
 * 2. Find all content divs (multi-page support)
 * 3. Combine content from multiple pages
 * 4. Drop or convert the CMS's auto-inserted video blocks
 * 5. Remove unwanted elements
 * 6. Process embeds (YouTube, Twitter, Reddit, Bluesky)
 * 7. Remove empty elements
 * 8. Clean data attributes
 * 9. Sanitize class names
 *
 * `includeVideos` is the feed's `include_videos` option -- see
 * processDailymotionBlocks() above for what it decides and why it is off by
 * default. It is a required parameter rather than one defaulting to `false`
 * so a new call site has to answer it.
 */
export async function extractMeinMmoContent(
  html: string,
  _article: RawArticle,
  selectorsToRemove: string[],
  labels: ChromeLabels,
  includeVideos: boolean,
): Promise<string> {
  const $ = cheerio.load(html);

  const contentDivs = $(MEIN_MMO_CONTENT_SELECTORS.join(", ")) as cheerio.Cheerio<Element>;
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

  // Drop (or convert) the CMS video blocks before removal
  await processDailymotionBlocks($content, $, labels, includeVideos);

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
