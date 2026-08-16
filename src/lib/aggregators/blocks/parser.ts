import * as cheerio from "cheerio";
import type { AnyNode, Element, Text } from "domhandler";
import type { Block, EmbedBlock, ImageBlock, InlineRun, ListBlock } from "./types";

/**
 * Schemes a stored link is allowed to carry.
 * Allowlisted: http, https, mailto.
 * Relative URLs and scheme-relative URLs (no scheme) are permitted.
 */
const SAFE_URL_SCHEMES = new Set(["http", "https", "mailto"]);
const SCHEME_REGEX = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

const IMAGE_REF_SCHEME = "yana-img://";

const INLINE_TAGS = new Set([
  "a",
  "b",
  "strong",
  "i",
  "em",
  "code",
  "span",
  "mark",
  "u",
  "s",
  "strike",
  "del",
  "sub",
  "sup",
  "small",
  "abbr",
  "cite",
  "q",
  "time",
  "label",
  "font",
  "ins",
  "var",
  "kbd",
]);

const DROPPED_TAGS = new Set([
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "script",
  "style",
  "noscript",
  "iframe",
  "audio",
  "svg",
  "canvas",
]);

const HEADING_TAGS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

const TABLE_CELL_SEPARATOR = " — ";

const YOUTUBE_PATTERNS = [
  /(?:youtube\.com|youtube-nocookie\.com)\/embed\/([A-Za-z0-9_-]{6,})/,
  /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/,
];

const DAILYMOTION_PATTERNS = [/dailymotion\.com\/(?:video|embed\/video)\/([A-Za-z0-9]+)/];

const TWEET_HOST_SUFFIXES = ["twitter.com", "x.com", "fxtwitter.com"];
const CLASS_ATTRS = ["data-sanitized-class", "class"];
const EMBED_MARKUP_ATTRS = [
  "data-sanitized-data-embed-content",
  "data-embed",
  "data-sanitized-embed",
];

/**
 * True if url is safe to render as a clickable link.
 */
export function isSafeUrl(url: string): boolean {
  if (!url) {
    return false;
  }
  const match = SCHEME_REGEX.exec(url);
  if (!match) {
    return true;
  }
  const scheme = match[1].toLowerCase();
  return SAFE_URL_SCHEMES.has(scheme);
}

function resolveUrl(href: string, baseUrl: string): string {
  if (href.startsWith(IMAGE_REF_SCHEME)) {
    return href;
  }
  let resolved = href;
  if (baseUrl) {
    try {
      resolved = new URL(href, baseUrl).toString();
    } catch {
      resolved = href;
    }
  }
  return isSafeUrl(resolved) ? resolved : "";
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ");
}

function makeRun(text: string, styles: Set<string>, link: string): InlineRun {
  return {
    text,
    bold: styles.has("bold"),
    italic: styles.has("italic"),
    code: styles.has("code"),
    strikethrough: styles.has("strikethrough"),
    link,
  };
}

function trimmed(runs: InlineRun[]): InlineRun[] {
  const result = runs.filter((run) => Boolean(run.text));
  while (result.length > 0 && !result[0].text.trim()) {
    result.shift();
  }
  while (result.length > 0 && !result[result.length - 1].text.trim()) {
    result.pop();
  }
  return result;
}

function isNonTextString(node: AnyNode): boolean {
  const t = node.type as string;
  return t === "comment" || t === "directive" || t === "doctype" || t === "cdata";
}

function getAttr(element: Element, attrName: string): string {
  if (!element || !element.attribs) {
    return "";
  }
  return element.attribs[attrName] || element.attribs[attrName.toLowerCase()] || "";
}

function hasDirectContent(tag: Element): boolean {
  const children = tag.children || [];
  for (const child of children) {
    if (child.type === "tag" || Boolean((child as Element).name)) {
      return true;
    }
    if (
      child.type === "text" &&
      !isNonTextString(child) &&
      (child as Text).data.trim().length > 0
    ) {
      return true;
    }
  }
  return false;
}

function selectContainer($: cheerio.CheerioAPI): AnyNode {
  const bodyList = $("body");
  if (bodyList.length > 0) {
    const bodyEl = bodyList.get(0) as Element;
    if (hasDirectContent(bodyEl)) {
      return bodyEl;
    }
  }
  return $.root().get(0) as AnyNode;
}

function imageBlock(img: Element, baseUrl: string): ImageBlock | null {
  const src = getAttr(img, "src") || getAttr(img, "data-src") || getAttr(img, "data-lazy-src");
  if (!src) {
    return null;
  }
  const resolved = resolveUrl(src, baseUrl);
  if (!resolved) {
    return null;
  }
  return {
    kind: "image",
    ref: resolved,
    caption: [],
  };
}

function hasDroppedAncestor(element: Element, scanned: Element): boolean {
  let parent = element.parentNode;
  while (parent && parent !== scanned && parent.type === "tag") {
    const parentEl = parent as Element;
    if (DROPPED_TAGS.has(parentEl.name.toLowerCase())) {
      return true;
    }
    parent = parent.parentNode;
  }
  return false;
}

function recoverableMedia($: cheerio.CheerioAPI, scanned: Element): Element[] {
  const elements = $(scanned).find("img, video").toArray() as Element[];
  return elements.filter((el) => !hasDroppedAncestor(el, scanned));
}

/**
 * An embed's preview image, taken from the element's `poster`.
 *
 * On `<video>` that is the standard attribute. On `<audio>` and `<iframe>` it
 * is not valid HTML and is only ever written by *our own* header builders
 * (`buildHeaderFromStreams`/`buildHeaderFromEmbedCode` in
 * `sites/tagesschau/media.ts`) as a private carrier: an `<audio>` has nowhere
 * standard to hold a preview image, and this HTML is never rendered by a
 * browser -- it exists only to be parsed into blocks here (there is no
 * `articles.content` column; see `db/schema/articles.ts`). Without it a poster
 * had to be emitted as a *sibling* `<img>`, which became a detached image block
 * and left the embed's `thumbnailRef` empty -- a preview image and a bare play
 * button rendered as two unrelated things. (The YouTube facade solves the same
 * problem differently, with a nested `<img>` that `facadeThumbnail()` reads;
 * that shape needs a container class to pair the two, which `poster` does not.)
 *
 * `poster` on a body `<iframe>` is therefore always scraped, attacker-supplied
 * markup, so the scheme is checked. `yana-img://` refs pass through the same
 * way `resolveUrl()` lets them: `isSafeUrl()` only knows http/https/mailto.
 */
function posterRef(element: Element): string {
  const poster = getAttr(element, "poster");
  if (!poster) {
    return "";
  }
  if (poster.startsWith(IMAGE_REF_SCHEME)) {
    return poster;
  }
  return isSafeUrl(poster) ? poster : "";
}

function videoEmbed($: cheerio.CheerioAPI, element: Element): EmbedBlock | null {
  const sourceEl = $(element).find("source").get(0) as Element | undefined;
  let src = sourceEl ? getAttr(sourceEl, "src") : "";
  if (!src) {
    src = getAttr(element, "src");
  }
  if (!src || !isSafeUrl(src)) {
    return null;
  }
  return {
    kind: "embed",
    provider: "video",
    externalUrl: src,
    thumbnailRef: posterRef(element),
    title: "",
  };
}

function audioEmbed($: cheerio.CheerioAPI, element: Element): EmbedBlock | null {
  const sourceEl = $(element).find("source").get(0) as Element | undefined;
  let src = sourceEl ? getAttr(sourceEl, "src") : "";
  if (!src) {
    src = getAttr(element, "src");
  }
  if (!src || !isSafeUrl(src)) {
    return null;
  }
  return {
    kind: "embed",
    provider: "generic",
    externalUrl: src,
    thumbnailRef: posterRef(element),
    title: "",
  };
}

function iframeEmbed(element: Element): EmbedBlock | null {
  const src = getAttr(element, "src");
  if (!src || !isSafeUrl(src)) {
    return null;
  }
  return {
    kind: "embed",
    provider: "generic",
    externalUrl: src,
    thumbnailRef: posterRef(element),
    title: "",
  };
}

function mediaBlock($: cheerio.CheerioAPI, element: Element, baseUrl: string): Block | null {
  const tag = (element.name || "").toLowerCase();
  if (tag === "img") {
    return imageBlock(element, baseUrl);
  }
  if (tag === "video") {
    return videoEmbed($, element);
  }
  return null;
}

function buildListBlock(
  $: cheerio.CheerioAPI,
  element: Element,
  ordered: boolean,
  baseUrl: string,
): ListBlock | null {
  const items: Block[][] = [];
  const children = element.children || [];
  for (const child of children) {
    if (child.type === "tag" && (child as Element).name.toLowerCase() === "li") {
      const itemBlocks = convert($, child as Element, baseUrl);
      if (itemBlocks.length > 0) {
        items.push(itemBlocks);
      }
    }
  }
  if (items.length === 0) {
    return null;
  }
  return {
    kind: "list",
    ordered,
    items,
  };
}

function figureBlocks($: cheerio.CheerioAPI, element: Element, baseUrl: string): Block[] {
  const children = element.children || [];
  let figcaptionEl: Element | null = null;
  for (const child of children) {
    if (child.type === "tag" && (child as Element).name.toLowerCase() === "figcaption") {
      figcaptionEl = child as Element;
      break;
    }
  }

  let caption: InlineRun[] = [];
  if (figcaptionEl !== null) {
    caption = trimmed(inlineRuns($, figcaptionEl, baseUrl));
    $(figcaptionEl).remove();
  }

  const blocks = convert($, element, baseUrl);

  if (caption.length > 0) {
    let claimed = false;
    for (const block of blocks) {
      if (block.kind === "image" && block.caption.length === 0) {
        block.caption = caption;
        claimed = true;
        break;
      }
    }
    if (!claimed) {
      blocks.push({ kind: "paragraph", runs: caption });
    }
  }

  return blocks;
}

function dropImageBlocks(blocks: Block[]): Block[] {
  const kept: Block[] = [];
  for (const block of blocks) {
    if (block.kind === "image") {
      continue;
    }
    if (block.kind === "list") {
      const items: Block[][] = [];
      for (const item of block.items) {
        const filtered = dropImageBlocks(item);
        if (filtered.length > 0) {
          items.push(filtered);
        }
      }
      if (items.length > 0) {
        kept.push({ ...block, items });
      }
      continue;
    }
    if (block.kind === "blockquote") {
      const inner = dropImageBlocks(block.blocks);
      if (inner.length > 0) {
        kept.push({ ...block, blocks: inner });
      }
      continue;
    }
    kept.push(block);
  }
  return kept;
}

/**
 * A `<header>` surviving inside the extracted article body (never the
 * synthetic lead-image header -- see below) is usually decorative chrome: a
 * byline, a date, sometimes a small avatar or site-logo image. Its images are
 * dropped rather than mistaken for the article's own content. `media-header`
 * is the one exception: both `buildHeaderHtml()` in `../extract/format.ts`
 * (the lead image/video every FullWebsiteAggregator-based site builds) and
 * TagesschauAggregator's own convention (`sites/tagesschau/media.ts`) tag
 * their real header with this class, and dropping it here would silently
 * throw away an image the aggregator had already fetched and stored.
 */
function headerBlocks($: cheerio.CheerioAPI, header: Element, baseUrl: string): Block[] {
  const classes = getAttr(header, "class").split(/\s+/).filter(Boolean);
  if (classes.includes("media-header")) {
    // The media-header's own <iframe>/<audio> player is real, already-vetted
    // content the aggregator built on purpose (see the class comment above) --
    // unlike an arbitrary body iframe (ad, tracker, related-content widget),
    // which DROPPED_TAGS is right to keep suppressing everywhere else.
    return convert($, header, baseUrl, true);
  }
  return dropImageBlocks(convert($, header, baseUrl));
}

function tableRowBlocks($: cheerio.CheerioAPI, tr: Element, baseUrl: string): Block[] {
  const cellRuns: InlineRun[][] = [];
  const mediaBlocks: Block[] = [];
  const nestedTables: Element[] = [];

  const children = tr.children || [];
  const cells = children.filter(
    (c) =>
      c.type === "tag" &&
      ((c as Element).name.toLowerCase() === "td" || (c as Element).name.toLowerCase() === "th"),
  ) as Element[];

  for (const cell of cells) {
    const nestedInCell = $(cell).find("table").toArray() as Element[];
    for (const nested of nestedInCell) {
      $(nested).remove();
      nestedTables.push(nested);
    }

    let runs = trimmed(inlineRuns($, cell, baseUrl));
    if (cell.name.toLowerCase() === "th" && runs.length > 0) {
      runs = runs.map((r) => ({ ...r, bold: true }));
    }
    if (runs.length > 0) {
      cellRuns.push(runs);
    }

    for (const media of recoverableMedia($, cell)) {
      const block = mediaBlock($, media, baseUrl);
      if (block !== null) {
        mediaBlocks.push(block);
      }
    }
  }

  const combined: InlineRun[] = [];
  for (let index = 0; index < cellRuns.length; index++) {
    if (index > 0) {
      combined.push(makeRun(TABLE_CELL_SEPARATOR, new Set(), ""));
    }
    combined.push(...cellRuns[index]);
  }

  const blocks: Block[] = [];
  if (combined.length > 0) {
    blocks.push({ kind: "paragraph", runs: combined });
  }
  blocks.push(...mediaBlocks);
  for (const nested of nestedTables) {
    blocks.push(...convert($, nested, baseUrl));
  }
  return blocks;
}

function classNames(element: Element): string {
  const parts: string[] = [];
  for (const attr of CLASS_ATTRS) {
    const val = getAttr(element, attr);
    if (val) {
      parts.push(val);
    }
  }
  return parts.join(" ");
}

function embedMarkup($: cheerio.CheerioAPI, element: Element): string {
  const parts: string[] = [];
  const candidates = [element, ...($(element).find("*").toArray() as Element[])];
  for (const cand of candidates) {
    for (const attr of EMBED_MARKUP_ATTRS) {
      const val = getAttr(cand, attr);
      if (val) {
        parts.push(val);
      }
    }
    const tag = (cand.name || "").toLowerCase();
    if (tag === "iframe") {
      const src = getAttr(cand, "src");
      if (src) parts.push(src);
    }
    if (tag === "a") {
      const href = getAttr(cand, "href");
      if (href) parts.push(href);
    }
  }
  return parts.join(" ");
}

function firstMatch(patterns: RegExp[], text: string): string {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1]) {
      return match[1];
    }
  }
  return "";
}

function facadeThumbnail($: cheerio.CheerioAPI, element: Element): string {
  const img = $(element).find("img").get(0) as Element | undefined;
  return img ? getAttr(img, "src") : "";
}

function embedFacade($: cheerio.CheerioAPI, element: Element): EmbedBlock | null {
  const classes = classNames(element);
  const isYoutube = classes.includes("youtube-embed");
  const isDailymotion = classes.includes("dailymotion-embed");
  if (!isYoutube && !isDailymotion) {
    return null;
  }

  const markup = embedMarkup($, element);
  const thumbnail = facadeThumbnail($, element);

  if (isYoutube) {
    const videoId = firstMatch(YOUTUBE_PATTERNS, markup);
    if (videoId) {
      return {
        kind: "embed",
        provider: "youtube",
        externalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnailRef: thumbnail,
        title: "",
      };
    }
  } else {
    const videoId = firstMatch(DAILYMOTION_PATTERNS, markup);
    if (videoId) {
      return {
        kind: "embed",
        provider: "dailymotion",
        externalUrl: `https://www.dailymotion.com/video/${videoId}`,
        thumbnailRef: thumbnail,
        title: "",
      };
    }
  }
  return null;
}

function tweetEmbed($: cheerio.CheerioAPI, element: Element): EmbedBlock | null {
  const anchors = $(element).find("a[href]").toArray() as Element[];
  for (const anchor of anchors) {
    const href = getAttr(anchor, "href");
    if (!isSafeUrl(href)) {
      continue;
    }
    let host = "";
    try {
      host = new URL(href).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host) {
      continue;
    }
    if (TWEET_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
      const title = $(element).text().replace(/\s+/g, " ").trim();
      return {
        kind: "embed",
        provider: "tweet",
        externalUrl: href,
        thumbnailRef: "",
        title,
      };
    }
  }
  return null;
}

function inlineRuns(
  $: cheerio.CheerioAPI,
  element: Element,
  baseUrl: string,
  styles: Set<string> = new Set(),
  link: string = "",
): InlineRun[] {
  const runs: InlineRun[] = [];
  const children = element.children || [];

  for (const node of children) {
    if (isNonTextString(node)) {
      continue;
    }
    if (node.type === "text") {
      const text = normalize((node as Text).data || "");
      if (text) {
        runs.push(makeRun(text, styles, link));
      }
      continue;
    }
    if (node.type !== "tag" && !(node as Element).name) {
      continue;
    }

    const tag = (node as Element).name.toLowerCase();
    if (DROPPED_TAGS.has(tag)) {
      continue;
    }
    if (tag === "br") {
      runs.push(makeRun("\n", styles, link));
      continue;
    }
    if (tag === "img" || tag === "video") {
      continue;
    }

    const childStyles = new Set(styles);
    let childLink = link;

    switch (tag) {
      case "b":
      case "strong":
        childStyles.add("bold");
        break;
      case "i":
      case "em":
      case "cite":
      case "var":
        childStyles.add("italic");
        break;
      case "code":
      case "kbd":
        childStyles.add("code");
        break;
      case "s":
      case "strike":
      case "del":
        childStyles.add("strikethrough");
        break;
      case "a": {
        const href = getAttr(node as Element, "href");
        if (href) {
          childLink = resolveUrl(href, baseUrl);
        }
        break;
      }
    }

    runs.push(...inlineRuns($, node as Element, baseUrl, childStyles, childLink));
  }
  return runs;
}

function convert(
  $: cheerio.CheerioAPI,
  container: AnyNode,
  baseUrl: string,
  allowMediaEmbeds = false,
): Block[] {
  const blocks: Block[] = [];
  const inline: InlineRun[] = [];
  const pendingMedia: Block[] = [];

  function flush(): void {
    const runs = trimmed(inline);
    if (runs.length > 0) {
      blocks.push({ kind: "paragraph", runs });
    }
    inline.length = 0;
    if (pendingMedia.length > 0) {
      blocks.push(...pendingMedia);
      pendingMedia.length = 0;
    }
  }

  const children = (container as Element).children || [];
  for (const node of children) {
    if (isNonTextString(node)) {
      continue;
    }
    if (node.type === "text") {
      const text = normalize((node as Text).data || "");
      if (text.trim()) {
        inline.push(makeRun(text, new Set(), ""));
      } else if (inline.length > 0) {
        inline.push(makeRun(" ", new Set(), ""));
      }
      continue;
    }
    if (node.type !== "tag" && !(node as Element).name) {
      continue;
    }

    const tag = (node as Element).name.toLowerCase();

    if (allowMediaEmbeds && tag === "iframe") {
      flush();
      const embed = iframeEmbed(node as Element);
      if (embed !== null) {
        blocks.push(embed);
      }
      continue;
    }

    if (allowMediaEmbeds && tag === "audio") {
      flush();
      const embed = audioEmbed($, node as Element);
      if (embed !== null) {
        blocks.push(embed);
      }
      continue;
    }

    if (DROPPED_TAGS.has(tag)) {
      continue;
    }

    if (INLINE_TAGS.has(tag)) {
      inline.push(...inlineRuns($, node as Element, baseUrl));
      const mediaList = recoverableMedia($, node as Element);
      for (const media of mediaList) {
        const block = mediaBlock($, media, baseUrl);
        if (block !== null) {
          pendingMedia.push(block);
        }
      }
      continue;
    }

    if (tag === "br") {
      inline.push(makeRun("\n", new Set(), ""));
      continue;
    }

    if (tag === "p") {
      flush();
      const runs = trimmed(inlineRuns($, node as Element, baseUrl));
      if (runs.length > 0) {
        blocks.push({ kind: "paragraph", runs });
      }
      const mediaList = recoverableMedia($, node as Element);
      for (const media of mediaList) {
        const block = mediaBlock($, media, baseUrl);
        if (block !== null) {
          blocks.push(block);
        }
      }
      continue;
    }

    if (tag in HEADING_TAGS) {
      flush();
      const level = HEADING_TAGS[tag];
      const runs = trimmed(inlineRuns($, node as Element, baseUrl));
      if (runs.length > 0) {
        blocks.push({ kind: "heading", level, runs });
      }
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      flush();
      const listBlock = buildListBlock($, node as Element, tag === "ol", baseUrl);
      if (listBlock !== null) {
        blocks.push(listBlock);
      }
      continue;
    }

    if (tag === "blockquote") {
      flush();
      const tweet = tweetEmbed($, node as Element);
      if (tweet !== null) {
        blocks.push(tweet);
        continue;
      }
      const inner = convert($, node as Element, baseUrl);
      if (inner.length > 0) {
        blocks.push({ kind: "blockquote", blocks: inner });
      }
      continue;
    }

    if (tag === "pre") {
      flush();
      const $pre = $(node as Element);
      const text = $pre.text();
      if (text.trim()) {
        // The `language-*` (and shorter `lang-*`) class on `<pre><code>` is the
        // de-facto fenced-code convention (highlight.js, Prism, CommonMark output).
        const codeClass = $pre.find("code").first().attr("class") ?? "";
        const languageMatch = /(?:^|\s)(?:language|lang)-([A-Za-z0-9_+-]+)/.exec(codeClass);
        blocks.push({ kind: "code_block", text, language: languageMatch?.[1] ?? "" });
      }
      continue;
    }

    if (tag === "img") {
      flush();
      const block = imageBlock(node as Element, baseUrl);
      if (block !== null) {
        blocks.push(block);
      }
      continue;
    }

    if (tag === "video") {
      flush();
      const embed = videoEmbed($, node as Element);
      if (embed !== null) {
        blocks.push(embed);
      }
      continue;
    }

    if (tag === "figure") {
      flush();
      blocks.push(...figureBlocks($, node as Element, baseUrl));
      continue;
    }

    if (tag === "hr") {
      flush();
      blocks.push({ kind: "divider" });
      continue;
    }

    if (tag === "tr") {
      flush();
      blocks.push(...tableRowBlocks($, node as Element, baseUrl));
      continue;
    }

    if (tag === "header") {
      flush();
      blocks.push(...headerBlocks($, node as Element, baseUrl));
      continue;
    }

    // Unknown wrapper: an embed facade becomes an embed; otherwise walk it
    flush();
    const facade = embedFacade($, node as Element);
    if (facade !== null) {
      blocks.push(facade);
      continue;
    }
    blocks.push(...convert($, node as Element, baseUrl, allowMediaEmbeds));
  }

  flush();
  return blocks;
}

/**
 * Parse sanitized article HTML into blocks.
 */
export function parseBlocks(html: string, baseUrl: string = ""): Block[] {
  if (!html || !html.trim()) {
    return [];
  }
  const $ = cheerio.load(html);
  const container = selectContainer($);
  return convert($, container, baseUrl);
}

/**
 * Flatten blocks to visible text for search indexing.
 */
export function plainTextOf(blocks: Block[]): string {
  const parts: string[] = [];

  function runsText(runs: InlineRun[]): string {
    return runs.map((r) => r.text).join("");
  }

  function walk(items: Block[]): void {
    for (const block of items) {
      switch (block.kind) {
        case "paragraph":
        case "heading":
          parts.push(runsText(block.runs));
          break;
        case "list":
          for (const item of block.items) {
            walk(item);
          }
          break;
        case "blockquote":
          walk(block.blocks);
          break;
        case "image": {
          const captionText = runsText(block.caption);
          if (captionText) {
            parts.push(captionText);
          }
          break;
        }
        case "embed":
          if (block.title) {
            parts.push(block.title);
          }
          break;
        case "code_block":
          parts.push(block.text);
          break;
        case "divider":
          break;
      }
    }
  }

  walk(blocks);
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join("\n\n");
}
