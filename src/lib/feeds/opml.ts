/**
 * Pure OPML 2.0 codec for feed import/export — no database, no auth, no
 * Next.js APIs. The `yana:` extension namespace carries everything OPML has
 * no slot for (aggregator type, per-feed scheduling, tags, aggregator
 * options) so a Yana-to-Yana round trip is lossless, while the file stays
 * valid, useful OPML for any other reader: unknown `yana:*` attributes are
 * simply ignored elsewhere. See
 * docs/superpowers/specs/2026-08-10-feeds-opml-import-export-design.md.
 *
 * `decodeOpml()` throws only when the file has no `<opml>`/`<body>`
 * structure at all — a single `<outline>` it can't make sense of (no name,
 * no identifier) is skipped instead, so one bad entry doesn't sink an
 * otherwise-good file.
 *
 * A declared `yana:options` blob is carried back as `optionsBase64`, not
 * decoded here: turning it into a validated options object needs
 * `schemaFor()` from `@/lib/aggregators/specs`, which is domain logic this
 * module deliberately knows nothing about. `decodeOpmlOptions()` only
 * reverses the wire encoding (base64 JSON) `encodeOpml()` applied.
 */
import * as cheerio from "cheerio";

export type OpmlExportFeed = {
  name: string;
  aggregator: string;
  identifier: string;
  enabled: boolean;
  dailyLimit: number;
  updateIntervalMinutes: number;
  concurrency: number;
  maxArticleAgeDays: number;
  options: Record<string, unknown>;
  tags: string[];
};

export type OpmlEntry = {
  name: string;
  identifier: string;
  aggregatorType?: string;
  enabled?: boolean;
  dailyLimit?: number;
  updateIntervalMinutes?: number;
  concurrency?: number;
  maxArticleAgeDays?: number;
  optionsBase64?: string;
  tags: string[];
};

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function encodeOpml(feeds: OpmlExportFeed[]): string {
  const outlines = feeds
    .map((feed) => {
      const attrs = [
        `text="${escapeAttr(feed.name)}"`,
        `title="${escapeAttr(feed.name)}"`,
        `type="rss"`,
        `xmlUrl="${escapeAttr(feed.identifier)}"`,
        `yana:aggregatorType="${escapeAttr(feed.aggregator)}"`,
        `yana:enabled="${feed.enabled}"`,
        `yana:dailyLimit="${feed.dailyLimit}"`,
        `yana:updateIntervalMinutes="${feed.updateIntervalMinutes}"`,
        `yana:concurrency="${feed.concurrency}"`,
        `yana:maxArticleAgeDays="${feed.maxArticleAgeDays}"`,
      ];
      if (feed.tags.length > 0) {
        const encodedTags = feed.tags.map((tag) => encodeURIComponent(tag)).join(",");
        attrs.push(`yana:tags="${escapeAttr(encodedTags)}"`);
      }
      if (Object.keys(feed.options).length > 0) {
        const encoded = Buffer.from(JSON.stringify(feed.options), "utf-8").toString("base64");
        attrs.push(`yana:options="${escapeAttr(encoded)}"`);
      }
      return `    <outline ${attrs.join(" ")} />`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0" xmlns:yana="urn:yana:opml">
  <head>
    <title>Yana Feeds</title>
  </head>
  <body>
${outlines}
  </body>
</opml>
`;
}

function parseBool(value: string | undefined): boolean | undefined {
  return value === undefined ? undefined : value === "true";
}

function parseIntAttr(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function decodeOpml(xml: string): OpmlEntry[] {
  const $ = cheerio.load(xml, { xmlMode: true });

  if ($("opml").length === 0 || $("body").length === 0) {
    throw new Error("Not a valid OPML file");
  }

  const entries: OpmlEntry[] = [];

  $("outline").each((_, el) => {
    const $el = $(el);
    // Skip category/folder outlines that have child outlines
    if ($el.children("outline").length > 0) return;

    const identifier = $el.attr("xmlUrl") ?? "";
    const name = $el.attr("text") || $el.attr("title") || identifier;
    if (!name) return;

    const tags = ($el.attr("yana:tags") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag) => decodeURIComponent(tag));

    entries.push({
      name,
      identifier,
      aggregatorType: $el.attr("yana:aggregatorType") || undefined,
      enabled: parseBool($el.attr("yana:enabled")),
      dailyLimit: parseIntAttr($el.attr("yana:dailyLimit")),
      updateIntervalMinutes: parseIntAttr($el.attr("yana:updateIntervalMinutes")),
      concurrency: parseIntAttr($el.attr("yana:concurrency")),
      maxArticleAgeDays: parseIntAttr($el.attr("yana:maxArticleAgeDays")),
      optionsBase64: $el.attr("yana:options") || undefined,
      tags,
    });
  });

  return entries;
}

export function decodeOpmlOptions(base64: string): Record<string, unknown> | null {
  try {
    const decoded = Buffer.from(base64, "base64").toString("utf-8");
    const parsed: unknown = JSON.parse(decoded);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
