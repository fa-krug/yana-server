import { WireBlock, WireDocument } from "../aggregators/blocks/schema";

export interface ImageManifestEntry {
  key: string;
  sourceUrl: string;
}

const PREFIX = "yana-img://";

function isStoredRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function hashOf(value: string): string {
  return value.slice(PREFIX.length);
}

/**
 * Image-ref normalization for golden comparison.
 *
 * Rewrites stored image refs (`yana-img://<hash>`) to stable placeholders (`yana-img://{img:N}`)
 * in first-encounter pre-order walk, returning the normalized wire document and image manifest.
 */
export function normalizeDocument(
  document: WireDocument,
  hashToUrl: Record<string, string>,
): { document: WireDocument; images: ImageManifestEntry[] } {
  const result: WireDocument = JSON.parse(JSON.stringify(document));
  const keys: Record<string, string> = {};
  const manifest: ImageManifestEntry[] = [];

  function keyFor(contentHash: string): string {
    if (!(contentHash in keys)) {
      const key = `img:${Object.keys(keys).length}`;
      keys[contentHash] = key;
      manifest.push({
        key,
        sourceUrl: hashToUrl[contentHash] ?? "",
      });
    }
    return keys[contentHash];
  }

  function visit(block: WireBlock): void {
    if (block.type === "image" && isStoredRef(block.ref)) {
      const h = hashOf(block.ref);
      block.ref = `${PREFIX}{${keyFor(h)}}`;
    } else if (block.type === "embed" && isStoredRef(block.thumbnailRef)) {
      const h = hashOf(block.thumbnailRef);
      block.thumbnailRef = `${PREFIX}{${keyFor(h)}}`;
    }

    if (block.type === "list" && Array.isArray(block.items)) {
      for (const item of block.items) {
        if (Array.isArray(item)) {
          for (const inner of item) {
            visit(inner);
          }
        }
      }
    } else if (block.type === "blockquote" && Array.isArray(block.blocks)) {
      for (const inner of block.blocks) {
        visit(inner);
      }
    }
  }

  if (result && Array.isArray(result.blocks)) {
    for (const block of result.blocks) {
      visit(block);
    }
  }

  return { document: result, images: manifest };
}
