/**
 * Block trees to database rows and back.
 *
 * Writing goes level by level: every depth is one bulk insert, because
 * children need their parent's primary key.
 *
 * Reading is TWO queries total, regardless of nesting depth -- one for the rows,
 * one prefetch for the runs -- and the tree is reassembled in TypeScript by grouping
 * on parentId.
 */

import { eq, inArray } from "drizzle-orm";

import { getDb, writeTransaction } from "@/lib/db/client";
import { articleBlocks, articleInlineRuns, type ArticleBlock } from "@/lib/db/schema";

import {
  EMBED_PROVIDERS,
  type Block,
  type EmbedProvider,
  type InlineRun,
} from "./types";

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

export async function writeBlocks(articleId: number, blocks: Block[]): Promise<number> {
  return writeTransaction((tx) => {
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

    let level: Array<{ node: StorageNode; parentId: number | null; position: number }> =
      blocks.map((node, position) => ({ node, parentId: null, position }));

    while (level.length > 0) {
      const rowsToInsert = level.map(({ node, parentId, position }) =>
        rowForNode(articleId, node, parentId, position),
      );

      const insertedRows = tx
        .insert(articleBlocks)
        .values(rowsToInsert)
        .returning({ id: articleBlocks.id })
        .all();

      written += insertedRows.length;

      const nextLevel: Array<{ node: StorageNode; parentId: number; position: number }> = [];

      for (let i = 0; i < level.length; i++) {
        const { node } = level[i];
        const insertedId = insertedRows[i].id;

        const runs = runsForNode(insertedId, node);
        pendingRuns.push(...runs);

        const children = childNodes(node);
        for (let pos = 0; pos < children.length; pos++) {
          nextLevel.push({ node: children[pos], parentId: insertedId, position: pos });
        }
      }

      level = nextLevel;
    }

    if (pendingRuns.length > 0) {
      tx.insert(articleInlineRuns).values(pendingRuns).run();
    }

    return written;
  });
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

export async function loadBlocksForArticles(
  articleIds: number[],
): Promise<Record<number, Block[]>> {
  if (articleIds.length === 0) {
    return {};
  }

  const db = getDb();

  const rows = db
    .select()
    .from(articleBlocks)
    .where(inArray(articleBlocks.articleId, articleIds))
    .orderBy(articleBlocks.articleId, articleBlocks.parentId, articleBlocks.position)
    .all();

  const blockIds = rows.map((r) => r.id);

  const runsByBlockId = new Map<number, InlineRun[]>();
  if (blockIds.length > 0) {
    const rawRuns = db
      .select()
      .from(articleInlineRuns)
      .where(inArray(articleInlineRuns.blockId, blockIds))
      .orderBy(articleInlineRuns.blockId, articleInlineRuns.position)
      .all();

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

export async function readBlocks(articleId: number): Promise<Block[]> {
  const map = await loadBlocksForArticles([articleId]);
  return map[articleId] || [];
}
