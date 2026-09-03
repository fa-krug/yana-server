/**
 * Block trees to database rows and back.
 *
 * Writing goes level by level: every depth is one bulk insert, because
 * children need their parent's primary key.
 *
 * Reading is TWO queries total, regardless of nesting depth -- one for the rows,
 * one prefetch for the runs -- and the tree is reassembled in TypeScript by grouping
 * on parentId. ("Two queries" is the logical shape; either can be split into
 * several statements by the same batch-size chunking the write side uses, for
 * the same reason -- see SQL_VARIABLE_BATCH_SIZE below.)
 */

import { eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { getDb, writeTransaction } from "@/lib/db/client";
import { articleBlocks, articleInlineRuns, type ArticleBlock } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import { EMBED_PROVIDERS, type Block, type EmbedProvider, type InlineRun } from "./types";

/**
 * The `tx` handle `writeTransaction()` hands its callback -- the same type its
 * own signature uses. Exported so a caller merging its own row/hash write with
 * a block write (aggregate.ts, reload.ts) can type the shared transaction
 * handle it passes into `writeBlocksIn()`.
 */
export type ArticleBlocksTx = BetterSQLite3Database<typeof schema>;

export interface ListItemNode {
  kind: "list_item";
  blocks: Block[];
}

export type StorageNode = Block | ListItemNode;

export function childNodes(node: StorageNode): StorageNode[] {
  switch (node.kind) {
    case "list":
      return node.items.map((item) => ({ kind: "list_item", blocks: item }));
    case "list_item":
    case "blockquote":
    case "summary":
      return node.blocks;
    default:
      return [];
  }
}

export function countBlockRows(blocks: Block[]): number {
  let total = 0;
  let level: StorageNode[] = [...blocks];
  while (level.length > 0) {
    total += level.length;
    const nextLevel: StorageNode[] = [];
    for (const node of level) {
      nextLevel.push(...childNodes(node));
    }
    level = nextLevel;
  }
  return total;
}

function rowForNode(
  articleId: number,
  node: StorageNode,
  parentId: number | null,
  position: number,
) {
  switch (node.kind) {
    case "list_item":
      return { articleId, parentId, position, kind: "list_item" };
    case "paragraph":
      return { articleId, parentId, position, kind: "paragraph" };
    case "heading":
      return {
        articleId,
        parentId,
        position,
        kind: "heading",
        level: Math.min(Math.max(node.level || 1, 1), 6),
      };
    case "list":
      return {
        articleId,
        parentId,
        position,
        kind: "list",
        ordered: node.ordered,
      };
    case "blockquote":
      return { articleId, parentId, position, kind: "blockquote" };
    case "summary":
      return { articleId, parentId, position, kind: "summary" };
    case "image":
      return {
        articleId,
        parentId,
        position,
        kind: "image",
        imageRef: node.ref || "",
      };
    case "embed":
      return {
        articleId,
        parentId,
        position,
        kind: "embed",
        embedProvider: node.provider || "generic",
        embedExternalUrl: node.externalUrl || "",
        embedThumbnailRef: node.thumbnailRef || "",
        embedTitle: node.title || "",
      };
    case "code_block":
      return {
        articleId,
        parentId,
        position,
        kind: "code_block",
        text: node.text || "",
        language: node.language || "",
      };
    case "divider":
      return { articleId, parentId, position, kind: "divider" };
    default: {
      const _exhaustive: never = node;
      throw new TypeError(`not a block: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function runsForNode(blockId: number, node: StorageNode) {
  let source: InlineRun[] = [];
  if (node.kind === "paragraph" || node.kind === "heading") {
    source = node.runs;
  } else if (node.kind === "image") {
    source = node.caption;
  } else {
    return [];
  }
  return source.map((run, position) => ({
    blockId,
    position,
    text: run.text,
    bold: Boolean(run.bold),
    italic: Boolean(run.italic),
    code: Boolean(run.code),
    strikethrough: Boolean(run.strikethrough),
    link: run.link || "",
  }));
}

// Keeps a single bulk INSERT, or a single `inArray(...)` bind list, well under
// SQLite's SQLITE_MAX_VARIABLE_NUMBER (32766 by default, but as low as 999 on
// an older/differently-compiled SQLite). A long-form scraped article can
// produce thousands of blocks/inline runs -- one bulk insert per level (or for
// all inline runs), or one unchunked `inArray` binding every id in a read-back,
// would otherwise blow the variable limit and fail with "too many SQL
// variables". Each write row here has at most 8 columns and each read binds
// one id per parameter, so 100 items/batch stays far under either limit either
// way. **Both the write side (batched inserts, below) and the read side
// (`loadBlocksForArticles`'s two `inArray` queries) chunk with this same
// constant** -- an article this batch size protects on the way in must not
// throw reading itself back out on the very build that made batching necessary.
const SQL_VARIABLE_BATCH_SIZE = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * The synchronous body of a block write, taking an already-open transaction
 * handle rather than opening its own. Extracted so a caller that also writes
 * the article row and its `contentHash` (aggregate.ts, reload.ts) can fold all
 * three into one `writeTransaction()` call -- either everything for an
 * article lands, or (on a thrown error or a process crash) none of it does.
 * `writeBlocks()` below is the thin, transaction-opening wrapper for callers
 * that only want the block tree written on its own (tests, and any future
 * caller with no row/hash write of its own to join).
 */
export function writeBlocksIn(tx: ArticleBlocksTx, articleId: number, blocks: Block[]): number {
  tx.delete(articleBlocks).where(eq(articleBlocks.articleId, articleId)).run();

  let written = 0;
  const pendingRuns: Array<{
    blockId: number;
    position: number;
    text: string;
    bold: boolean;
    italic: boolean;
    code: boolean;
    strikethrough: boolean;
    link: string;
  }> = [];

  let level: Array<{ node: StorageNode; parentId: number | null; position: number }> = blocks.map(
    (node, position) => ({ node, parentId: null, position }),
  );

  while (level.length > 0) {
    const rowsToInsert = level.map(({ node, parentId, position }) =>
      rowForNode(articleId, node, parentId, position),
    );

    // SQLite documents RETURNING row order as *undefined*; it has held in
    // practice under better-sqlite3, but trusting it would mean pairing
    // `insertedRows[i]` with `level[i]` purely positionally -- a silent
    // reordering there would scramble the tree with no error anywhere. So
    // this asks RETURNING for the columns that identify *which* inserted row
    // is which (`parentId`, `position`), which the insert values already
    // fixed, and looks each one up by that key instead of by array index.
    // That makes the pairing correct regardless of what order RETURNING
    // actually hands rows back in -- no extra read, and no assumption left
    // standing to document.
    const insertedRows: Array<{ id: number; parentId: number | null; position: number }> = [];
    for (const batch of chunk(rowsToInsert, SQL_VARIABLE_BATCH_SIZE)) {
      insertedRows.push(
        ...tx
          .insert(articleBlocks)
          .values(batch)
          .returning({
            id: articleBlocks.id,
            parentId: articleBlocks.parentId,
            position: articleBlocks.position,
          })
          .all(),
      );
    }

    written += insertedRows.length;

    // (articleId, parentId, position) is unique within one level: every
    // entry in `level` shares this call's `articleId`, and each node's own
    // position is assigned uniquely among its own siblings (root positions
    // 0..n-1, or a parent's children 0..m-1) when `nextLevel` below is built.
    const idByParentAndPosition = new Map<string, number>();
    for (const row of insertedRows) {
      idByParentAndPosition.set(`${row.parentId ?? "root"}:${row.position}`, row.id);
    }

    const nextLevel: Array<{ node: StorageNode; parentId: number; position: number }> = [];

    for (const { node, parentId, position } of level) {
      const insertedId = idByParentAndPosition.get(`${parentId ?? "root"}:${position}`);
      if (insertedId === undefined) {
        // Cannot happen given the uniqueness argument above; a thrown error
        // here rather than a silent `undefined` parentId is deliberate, so a
        // violation of that assumption fails loudly instead of scrambling the
        // tree the way an unchecked positional pairing would have.
        throw new Error(
          `writeBlocksIn: no inserted row found for articleId=${articleId} parentId=${parentId} position=${position}`,
        );
      }

      const runs = runsForNode(insertedId, node);
      pendingRuns.push(...runs);

      const children = childNodes(node);
      for (let pos = 0; pos < children.length; pos++) {
        nextLevel.push({ node: children[pos], parentId: insertedId, position: pos });
      }
    }

    level = nextLevel;
  }

  for (const batch of chunk(pendingRuns, SQL_VARIABLE_BATCH_SIZE)) {
    tx.insert(articleInlineRuns).values(batch).run();
  }

  return written;
}

export function writeBlocks(articleId: number, blocks: Block[]): number {
  return writeTransaction((tx) => writeBlocksIn(tx, articleId, blocks));
}

function blockForRow(
  row: ArticleBlock,
  childrenMap: Map<number, ArticleBlock[]>,
  runsMap: Map<number, InlineRun[]>,
): Block | null {
  const kids = childrenMap.get(row.id) || [];
  const runs = runsMap.get(row.id) || [];

  switch (row.kind) {
    case "paragraph":
      return {
        kind: "paragraph",
        runs,
      };
    case "heading":
      return {
        kind: "heading",
        level: row.level ?? 1,
        runs,
      };
    case "list": {
      const items: Block[][] = [];
      for (const kid of kids) {
        if (kid.kind === "list_item") {
          const itemKids = childrenMap.get(kid.id) || [];
          const item = itemKids
            .map((grandkid) => blockForRow(grandkid, childrenMap, runsMap))
            .filter((b): b is Block => b !== null);
          items.push(item);
        } else {
          const stray = blockForRow(kid, childrenMap, runsMap);
          items.push(stray !== null ? [stray] : []);
        }
      }
      return {
        kind: "list",
        ordered: Boolean(row.ordered),
        items,
      };
    }
    case "blockquote": {
      const inner = kids
        .map((kid) => blockForRow(kid, childrenMap, runsMap))
        .filter((b): b is Block => b !== null);
      return {
        kind: "blockquote",
        blocks: inner,
      };
    }
    case "summary": {
      const inner = kids
        .map((kid) => blockForRow(kid, childrenMap, runsMap))
        .filter((b): b is Block => b !== null);
      return {
        kind: "summary",
        blocks: inner,
      };
    }
    case "image":
      return {
        kind: "image",
        ref: row.imageRef || "",
        caption: runs,
      };
    case "embed": {
      const rawProvider = row.embedProvider || "generic";
      const provider = (EMBED_PROVIDERS as readonly string[]).includes(rawProvider)
        ? (rawProvider as EmbedProvider)
        : "generic";
      return {
        kind: "embed",
        provider,
        externalUrl: row.embedExternalUrl || "",
        thumbnailRef: row.embedThumbnailRef || "",
        title: row.embedTitle || "",
      };
    }
    case "code_block":
      return {
        kind: "code_block",
        text: row.text || "",
        language: row.language || "",
      };
    case "divider":
      return {
        kind: "divider",
      };
    default:
      console.warn(`Skipping block row ${row.id} with unexpected kind ${row.kind}`);
      return null;
  }
}

export function loadBlocksForArticles(articleIds: number[]): Record<number, Block[]> {
  if (articleIds.length === 0) {
    return {};
  }

  const db = getDb();

  // Chunked for the same reason the write side batches its inserts (see
  // SQL_VARIABLE_BATCH_SIZE above): each `inArray(...)` binds one SQL
  // variable per id, and a single long-form article can have thousands of
  // block rows. Reading one back with a single unchunked `inArray` would
  // throw "too many SQL variables" on the very build the write side already
  // defends against -- an article the batched insert wrote successfully would
  // then be unreadable. Ordering is preserved across chunks because every
  // articleId (and, below, every blockId) falls into exactly one chunk, so
  // each chunk's own ORDER BY is sufficient for the per-parent grouping done
  // below -- nothing from two different chunks is ever interleaved for the
  // same parent.
  const rows: ArticleBlock[] = [];
  for (const batch of chunk(articleIds, SQL_VARIABLE_BATCH_SIZE)) {
    rows.push(
      ...db
        .select()
        .from(articleBlocks)
        .where(inArray(articleBlocks.articleId, batch))
        .orderBy(articleBlocks.articleId, articleBlocks.parentId, articleBlocks.position)
        .all(),
    );
  }

  const blockIds = rows.map((r) => r.id);

  const runsByBlockId = new Map<number, InlineRun[]>();
  if (blockIds.length > 0) {
    const rawRuns: (typeof articleInlineRuns.$inferSelect)[] = [];
    for (const batch of chunk(blockIds, SQL_VARIABLE_BATCH_SIZE)) {
      rawRuns.push(
        ...db
          .select()
          .from(articleInlineRuns)
          .where(inArray(articleInlineRuns.blockId, batch))
          .orderBy(articleInlineRuns.blockId, articleInlineRuns.position)
          .all(),
      );
    }

    for (const run of rawRuns) {
      let list = runsByBlockId.get(run.blockId);
      if (!list) {
        list = [];
        runsByBlockId.set(run.blockId, list);
      }
      list.push({
        text: run.text,
        bold: Boolean(run.bold),
        italic: Boolean(run.italic),
        code: Boolean(run.code),
        strikethrough: Boolean(run.strikethrough),
        link: run.link || "",
      });
    }
  }

  const children = new Map<number, ArticleBlock[]>();
  const roots = new Map<number, ArticleBlock[]>();

  for (const row of rows) {
    if (row.parentId === null) {
      let list = roots.get(row.articleId);
      if (!list) {
        list = [];
        roots.set(row.articleId, list);
      }
      list.push(row);
    } else {
      let list = children.get(row.parentId);
      if (!list) {
        list = [];
        children.set(row.parentId, list);
      }
      list.push(row);
    }
  }

  const result: Record<number, Block[]> = {};

  for (const articleId of articleIds) {
    const articleRoots = roots.get(articleId) || [];
    const blocks: Block[] = [];
    for (const row of articleRoots) {
      if (row.kind === "list_item") {
        console.warn(`Skipping root-level list_item row ${row.id}`);
        continue;
      }
      const block = blockForRow(row, children, runsByBlockId);
      if (block !== null) {
        blocks.push(block);
      }
    }
    result[articleId] = blocks;
  }

  return result;
}

export function readBlocks(articleId: number): Block[] {
  const map = loadBlocksForArticles([articleId]);
  return map[articleId] || [];
}
