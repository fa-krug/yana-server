import * as cheerio from "cheerio";
import type { Element } from "domhandler";

type SoupOrSelection = cheerio.CheerioAPI | cheerio.Cheerio<Element>;

function getWrapper(soup: SoupOrSelection) {
  return (node: Element) => {
    if (typeof soup === "function") {
      return soup(node);
    }
    return (soup as any).constructor(
      node,
      (soup as any)._root,
      (soup as any)._options
    ) as cheerio.Cheerio<Element>;
  };
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
 * Remove data attributes except those in the keep list.
 */
export function cleanDataAttributes(
  soup: SoupOrSelection,
  keep: string[] = ["data-src", "data-srcset"]
): void {
  const keepSet = new Set(keep);
  const elems = typeof soup === "function" ? soup("*") : soup.find("*").addBack("*");
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
      elem.attribs["src"] ||
      elem.attribs["data-src"] ||
      elem.attribs["data-lazy-src"] ||
      "";

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
  const elems = typeof soup === "function" ? soup("*") : soup.find("*").addBack("*");
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

  const elems = typeof soup === "function" ? soup("*") : soup.find("*").addBack("*");
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
  const elems = typeof soup === "function" ? soup("*") : soup.find("*").addBack("*");
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
