import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { isSafeUrl } from "../../blocks/parser";
import { escapeHtml } from "../../extract/format";
import { IMAGE_REF_SCHEME } from "../../images/store";

/**
 * A media header's HTML, plus the one remote image URL still embedded in it
 * (if any) that a caller must resolve. `extractMediaHeader` runs inside the
 * synchronous `extractContent()`, so it cannot itself fetch and store the
 * image -- fetching is real network I/O (see `storeImageRefFromUrl` in
 * `images/store.ts`, which does it correctly). `imageUrl` is exactly the
 * value `safeImageSrc()` embedded (escaped) into `html`, so a caller can
 * resolve it asynchronously and substitute the result by replacing that same
 * escaped substring -- see `TagesschauAggregator.processContent()`.
 */
export interface MediaHeaderResult {
  html: string;
  imageUrl: string | null;
}

function safeImageSrc(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  if (imageUrl.startsWith(IMAGE_REF_SCHEME)) {
    return imageUrl;
  }
  if (!isSafeUrl(imageUrl)) {
    return null;
  }
  return escapeHtml(imageUrl);
}

/**
 * Shape of the JSON embedded in a Tagesschau media player's `data-v`
 * attribute. This is untrusted, attacker-reachable data scraped from the
 * page (mirrors `old/core/aggregators/tagesschau/media_processor.py`'s
 * `Dict[str, Any]`), so every field is optional and every read downstream
 * still narrows with `typeof`/`Array.isArray` before use.
 */
interface TagesschauImageFields {
  poster?: string;
  image?: string;
  thumbnail?: string;
  preview?: string;
  cover?: string;
}

interface TagesschauMediaAsset {
  url?: string;
  mimeType?: string;
}

interface TagesschauStream extends TagesschauImageFields {
  isAudioOnly?: boolean;
  media?: TagesschauMediaAsset[];
}

interface TagesschauMediaContainer extends TagesschauImageFields {
  streams?: TagesschauStream[];
}

interface TagesschauPlayerData {
  mc?: TagesschauMediaContainer;
  pluginData?: {
    "sharing@web"?: {
      embedCode?: string;
    };
  };
}

const IMAGE_FIELDS: Array<keyof TagesschauImageFields> = [
  "poster",
  "image",
  "thumbnail",
  "preview",
  "cover",
];

function parsePlayerData(dataV: string): TagesschauPlayerData {
  const decoded = dataV
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return JSON.parse(decoded) as TagesschauPlayerData;
}

function getPlayerImageFromMetadata(mc: TagesschauMediaContainer): string | null {
  for (const field of IMAGE_FIELDS) {
    if (mc[field] && typeof mc[field] === "string") {
      return mc[field];
    }
  }

  const streams = Array.isArray(mc.streams) ? mc.streams : [];
  for (const stream of streams) {
    for (const field of IMAGE_FIELDS) {
      if (stream[field] && typeof stream[field] === "string") {
        return stream[field];
      }
    }
  }

  return null;
}

function getPlayerImageFromDom($: cheerio.CheerioAPI, playerDiv: Element): string | null {
  const $player = $(playerDiv);
  const $parent = $player.parent();
  if ($parent.length > 0) {
    const $img = $parent.find("img").first();
    if ($img.length > 0) {
      const src = $img.attr("src");
      if (src) return src;
    }
  }

  const $prev = $player.prev();
  if ($prev.length > 0) {
    const $img = $prev.find("img").first();
    if ($img.length > 0) {
      const src = $img.attr("src");
      if (src) return src;
    }
  }

  return null;
}

function getPlayerImage(
  $: cheerio.CheerioAPI,
  playerDiv: Element,
  mc: TagesschauMediaContainer,
): string | null {
  let imageUrl = getPlayerImageFromMetadata(mc);
  if (!imageUrl) {
    imageUrl = getPlayerImageFromDom($, playerDiv);
  }

  if (imageUrl) {
    if (imageUrl.startsWith("//")) {
      return "https:" + imageUrl;
    }
    if (imageUrl.startsWith("/")) {
      return "https://www.tagesschau.de" + imageUrl;
    }
  }

  return imageUrl;
}

function buildHeaderFromEmbedCode(
  embedCode: string,
  isAudioOnly: boolean,
  imageUrl: string | null,
): string | null {
  const decoded = embedCode
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  const $ = cheerio.load(decoded);
  const $iframe = $("iframe").first();
  if ($iframe.length === 0) return null;

  let src = $iframe.attr("src");
  if (!src) return null;

  src = src.replace("$params$", "");
  if (src.startsWith("//")) {
    src = "https:" + src;
  } else if (src.startsWith("/")) {
    src = "https://www.tagesschau.de" + src;
  }

  if (!isSafeUrl(src)) {
    return null;
  }

  const safeSrc = escapeHtml(src);
  const height = isAudioOnly ? "200" : "315";
  const playerHtml =
    `<div class="media-player" style="width: 100%;">` +
    `<iframe src="${safeSrc}" width="100%" height="${height}" ` +
    `frameborder="0" allowfullscreen scrolling="no"></iframe>` +
    `</div>`;

  const safeImage = safeImageSrc(imageUrl);
  if (isAudioOnly && safeImage) {
    const imgPart =
      `<div class="media-image"><img src="${safeImage}" alt="Article image" ` +
      `style="max-width: 100%; height: auto; border-radius: 8px;"></div>`;
    return `<header class="media-header">${imgPart}${playerHtml}</header>`;
  }

  return `<header class="media-header">${playerHtml}</header>`;
}

function findMediaByMimeType(
  streams: TagesschauStream[],
  mediaType: string,
): { url: string; mime_type: string } | null {
  for (const stream of streams) {
    const mediaList = Array.isArray(stream.media) ? stream.media : [];
    for (const media of mediaList) {
      const url = media.url;
      const mimeType = media.mimeType || "";
      if (
        url &&
        typeof url === "string" &&
        mimeType.toLowerCase().includes(mediaType) &&
        isSafeUrl(url)
      ) {
        return {
          url: escapeHtml(url),
          mime_type: escapeHtml(mimeType),
        };
      }
    }
  }
  return null;
}

function buildHeaderFromStreams(
  streams: TagesschauStream[],
  isAudioOnly: boolean,
  imageUrl: string | null,
): string | null {
  const safeImage = safeImageSrc(imageUrl);
  if (isAudioOnly) {
    const audioMedia = findMediaByMimeType(streams, "audio");
    if (audioMedia) {
      const imgPart = safeImage
        ? `<div class="media-image"><img src="${safeImage}" alt="Article image" style="max-width: 100%; height: auto; border-radius: 8px;"></div>`
        : "";
      return (
        `<header class="media-header">${imgPart}` +
        `<div class="media-player" style="width: 100%;">` +
        `<audio controls preload="auto" style="width: 100%;">` +
        `<source src="${audioMedia.url}" type="${audioMedia.mime_type}">` +
        `Your browser does not support the audio element.` +
        `</audio></div></header>`
      );
    }
  } else {
    const videoMedia = findMediaByMimeType(streams, "video");
    if (videoMedia) {
      const posterAttr = safeImage ? ` poster="${safeImage}"` : "";
      return (
        `<header class="media-header">` +
        `<div class="media-player" style="width: 100%;">` +
        `<video controls preload="auto"${posterAttr} style="width: 100%;">` +
        `<source src="${videoMedia.url}" type="${videoMedia.mime_type}">` +
        `Your browser does not support the video element.` +
        `</video></div></header>`
      );
    }
  }
  return null;
}

/**
 * `imageUrl` when it is a remote URL `safeImageSrc()` would actually embed,
 * `null` when there is nothing to resolve -- unsafe, absent, or already a
 * `yana-img://` reference.
 */
function resolvableImageUrl(imageUrl: string | null): string | null {
  if (!imageUrl || imageUrl.startsWith(IMAGE_REF_SCHEME)) return null;
  return safeImageSrc(imageUrl) ? imageUrl : null;
}

export function extractMediaHeader(html: string): MediaHeaderResult | null {
  const $ = cheerio.load(html);
  const mediaPlayers: Element[] = [];

  $('div[data-v-type="MediaPlayer"]').each((_, div) => {
    const classAttr = $(div).attr("class") || "";
    const classes = classAttr.split(/\s+/).filter(Boolean);
    if (classes.some((c) => c.toLowerCase().includes("mediaplayer"))) {
      mediaPlayers.push(div);
    }
  });

  const teaserPlayers = mediaPlayers.filter((p) => {
    const classAttr = $(p).attr("class") || "";
    const classes = classAttr.split(/\s+/).filter(Boolean);
    return classes.some((c) => c.toLowerCase().includes("teaser-top"));
  });

  const players = teaserPlayers.length > 0 ? teaserPlayers : mediaPlayers;

  for (const playerDiv of players) {
    const dataV = $(playerDiv).attr("data-v");
    if (!dataV) continue;

    try {
      const playerData = parsePlayerData(dataV);
      const mc = playerData.mc || {};
      const streams = Array.isArray(mc.streams) ? mc.streams : [];

      const isAudioOnly = streams.length > 0 && streams.every((s) => s.isAudioOnly === true);
      const imageUrl = getPlayerImage($, playerDiv, mc);

      const pluginData = playerData.pluginData || {};
      const sharingWeb = pluginData["sharing@web"] || {};
      const embedCode = sharingWeb.embedCode;

      if (embedCode) {
        const result = buildHeaderFromEmbedCode(embedCode, isAudioOnly, imageUrl);
        if (result) return { html: result, imageUrl: resolvableImageUrl(imageUrl) };
      }

      const result = buildHeaderFromStreams(streams, isAudioOnly, imageUrl);
      if (result) return { html: result, imageUrl: resolvableImageUrl(imageUrl) };
    } catch {
      // ignore parse error
    }
  }

  return null;
}
