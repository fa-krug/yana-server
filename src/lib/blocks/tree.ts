import type { ArticleBlock, ArticleInlineRun } from "@/lib/db/schema/articles";

export type BlockNode = ArticleBlock & {
  children: BlockNode[];
  runs: ArticleInlineRun[];
};

export function buildTree(
  blocks: ArticleBlock[],
  runs: ArticleInlineRun[],
): BlockNode[] {
  // Group and sort runs by blockId
  const runsByBlockId = new Map<number, ArticleInlineRun[]>();
  for (const run of runs) {
    let list = runsByBlockId.get(run.blockId);
    if (!list) {
      list = [];
      runsByBlockId.set(run.blockId, list);
    }
    list.push(run);
  }

  for (const list of runsByBlockId.values()) {
    list.sort((a, b) => a.position - b.position);
  }

  // Create node map
  const nodeMap = new Map<number, BlockNode>();
  for (const block of blocks) {
    const blockRuns = runsByBlockId.get(block.id) ?? [];
    nodeMap.set(block.id, {
      ...block,
      children: [],
      runs: blockRuns,
    });
  }

  // Build hierarchy
  const roots: BlockNode[] = [];
  for (const block of blocks) {
    const node = nodeMap.get(block.id)!;
    if (block.parentId === null) {
      roots.push(node);
    } else {
      const parentNode = nodeMap.get(block.parentId);
      if (parentNode) {
        parentNode.children.push(node);
      }
      // If parentNode is missing (orphan), silently drop this block.
    }
  }

  // Sort roots and all node children by position ascending
  roots.sort((a, b) => a.position - b.position);
  for (const node of nodeMap.values()) {
    node.children.sort((a, b) => a.position - b.position);
  }

  return roots;
}
