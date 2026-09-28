import * as cheerio from "cheerio";
import type { Element } from "domhandler";

/**
 * Extract content from Tagesschau article using textabsatz paragraphs.
 *
 * Ported from old/core/aggregators/tagesschau/content_extraction.py. `trenner`
 * is that legacy heading class, kept for backward compatibility; current
 * tagesschau.de/sportschau.de pages mark section headings `meldung__subhead`
 * instead. Classless `<h2>`s ("Mehr zum Thema", "Top-Themen") are navigation
 * and intentionally excluded.
 */
export function extractTagesschauContent(html: string): string {
  const $ = cheerio.load(html);
  if (isBr24Page($)) {
    return extractBr24Content($);
  }
  const $root = cheerio.load('<div data-sanitized-class="article-content"></div>');
  const $contentDiv = $root("div");
  const headingClasses = ["trenner", "meldung__subhead"];

  // Find all paragraphs and headings
  $("p, h2").each((_, el) => {
    if (shouldSkipElement($, el)) {
      return;
    }

    const tagName = el.tagName ? el.tagName.toLowerCase() : "";
    const classAttr = $(el).attr("class") || "";
    const classes = classAttr.split(/\s+/).filter(Boolean);

    if (tagName === "p" && classes.some((c) => c.includes("textabsatz"))) {
      const innerHtml = $(el).html() || "";
      const $pNew = $root("<p></p>");
      $pNew.html(innerHtml);
      $contentDiv.append($pNew);
    } else if (
      tagName === "h2" &&
      classes.some((c) => headingClasses.some((hc) => c.includes(hc)))
    ) {
      const text = $(el).text().trim();
      const $h2New = $root("<h2></h2>");
      $h2New.text(text);
      $contentDiv.append($h2New);
    }
  });

  return $root.html($contentDiv) || "";
}

function shouldSkipElement($: cheerio.CheerioAPI, el: Element): boolean {
  const skipClasses = ["teaser", "bigfive", "accordion", "related"];
  const $parents = $(el).parents();

  for (let i = 0; i < $parents.length; i++) {
    const parentClass = $($parents[i]).attr("class");
    if (parentClass) {
      const classes = parentClass.split(/\s+/).filter(Boolean);
      for (const c of classes) {
        for (const sc of skipClasses) {
          if (c.includes(sc)) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Tagesschau's feed lists regional stories that live on a partner broadcaster's
 * site, and the `tagesschau.de` link answers with a redirect there -- e.g.
 * `/inland/oktoberfest-unfall-104.html` lands on a `br.de/nachrichten/...`
 * page. Such a page has no `textabsatz` paragraph at all, so the Tagesschau
 * extraction came back empty and the generic fallback took over, which on a
 * BR24 page picks up the hero image's "Bild" label, its caption, the
 * "Bildrechte" credit and the "Schlagwörter" tag list instead of the article.
 *
 * BR24 is a Next.js app whose class names are CSS-module hashes
 * (`RichText-module-scss-module__ZDJi6a__richText`), so everything here
 * matches on the stable module-name prefix, never on the hash.
 */
const BR24_BODY = 'section[class*="ArticleBody-module"]';
const BR24_RICH_TEXT = `${BR24_BODY} [class*="RichText-module"]`;
const BR24_TEASER_TEXT = '[class*="ArticleModuleTeaser-module"] p[class*="ArticleItemTeaserText"]';

export function isBr24Page($: cheerio.CheerioAPI): boolean {
  return $(BR24_RICH_TEXT).length > 0;
}

/** Cross-links BR24 drops into the body as one-item lists ("Zum Artikel: ..."). */
const BR24_CROSS_LINK =
  /^(Direkt zum aktuellen Artikel|Zum Artikel|Zum Video|Zum Audio|Zum Liveticker)\b/i;

/** Site-wide promotions appended to every article as ordinary rich text. */
const BR24_BOILERPLATE = [
  /Europäische Perspektive bei BR24/i,
  /BR24 Newsletter/i,
  /BR24 ist auch auf/i,
];

function extractBr24Content($: cheerio.CheerioAPI): string {
  const $root = cheerio.load('<div data-sanitized-class="article-content"></div>');
  const $contentDiv = $root("div");

  const teaser = $(BR24_TEASER_TEXT).first().text().trim();
  if (teaser) {
    $contentDiv.append($root("<p></p>").text(teaser));
  }

  $(BR24_RICH_TEXT).each((_, richText) => {
    const $blocks = $(richText).children();
    // A rich-text module holding nothing but a heading is the label of the
    // video/audio module that follows it ("Video: ..."), which is not carried
    // over -- keeping the label would leave a heading over nothing.
    if ($blocks.length > 0 && $blocks.toArray().every((el) => /^h[2-6]$/i.test(el.tagName))) {
      return;
    }

    $blocks.each((_, block) => {
      const $block = $(block);
      const tag = block.tagName.toLowerCase();
      const text = $block.text().trim();
      if (!text) return;
      if (BR24_BOILERPLATE.some((re) => re.test(text))) return;

      if (tag === "ul" || tag === "ol") {
        const items = $block.children("li").toArray();
        if (items.length > 0 && items.every((li) => BR24_CROSS_LINK.test($(li).text().trim()))) {
          return;
        }
      }

      if (/^h[2-6]$/.test(tag)) {
        $contentDiv.append($root(`<${tag}></${tag}>`).text(text));
      } else if (["p", "ul", "ol", "blockquote"].includes(tag)) {
        $contentDiv.append($root(`<${tag}></${tag}>`).html($block.html() || ""));
      }
    });
  });

  return $root.html($contentDiv) || "";
}
