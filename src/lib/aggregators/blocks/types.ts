/**
 * The Yana content format's block types.
 *
 * Server-side twin of iOS's Block / InlineRun / Embed.
 * Plain data: no HTML, no ORM, no I/O.
 *
 * Empty strings stand in for absent optional values (link="", language="", etc.).
 * The wire encoder turns them into JSON null; database columns store them as "".
 */

export const FORMAT_VERSION = 1;

/** Inline style names, in the order the wire's `styles` array uses. */
export const STYLE_NAMES = ["bold", "italic", "code", "strikethrough"] as const;
export type StyleName = (typeof STYLE_NAMES)[number];

/** Recognized embed providers. Anything else decodes to `generic`. */
export const EMBED_PROVIDERS = ["youtube", "dailymotion", "video", "tweet", "generic"] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

/**
 * Storage kinds. `list_item` is the one synthetic kind -- it encodes a list's
 * `Block[][]` shape as rows and never appears on the wire.
 */
export const BLOCK_KINDS = [
  "paragraph",
  "heading",
  "list",
  "list_item",
  "blockquote",
  "summary",
  "image",
  "embed",
  "code_block",
  "divider",
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** A styled span of text inside a paragraph, heading or image caption. */
export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strikethrough?: boolean;
  link?: string;
}

export interface Paragraph {
  kind: "paragraph";
  runs: InlineRun[];
}

export interface Heading {
  kind: "heading";
  level: number;
  runs: InlineRun[];
}

export interface ListBlock {
  kind: "list";
  ordered: boolean;
  items: Block[][];
}

export interface Blockquote {
  kind: "blockquote";
  blocks: Block[];
}

/**
 * The article's AI-written summary, second in the document (after the
 * lead-media image, when there is one) and never anywhere else -- see the
 * document-order rule on `applyAiToBlocks()` in `@/lib/ai/run`.
 *
 * A kind of its own rather than the paragraph it used to parse as, so a client
 * can style, collapse or skip it without counting blocks. It wraps blocks
 * rather than runs (the blockquote shape, not the paragraph one) because the
 * summary is prose of unknown length: a model answering in two paragraphs
 * produces two, inside this one block, instead of silently pushing the article
 * down the document.
 */
export interface SummaryBlock {
  kind: "summary";
  blocks: Block[];
}

export interface ImageBlock {
  kind: "image";
  /** `yana-img://<sha256>` into the content-addressed store, or a remote URL. */
  ref: string;
  caption: InlineRun[];
}

export interface EmbedBlock {
  kind: "embed";
  provider: EmbedProvider;
  /** Where a tap navigates, or -- for `video` -- the direct stream URL. */
  externalUrl: string;
  thumbnailRef: string;
  title: string;
}

export interface CodeBlock {
  kind: "code_block";
  text: string;
  language: string;
}

export interface Divider {
  kind: "divider";
}

export type Block =
  | Paragraph
  | Heading
  | ListBlock
  | Blockquote
  | SummaryBlock
  | ImageBlock
  | EmbedBlock
  | CodeBlock
  | Divider;
