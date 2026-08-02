import { describe, expect, it } from "vitest";
import { normalizeDocument } from "./normalize";
import { WireDocument } from "../aggregators/blocks/schema";

describe("normalizeDocument", () => {
  it("assigns keys in first encounter order", () => {
    const document: WireDocument = {
      version: 1,
      blocks: [
        { type: "image", ref: "yana-img://bbb", caption: [] },
        { type: "image", ref: "yana-img://aaa", caption: [] },
      ],
    };
    const { document: normalized, images: manifest } = normalizeDocument(document, {
      aaa: "https://x/a",
      bbb: "https://x/b",
    });

    expect((normalized.blocks[0] as { ref: string }).ref).toBe("yana-img://{img:0}");
    expect((normalized.blocks[1] as { ref: string }).ref).toBe("yana-img://{img:1}");
    expect(manifest.map((e) => e.key)).toEqual(["img:0", "img:1"]);
    expect(manifest[0].sourceUrl).toBe("https://x/b");
  });

  it("reuses key for repeated hash", () => {
    const document: WireDocument = {
      version: 1,
      blocks: [
        { type: "image", ref: "yana-img://aaa", caption: [] },
        { type: "image", ref: "yana-img://aaa", caption: [] },
      ],
    };
    const { document: normalized, images: manifest } = normalizeDocument(document, {
      aaa: "https://x/a",
    });

    expect((normalized.blocks[0] as { ref: string }).ref).toBe("yana-img://{img:0}");
    expect((normalized.blocks[1] as { ref: string }).ref).toBe("yana-img://{img:0}");
    expect(manifest).toHaveLength(1);
  });

  it("leaves remote and empty refs untouched", () => {
    const document: WireDocument = {
      version: 1,
      blocks: [
        { type: "image", ref: "https://cdn.example/a.jpg", caption: [] },
        {
          type: "embed",
          provider: "youtube",
          thumbnailRef: null,
          externalURL: "https://youtu.be/x",
          title: null,
        },
      ],
    };
    const { document: normalized, images: manifest } = normalizeDocument(document, {});

    expect((normalized.blocks[0] as { ref: string }).ref).toBe("https://cdn.example/a.jpg");
    expect((normalized.blocks[1] as { thumbnailRef: string | null }).thumbnailRef).toBeNull();
    expect(manifest).toEqual([]);
  });

  it("walks nested lists and blockquotes in wire order", () => {
    const document: WireDocument = {
      version: 1,
      blocks: [
        {
          type: "list",
          ordered: false,
          items: [
            [{ type: "image", ref: "yana-img://first", caption: [] }],
            [
              {
                type: "blockquote",
                blocks: [{ type: "image", ref: "yana-img://second", caption: [] }],
              },
            ],
          ],
        },
      ],
    };
    const { images: manifest } = normalizeDocument(document, {
      first: "https://x/1",
      second: "https://x/2",
    });

    expect(manifest.map((e) => e.sourceUrl)).toEqual(["https://x/1", "https://x/2"]);
  });

  it("normalizes embed thumbnail refs", () => {
    const document: WireDocument = {
      version: 1,
      blocks: [
        {
          type: "embed",
          provider: "youtube",
          thumbnailRef: "yana-img://thumb",
          externalURL: "https://youtu.be/x",
          title: null,
        },
      ],
    };
    const { document: normalized, images: manifest } = normalizeDocument(document, {
      thumb: "https://i.ytimg/x.jpg",
    });

    expect((normalized.blocks[0] as { thumbnailRef: string }).thumbnailRef).toBe(
      "yana-img://{img:0}",
    );
    expect(manifest[0].key).toBe("img:0");
  });
});
