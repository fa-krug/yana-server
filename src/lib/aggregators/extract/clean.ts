import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { isSafeUrl } from "../blocks/parser";

type SoupOrSelection = cheerio.CheerioAPI | cheerio.Cheerio<Element>;

function getWrapper(soup: SoupOrSelection) {
  return (node: Element) => {
    if (typeof soup === "function") {
      return soup(node);
    }
    const internal = soup as unknown as {
      constructor: (node: Element, root?: unknown, options?: unknown) => cheerio.Cheerio<Element>;
      _root?: unknown;
      _options?: unknown;
    };
    return internal.constructor(node, internal._root, internal._options);
  };
}

/**
 * Select every element in `soup`, including the selection's own elements
 * when `soup` is already a `Cheerio<Element>` rather than the whole document.
 * `soup("*")` on the root `CheerioAPI` already reaches every element in the
 * document; `soup.find("*")` on a narrower selection only reaches
 * descendants, so `.addBack("*")` is what folds the selection's own elements
 * back in. Was written out at four call sites (`cleanDataAttributes`,
 * `sanitizeClassNames`, `sanitizeHtmlAttributes`, `removeSanitizedAttributes`)
 * before being pulled out here.
 */
function selectAllIncludingSelf(soup: SoupOrSelection): cheerio.Cheerio<Element> {
  // "*" only ever matches element nodes, but `CheerioAPI`'s call signature is
  // typed to return `Cheerio<AnyNode>` (it can select comments, text, etc. for
  // other selectors) -- the cast just states what the selector already
  // guarantees, the same narrowing every call site below did by hand before
  // this was extracted.
  return (
    typeof soup === "function" ? soup("*") : soup.find("*").addBack("*")
  ) as cheerio.Cheerio<Element>;
}

/**
 * Extract base filename without extension and without responsive variant suffixes.
 *
 * Handles patterns like:
 * - "image-780x438.jpg" -> "image"
 * - "image-1280x720-1.jpg" -> "image"
 * - "image-1280x720-1-780x438.jpg" -> "image"
 * - "image.jpg" -> "image"
 */
export function getBaseFilename(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  const nameWithoutExt = lastDot !== -1 ? filename.slice(0, lastDot) : filename;

  // Remove all responsive variant suffixes from the end (-NxN or -N)
  let base = nameWithoutExt.replace(/(?:-\d+x\d+|-\d+)*$/, "");

  // Also handle alphanumeric variant suffixes (e.g. Merkur's -1Wef)
  base = base.replace(/-[a-zA-Z0-9]{3,6}$/, "");

  return base;
}

/**
 * Basic HTML sanitization: removes HTML comments.
 */
export function cleanHtml(html: string): string {
  const $ = cheerio.load(html);
  $("*")
    .contents()
    .filter((_, node) => node.type === "comment")
    .remove();
  $.root()
    .contents()
    .filter((_, node) => node.type === "comment")
    .remove();
  return $.html();
}

/**
 * Remove elements matching CSS selectors from soup.
 */
export function removeSelectors(soup: SoupOrSelection, selectors: string[]): void {
  for (const selector of selectors) {
    try {
      if (typeof soup === "function") {
        soup(selector).remove();
      } else {
        soup.find(selector).remove();
      }
    } catch {
      // Ignore invalid CSS selectors
    }
  }
}

/**
 * Remove empty elements (no text and no media elements: img, iframe, video).
 */
export function removeEmptyElements(soup: SoupOrSelection, tags: string[]): void {
  const wrap = getWrapper(soup);
  for (const tagName of tags) {
    const elems = typeof soup === "function" ? soup(tagName) : soup.find(tagName);
    elems.each((_, elem) => {
      if (elem.type === "tag") {
        const $elem = wrap(elem as Element);
        const text = $elem.text().trim();
        const hasMedia = $elem.find("img, iframe, video").length > 0;
        if (!text && !hasMedia) {
          $elem.remove();
        }
      }
    });
  }
}

/**
 * Resolve a possibly-relative URL against `baseUrl`, leaving it untouched
 * when it is already absolute (`http:`, `https:`) or a `data:` URI, or when
 * resolution fails. The single-value primitive behind `absolutizeUrls()`
 * below -- also used directly by `dark_legacy.ts`, which resolves one image
 * `src` at a time rather than walking a whole document.
 */
export function resolveIfRelative(url: string, baseUrl: string): string {
  if (!url || url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) {
    return url;
  }
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

/**
 * Rewrite every relative `img[src]` and `a[href]` in `soup` to an absolute
 * URL against `baseUrl`. `caschys_blog.ts` and `mactechnews/aggregator.ts`
 * both used to carry this verbatim (identical apart from two comments);
 * `dark_legacy.ts` and `heise.ts` use `resolveIfRelative()` above for their
 * own narrower, single-value cases. `a[href]` additionally skips
 * `mailto:`/`tel:`/`#` targets -- none of those want resolving against the
 * page's own URL, and an in-page `#anchor` would otherwise be rewritten into
 * a full URL rather than left as a same-page fragment. `oglaf.ts`'s CDN-path
 * rule for a bare comic filename (not a relative *URL*) is site-specific
 * enough to stay where it is.
 */
export function absolutizeUrls($: cheerio.CheerioAPI, baseUrl: string): void {
  $("img").each((_, img) => {
    const $img = $(img);
    const src = $img.attr("src");
    if (src) {
      $img.attr("src", resolveIfRelative(src, baseUrl));
    }
  });

  $("a").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href");
    if (href && !href.startsWith("mailto:") && !href.startsWith("tel:") && !href.startsWith("#")) {
      $a.attr("href", resolveIfRelative(href, baseUrl));
    }
  });
}

/**
 * Remove data attributes except those in the keep list.
 */
export function cleanDataAttributes(
  soup: SoupOrSelection,
  keep: string[] = ["data-src", "data-srcset"],
): void {
  const keepSet = new Set(keep);
  const elems = selectAllIncludingSelf(soup);
  elems.each((_, elem) => {
    if (elem.type === "tag" && elem.attribs) {
      for (const attr of Object.keys(elem.attribs)) {
        if (attr.startsWith("data-") && !keepSet.has(attr)) {
          delete elem.attribs[attr];
        }
      }
    }
  });
}

/**
 * Remove the first image with the specified URL from the soup.
 *
 * Used to remove header images from the article content after extracting them.
 * Handles exact URL matches, filename matches, and responsive image variants.
 */
export function removeImageByUrl(soup: SoupOrSelection, imageUrl?: string | null): void {
  if (!imageUrl || imageUrl.startsWith("data:")) {
    return;
  }

  const imagePath = imageUrl.includes("/") ? imageUrl.split("/").pop()! : imageUrl;
  const imageBase = getBaseFilename(imagePath);
  const wrap = getWrapper(soup);

  const imgs = typeof soup === "function" ? soup("img") : soup.find("img");

  let removed = false;
  imgs.each((_, elem) => {
    if (removed || elem.type !== "tag" || !elem.attribs) return;

    const imgSrc =
      elem.attribs["src"] || elem.attribs["data-src"] || elem.attribs["data-lazy-src"] || "";

    if (!imgSrc || imgSrc.startsWith("data:")) {
      return;
    }

    // 1. Exact match
    if (imgSrc === imageUrl) {
      wrap(elem as Element).remove();
      removed = true;
      return;
    }

    // 2. Filename/path match
    const imgPath = imgSrc.includes("/") ? imgSrc.split("/").pop()! : imgSrc;
    if (
      imgPath &&
      imgPath === imagePath &&
      imgPath.length > 3 &&
      !["image.jpg", "photo.jpg", "pic.jpg"].includes(imgPath)
    ) {
      wrap(elem as Element).remove();
      removed = true;
      return;
    }

    // 3. Responsive variant match
    const imgBase = getBaseFilename(imgPath);
    if (
      imgBase &&
      imgBase === imageBase &&
      imgBase.length > 3 &&
      !["image", "photo", "pic"].includes(imgBase)
    ) {
      wrap(elem as Element).remove();
      removed = true;
      return;
    }
  });
}

/**
 * Convert all class attributes to data-sanitized-class attributes.
 */
export function sanitizeClassNames(soup: SoupOrSelection): void {
  const elems = selectAllIncludingSelf(soup);
  elems.each((_, elem) => {
    if (elem.type === "tag" && elem.attribs && "class" in elem.attribs) {
      elem.attribs["data-sanitized-class"] = elem.attribs["class"];
      delete elem.attribs["class"];
    }
  });
}

/**
 * Sanitize HTML by removing script, object, embed, style, iframe, on* attributes,
 * and converting class, style, id, and other data-* attributes to data-sanitized-*.
 */
export function sanitizeHtmlAttributes(soup: SoupOrSelection): void {
  removeSelectors(soup, ["script", "object", "embed", "style", "iframe"]);

  const elems = selectAllIncludingSelf(soup);
  elems.each((_, elem) => {
    if (elem.type === "tag" && elem.attribs) {
      const attribs = elem.attribs;
      const keys = Object.keys(attribs);

      // Remove on* attributes (XSS prevention)
      for (const attr of keys) {
        if (attr.toLowerCase().startsWith("on")) {
          delete attribs[attr];
        }
      }

      // Convert class → data-sanitized-class
      if ("class" in attribs) {
        attribs["data-sanitized-class"] = attribs["class"];
        delete attribs["class"];
      }

      // Convert style → data-sanitized-style
      if ("style" in attribs) {
        attribs["data-sanitized-style"] = attribs["style"];
        delete attribs["style"];
      }

      // Convert id → data-sanitized-id
      if ("id" in attribs) {
        attribs["data-sanitized-id"] = attribs["id"];
        delete attribs["id"];
      }

      // Convert other data-* attributes → data-sanitized-* (keep data-src and data-srcset)
      const dataAttrsToRename: string[] = [];
      for (const attr of Object.keys(attribs)) {
        if (
          attr.startsWith("data-") &&
          attr !== "data-src" &&
          attr !== "data-srcset" &&
          !attr.startsWith("data-sanitized-")
        ) {
          dataAttrsToRename.push(attr);
        }
      }

      for (const attr of dataAttrsToRename) {
        const value = attribs[attr];
        const newAttr = `data-sanitized-${attr.slice(5)}`;
        attribs[newAttr] = value;
        delete attribs[attr];
      }
    }
  });
}

/**
 * Remove all data-sanitized-* attributes from elements.
 */
export function removeSanitizedAttributes(soup: SoupOrSelection): void {
  const elems = selectAllIncludingSelf(soup);
  elems.each((_, elem) => {
    if (elem.type === "tag" && elem.attribs) {
      for (const attr of Object.keys(elem.attribs)) {
        if (attr.startsWith("data-sanitized-")) {
          delete elem.attribs[attr];
        }
      }
    }
  });
}

/**
 * Sanitize an untrusted HTML fragment -- scraped comment markup, a Reddit
 * post's converted Markdown, a podcast's show notes -- for safe storage and
 * eventual serving by `GET /api/v1/articles/[id]/content`. Strips HTML
 * comments; removes `script`/`object`/`embed`/`style`/`iframe` elements
 * outright; removes every `on*` event-handler attribute; and drops any
 * `href`/`src` whose scheme `isSafeUrl()` does not allow (a `javascript:`
 * link loses its `href` but the anchor and its text survive; an unsafe
 * `<img>` is removed entirely, since there is no safe fallback rendering for
 * an image).
 *
 * `class`/`style`/`id`/`data-*` attributes are first converted to inert
 * `data-sanitized-*` names (`sanitizeHtmlAttributes()`) and then those
 * `data-sanitized-*` attributes are stripped outright
 * (`removeSanitizedAttributes()`) rather than left in place. That two-step
 * dance -- rename, then delete the renamed form -- is deliberate, not
 * redundant: it is what stops an untrusted fragment from forging
 * `class="article-comments"`, the exact marker `formatArticleContent()`
 * wraps the real comments section in and `content-hash.ts`'s
 * `withoutComments()` cuts on by `lastIndexOf`. A comment carrying that
 * literal markup must never survive with the class intact, or it could
 * plant a second marker inside the real wrapper and make `lastIndexOf` find
 * the forged one instead of the real one -- permanently defeating the
 * comment exclusion for that article. See the "comment-forged comments
 * marker" tests in the sites that consume this.
 *
 * This is the one implementation of a sequence that used to be hand-copied,
 * byte-for-byte, into six aggregator site modules (mactechnews, mein_mmo,
 * heise, youtube, reddit, podcast) -- see the 2026-09-03 pipeline-review-3
 * "one HTML sanitizer, not six" task. All six were verified byte-identical
 * over the same fixture before being consolidated here, so nothing here is a
 * behaviour change; a future hardening now protects every call site instead
 * of whichever one it was applied to.
 *
 * Deliberately has no options and no site parameter -- every call site's
 * needs turned out identical, and a parameter that nothing yet uses is a
 * seam for the next difference to drift back through unnoticed.
 */
export function sanitizeUntrustedFragment(html: string): string {
  const $ = cheerio.load(cleanHtml(html));
  sanitizeHtmlAttributes($);
  removeSanitizedAttributes($);

  $("a").each((_, tag) => {
    const href = $(tag).attr("href");
    if (href && !isSafeUrl(href)) {
      $(tag).removeAttr("href");
    }
  });

  $("img").each((_, tag) => {
    const src = $(tag).attr("src");
    if (src && !isSafeUrl(src)) {
      $(tag).remove();
    }
  });

  const body = $("body");
  return body.length > 0 ? body.html() || "" : $.html();
}
