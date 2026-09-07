/** Mirrors old/core/choices.py AGGREGATOR_CHOICES. */
export const AGGREGATOR_KEYS = [
  "full_website",
  "feed_content",
  "heise",
  "merkur",
  "tagesschau",
  "explosm",
  "dark_legacy",
  "caschys_blog",
  "mactechnews",
  "oglaf",
  "mein_mmo",
  "the_verge",
  "ars_technica",
  "youtube",
  "reddit",
  "podcast",
] as const;
export type AggregatorKey = (typeof AGGREGATOR_KEYS)[number];

/**
 * Mirrors old/core/blocks/types.py BLOCK_KINDS.
 * `list_item` is the one synthetic kind: a list's children are list_item rows
 * and each item's children are its content blocks. It never goes on the wire.
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

/** Anything unrecognized decodes to `generic`, never fatal. */
export const EMBED_PROVIDERS = ["youtube", "dailymotion", "video", "tweet", "generic"] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

/** Order matters: the wire's `styles` array uses it. */
export const STYLE_NAMES = ["bold", "italic", "code", "strikethrough"] as const;
export type StyleName = (typeof STYLE_NAMES)[number];

/** Mirrors the transitions `src/lib/jobs/queue.ts` actually writes to `jobs.status`. */
export const JOB_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelling",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
