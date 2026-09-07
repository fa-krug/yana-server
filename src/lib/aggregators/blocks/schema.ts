/**
 * Version 1 of the Yana content format on the wire.
 *
 * Wire format discriminator field is `type`.
 * Extensibility rules:
 * - unknown block type is skipped, never fatal;
 * - unknown style name is ignored, never fatal.
 *
 * Optional values are null on the wire and "" in memory Block objects.
 */

import {
  clampHeadingLevel,
  EMBED_PROVIDERS,
  FORMAT_VERSION,
  STYLE_NAMES,
  type Block,
  type EmbedProvider,
  type InlineRun,
  type StyleName,
} from "./types";

export class UnsupportedFormatVersion extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFormatVersion";
  }
}

export interface WireInlineRun {
  text: string;
  styles: StyleName[];
  link: string | null;
}

export type WireBlock =
  | { type: "paragraph"; runs: WireInlineRun[] }
  | { type: "heading"; level: number; runs: WireInlineRun[] }
  | { type: "list"; ordered: boolean; items: WireBlock[][] }
  | { type: "blockquote"; blocks: WireBlock[] }
  | { type: "summary"; blocks: WireBlock[] }
  | { type: "image"; ref: string; caption: WireInlineRun[] }
  | {
      type: "embed";
      provider: string;
      thumbnailRef: string | null;
      externalURL: string;
      title: string | null;
    }
  | { type: "codeBlock"; text: string; language: string | null }
  | { type: "divider" };

export interface WireDocument {
  version: typeof FORMAT_VERSION;
  blocks: WireBlock[];
}

function orNull(value: string | undefined | null): string | null {
  return value && value.length > 0 ? value : null;
}

export function encodeRun(run: InlineRun): WireInlineRun {
  const styles: StyleName[] = [];
  if (run.bold) styles.push("bold");
  if (run.italic) styles.push("italic");
  if (run.code) styles.push("code");
  if (run.strikethrough) styles.push("strikethrough");

  return {
    text: run.text,
    styles,
    link: orNull(run.link),
  };
}

export function encodeBlock(block: Block): WireBlock {
  switch (block.kind) {
    case "paragraph":
      return {
        type: "paragraph",
        runs: block.runs.map(encodeRun),
      };
    case "heading":
      return {
        type: "heading",
        level: block.level,
        runs: block.runs.map(encodeRun),
      };
    case "list":
      return {
        type: "list",
        ordered: block.ordered,
        items: block.items.map((item) => item.map(encodeBlock)),
      };
    case "blockquote":
      return {
        type: "blockquote",
        blocks: block.blocks.map(encodeBlock),
      };
    case "summary":
      return {
        type: "summary",
        blocks: block.blocks.map(encodeBlock),
      };
    case "image":
      return {
        type: "image",
        ref: block.ref,
        caption: block.caption.map(encodeRun),
      };
    case "embed":
      return {
        type: "embed",
        provider: block.provider,
        thumbnailRef: orNull(block.thumbnailRef),
        externalURL: block.externalUrl,
        title: orNull(block.title),
      };
    case "code_block":
      return {
        type: "codeBlock",
        text: block.text,
        language: orNull(block.language),
      };
    case "divider":
      return {
        type: "divider",
      };
    default: {
      const _exhaustive: never = block;
      throw new TypeError(`not a block: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function encodeDocument(blocks: Block[]): WireDocument {
  return {
    version: FORMAT_VERSION,
    blocks: blocks.map(encodeBlock),
  };
}

/**
 * Coerce an untrusted wire value into a heading level. Only the coercion --
 * float truncation, string parsing, NaN defaulting to 1 -- is this function's
 * own concern; the 1-6 bound itself is `clampHeadingLevel()` (`./types`), the
 * one place that arithmetic lives, so this doesn't hold its own copy of it.
 */
function clampLevel(value: unknown): number {
  let level = typeof value === "number" ? Math.floor(value) : parseInt(String(value), 10);
  if (isNaN(level)) level = 1;
  return clampHeadingLevel(level);
}

export function decodeRuns(items: unknown): InlineRun[] {
  if (!Array.isArray(items)) return [];
  const runs: InlineRun[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    const rawStyles = Array.isArray(raw.styles) ? raw.styles : [];
    const validStyles = new Set<string>(
      rawStyles.filter(
        (s): s is string => typeof s === "string" && (STYLE_NAMES as readonly string[]).includes(s),
      ),
    );
    const text = typeof raw.text === "string" ? raw.text : "";
    const link = typeof raw.link === "string" ? raw.link : "";

    runs.push({
      text,
      bold: validStyles.has("bold"),
      italic: validStyles.has("italic"),
      code: validStyles.has("code"),
      strikethrough: validStyles.has("strikethrough"),
      link,
    });
  }
  return runs;
}

export function decodeBlock(obj: unknown): Block | null {
  if (typeof obj !== "object" || obj === null) return null;
  const raw = obj as Record<string, unknown>;

  switch (raw.type) {
    case "paragraph":
      return {
        kind: "paragraph",
        runs: decodeRuns(raw.runs),
      };
    case "heading":
      return {
        kind: "heading",
        level: clampLevel(raw.level ?? 1),
        runs: decodeRuns(raw.runs),
      };
    case "list": {
      const rawItems = Array.isArray(raw.items) ? raw.items : [];
      const items: Block[][] = rawItems.map((item) => decodeBlocks(item));
      return {
        kind: "list",
        ordered: Boolean(raw.ordered),
        items,
      };
    }
    case "blockquote":
      return {
        kind: "blockquote",
        blocks: decodeBlocks(raw.blocks),
      };
    case "summary":
      return {
        kind: "summary",
        blocks: decodeBlocks(raw.blocks),
      };
    case "image":
      return {
        kind: "image",
        ref: typeof raw.ref === "string" ? raw.ref : "",
        caption: decodeRuns(raw.caption),
      };
    case "embed": {
      const rawProvider = typeof raw.provider === "string" ? raw.provider : "generic";
      const provider = (EMBED_PROVIDERS as readonly string[]).includes(rawProvider)
        ? (rawProvider as EmbedProvider)
        : "generic";
      return {
        kind: "embed",
        provider,
        externalUrl: typeof raw.externalURL === "string" ? raw.externalURL : "",
        thumbnailRef: typeof raw.thumbnailRef === "string" ? raw.thumbnailRef : "",
        title: typeof raw.title === "string" ? raw.title : "",
      };
    }
    case "codeBlock":
      return {
        kind: "code_block",
        text: typeof raw.text === "string" ? raw.text : "",
        language: typeof raw.language === "string" ? raw.language : "",
      };
    case "divider":
      return {
        kind: "divider",
      };
    default:
      return null;
  }
}

export function decodeBlocks(items: unknown): Block[] {
  if (!Array.isArray(items)) return [];
  const blocks: Block[] = [];
  for (const item of items) {
    const decoded = decodeBlock(item);
    if (decoded !== null) {
      blocks.push(decoded);
    }
  }
  return blocks;
}

export function decodeDocument(payload: unknown): Block[] {
  if (typeof payload !== "object" || payload === null) {
    throw new UnsupportedFormatVersion(
      `unsupported content format version: ${JSON.stringify(payload)}`,
    );
  }
  const raw = payload as Record<string, unknown>;
  if (raw.version !== FORMAT_VERSION) {
    throw new UnsupportedFormatVersion(
      `unsupported content format version: ${JSON.stringify(raw.version)}`,
    );
  }
  return decodeBlocks(raw.blocks);
}
