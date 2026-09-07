/**
 * Flatten a block tree to visible text.
 *
 * Its own module, and not merely for tidiness: it is a pure walk over the tree
 * and touches no HTML, but it used to live in `./parser`, whose module-level
 * `import * as cheerio` then reached every importer. `@/lib/ai/run` is one, for
 * the plain-text prompt a summarize-only request sends -- so
 * `POST /api/v1/ai/prompt` was pulling the whole HTML parser into its graph for
 * a function that never uses it. `./parser` re-exports this, so the callers that
 * legitimately have cheerio already (both job handlers, which also call
 * `parseBlocks()`) need no change.
 */

import type { Block, InlineRun } from "./types";

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
        case "summary":
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
