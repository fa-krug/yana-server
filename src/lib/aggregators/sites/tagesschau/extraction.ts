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
