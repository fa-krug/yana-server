import { describe, expect, it } from "vitest";

import { buildTree } from "./tree";

const block = (id: number, parentId: number | null, position: number, kind: string) =>
  ({
    id,
    parentId,
    position,
    kind,
    text: "",
    level: null,
    ordered: null,
    imageRef: "",
    embedProvider: "",
    embedThumbnailRef: "",
    embedExternalUrl: "",
    embedTitle: "",
    language: "",
    articleId: 1,
  }) as never;

describe("buildTree", () => {
  it("returns root blocks in position order", () => {
    const tree = buildTree([block(2, null, 1, "paragraph"), block(1, null, 0, "heading")], []);
    expect(tree.map((node) => node.id)).toEqual([1, 2]);
  });

  it("nests a list's items and their content", () => {
    const tree = buildTree(
      [block(1, null, 0, "list"), block(2, 1, 0, "list_item"), block(3, 2, 0, "paragraph")],
      [],
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].kind).toBe("list_item");
    expect(tree[0].children[0].children[0].kind).toBe("paragraph");
  });

  it("attaches runs to their block in position order", () => {
    const tree = buildTree([block(1, null, 0, "paragraph")], [
      {
        id: 2,
        blockId: 1,
        position: 1,
        text: "b",
        bold: false,
        italic: false,
        code: false,
        strikethrough: false,
        link: "",
      },
      {
        id: 1,
        blockId: 1,
        position: 0,
        text: "a",
        bold: false,
        italic: false,
        code: false,
        strikethrough: false,
        link: "",
      },
    ] as never);
    expect(tree[0].runs.map((run) => run.text)).toEqual(["a", "b"]);
  });

  it("drops a block whose parent is missing rather than losing the whole tree", () => {
    // Defensive: an orphan should cost one block, not the render.
    const tree = buildTree([block(1, null, 0, "paragraph"), block(2, 99, 0, "paragraph")], []);
    expect(tree).toHaveLength(1);
  });
});
