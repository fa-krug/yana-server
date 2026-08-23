import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { BlockNode } from "@/lib/blocks/tree";
import { BlockTree } from "./block-tree";
import { BlockNode as BlockNodeComponent } from "./block-node";

function makeBlock(overrides: Partial<BlockNode>): BlockNode {
  return {
    id: 1,
    articleId: 100,
    parentId: null,
    position: 0,
    kind: "paragraph",
    level: null,
    ordered: null,
    text: "",
    language: "",
    imageRef: "",
    embedProvider: "",
    embedThumbnailRef: "",
    embedExternalUrl: "",
    embedTitle: "",
    children: [],
    runs: [],
    ...overrides,
  };
}

describe("BlockNode", () => {
  it("renders paragraph with styled inline runs", () => {
    const node = makeBlock({
      kind: "paragraph",
      runs: [
        {
          blockId: 1,
          position: 0,
          text: "Plain text ",
          bold: false,
          italic: false,
          code: false,
          strikethrough: false,
          link: "",
        },
        {
          blockId: 1,
          position: 1,
          text: "bold text",
          bold: true,
          italic: false,
          code: false,
          strikethrough: false,
          link: "",
        },
        {
          blockId: 1,
          position: 2,
          text: "italic text",
          bold: false,
          italic: true,
          code: false,
          strikethrough: false,
          link: "",
        },
        {
          blockId: 1,
          position: 3,
          text: "code text",
          bold: false,
          italic: false,
          code: true,
          strikethrough: false,
          link: "",
        },
        {
          blockId: 1,
          position: 4,
          text: "deleted text",
          bold: false,
          italic: false,
          code: false,
          strikethrough: true,
          link: "",
        },
        {
          blockId: 1,
          position: 5,
          text: "link text",
          bold: false,
          italic: false,
          code: false,
          strikethrough: false,
          link: "https://example.com",
        },
      ],
    });

    const { container } = render(<BlockNodeComponent node={node} />);

    const p = container.querySelector("p");
    expect(p).not.toBeNull();
    expect(p?.textContent).toContain(
      "Plain text bold textitalic textcode textdeleted textlink text",
    );

    expect(container.querySelector("strong")?.textContent).toBe("bold text");
    expect(container.querySelector("em")?.textContent).toBe("italic text");
    expect(container.querySelector("code")?.textContent).toBe("code text");
    expect(container.querySelector("del")?.textContent).toBe("deleted text");

    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(link?.textContent).toBe("link text");
  });

  it("renders heading and clamps levels between 1 and 6", () => {
    const h2Node = makeBlock({
      kind: "heading",
      level: 2,
      runs: [
        {
          blockId: 1,
          position: 0,
          text: "Heading 2",
          bold: false,
          italic: false,
          code: false,
          strikethrough: false,
          link: "",
        },
      ],
    });
    const { container: c2 } = render(<BlockNodeComponent node={h2Node} />);
    expect(c2.querySelector("h2")?.textContent).toBe("Heading 2");

    const minClamped = makeBlock({ kind: "heading", level: -5 });
    const { container: cMin } = render(<BlockNodeComponent node={minClamped} />);
    expect(cMin.querySelector("h1")).not.toBeNull();

    const maxClamped = makeBlock({ kind: "heading", level: 99 });
    const { container: cMax } = render(<BlockNodeComponent node={maxClamped} />);
    expect(cMax.querySelector("h6")).not.toBeNull();
  });

  it("renders ordered and unordered lists with list_item children", () => {
    const listNode = makeBlock({
      kind: "list",
      ordered: true,
      children: [
        makeBlock({
          id: 2,
          kind: "list_item",
          children: [
            makeBlock({
              id: 20,
              kind: "paragraph",
              runs: [
                {
                  blockId: 20,
                  position: 0,
                  text: "First item",
                  bold: false,
                  italic: false,
                  code: false,
                  strikethrough: false,
                  link: "",
                },
              ],
            }),
          ],
        }),
        makeBlock({
          id: 3,
          kind: "list_item",
          children: [
            makeBlock({
              id: 30,
              kind: "paragraph",
              runs: [
                {
                  blockId: 30,
                  position: 0,
                  text: "Second item",
                  bold: false,
                  italic: false,
                  code: false,
                  strikethrough: false,
                  link: "",
                },
              ],
            }),
          ],
        }),
      ],
    });

    const { container } = render(<BlockNodeComponent node={listNode} />);
    const ol = container.querySelector("ol");
    expect(ol).not.toBeNull();
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe("First item");
    expect(items[1].textContent).toBe("Second item");

    const unorderedNode = makeBlock({ kind: "list", ordered: false });
    const { container: unC } = render(<BlockNodeComponent node={unorderedNode} />);
    expect(unC.querySelector("ul")).not.toBeNull();
  });

  it("renders blockquote with children", () => {
    const bqNode = makeBlock({
      kind: "blockquote",
      children: [
        makeBlock({
          id: 2,
          kind: "paragraph",
          runs: [
            {
              blockId: 2,
              position: 0,
              text: "Nested paragraph inside quote",
              bold: false,
              italic: false,
              code: false,
              strikethrough: false,
              link: "",
            },
          ],
        }),
      ],
    });

    const { container } = render(<BlockNodeComponent node={bqNode} />);
    const bq = container.querySelector("blockquote");
    expect(bq).not.toBeNull();
    expect(bq?.textContent).toContain("Nested paragraph inside quote");
  });

  it("renders the summary as its own labelled section, not as body prose", () => {
    const summaryNode = makeBlock({
      kind: "summary",
      children: [
        makeBlock({
          id: 2,
          kind: "paragraph",
          runs: [
            {
              blockId: 2,
              position: 0,
              text: "The gist of it.",
              bold: false,
              italic: false,
              code: false,
              strikethrough: false,
              link: "",
            },
          ],
        }),
      ],
    });

    const { container } = render(<BlockNodeComponent node={summaryNode} />);
    const section = container.querySelector('[data-slot="yana-ai-summary"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain("The gist of it.");
  });

  it("renders blockquote and list_item content from child blocks", () => {
    const bqNode = makeBlock({
      id: 1,
      kind: "blockquote",
      children: [
        makeBlock({
          id: 2,
          kind: "paragraph",
          runs: [
            {
              blockId: 2,
              position: 0,
              text: "quoted text",
              bold: false,
              italic: false,
              code: false,
              strikethrough: false,
              link: "",
            },
          ],
        }),
      ],
    });

    const { container: bqContainer } = render(<BlockNodeComponent node={bqNode} />);
    expect(bqContainer.querySelector("blockquote")).not.toBeNull();
    expect(screen.getByText("quoted text")).not.toBeNull();

    const listNode = makeBlock({
      id: 3,
      kind: "list",
      ordered: false,
      children: [
        makeBlock({
          id: 4,
          kind: "list_item",
          children: [
            makeBlock({
              id: 5,
              kind: "paragraph",
              runs: [
                {
                  blockId: 5,
                  position: 0,
                  text: "item text",
                  bold: false,
                  italic: false,
                  code: false,
                  strikethrough: false,
                  link: "",
                },
              ],
            }),
          ],
        }),
      ],
    });

    const { container: listContainer } = render(<BlockNodeComponent node={listNode} />);
    expect(listContainer.querySelector("ul")).not.toBeNull();
    expect(screen.getByText("item text")).not.toBeNull();
  });

  it("renders image replacing yana-img:// protocol and renders caption if present", () => {
    const imgNode = makeBlock({
      kind: "image",
      imageRef: "yana-img://0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      runs: [
        {
          blockId: 1,
          position: 0,
          text: "Image Caption",
          bold: false,
          italic: false,
          code: false,
          strikethrough: false,
          link: "",
        },
      ],
    });

    const { container } = render(<BlockNodeComponent node={imgNode} />);
    const figure = container.querySelector("figure");
    expect(figure).not.toBeNull();

    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(
      "/media/images/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );

    const caption = container.querySelector("figcaption");
    expect(caption?.textContent).toBe("Image Caption");
  });

  it("renders embed card with thumbnail, provider badge, title, and link", () => {
    const embedNode = makeBlock({
      kind: "embed",
      embedThumbnailRef: "yana-img://thumbhash123",
      embedProvider: "YouTube",
      embedTitle: "Awesome Video",
      embedExternalUrl: "https://youtube.com/watch?v=123",
    });

    const { container } = render(<BlockNodeComponent node={embedNode} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://youtube.com/watch?v=123");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");

    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/media/images/thumbhash123");

    expect(screen.getByText("YouTube")).not.toBeNull();
    expect(screen.getByText("Awesome Video")).not.toBeNull();
  });

  it("renders a youtube embed as a real iframe, not a link card", () => {
    const embedNode = makeBlock({
      kind: "embed",
      embedProvider: "youtube",
      embedExternalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    const { container } = render(<BlockNodeComponent node={embedNode} />);
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
    expect(container.querySelector("a")).toBeNull();
  });

  it("renders a dailymotion embed as a real iframe, not a link card", () => {
    const embedNode = makeBlock({
      kind: "embed",
      embedProvider: "dailymotion",
      embedExternalUrl: "https://www.dailymotion.com/video/x123abc",
    });

    const { container } = render(<BlockNodeComponent node={embedNode} />);
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe("https://www.dailymotion.com/embed/video/x123abc");
    expect(container.querySelector("a")).toBeNull();
  });

  it("falls back to the link card when a youtube embed's video id cannot be parsed", () => {
    const embedNode = makeBlock({
      kind: "embed",
      embedProvider: "youtube",
      embedExternalUrl: "https://www.youtube.com/",
      embedTitle: "Untitled",
    });

    const { container } = render(<BlockNodeComponent node={embedNode} />);
    expect(container.querySelector("iframe")).toBeNull();
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://www.youtube.com/");
  });

  it("renders code_block with language label and raw text", () => {
    const codeNode = makeBlock({
      kind: "code_block",
      language: "typescript",
      text: "const x = 42;",
    });

    const { container } = render(<BlockNodeComponent node={codeNode} />);
    const pre = container.querySelector("pre");
    const code = container.querySelector("code");
    expect(pre).not.toBeNull();
    expect(code?.classList.contains("language-typescript")).toBe(true);
    expect(code?.textContent).toBe("const x = 42;");
  });

  it("renders divider <hr />", () => {
    const dividerNode = makeBlock({ kind: "divider" });
    const { container } = render(<BlockNodeComponent node={dividerNode} />);
    expect(container.querySelector("hr")).not.toBeNull();
  });

  it("skips unknown block kind silently", () => {
    const unknownNode = makeBlock({ kind: "unknown_future_kind" });
    const { container } = render(<BlockNodeComponent node={unknownNode} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("BlockTree", () => {
  it("renders block tree and toggles raw JSON view", () => {
    const nodes = [
      makeBlock({
        id: 1,
        kind: "paragraph",
        runs: [
          {
            blockId: 1,
            position: 0,
            text: "Hello World",
            bold: false,
            italic: false,
            code: false,
            strikethrough: false,
            link: "",
          },
        ],
      }),
    ];

    const { container } = render(<BlockTree nodes={nodes} />);

    // Initially in Rendered view
    expect(screen.getByText("Hello World")).not.toBeNull();
    expect(container.querySelector("pre code")).toBeNull();

    // Click "Raw JSON" toggle button
    const jsonBtn = screen.getByRole("button", { name: "Raw JSON" });
    fireEvent.click(jsonBtn);

    // Should display JSON in pre code block
    const code = container.querySelector("pre code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('"kind": "paragraph"');
    expect(code?.textContent).toContain('"text": "Hello World"');

    // Click "Rendered" toggle button
    const renderedBtn = screen.getByRole("button", { name: "Rendered" });
    fireEvent.click(renderedBtn);

    expect(container.querySelector("pre code")).toBeNull();
    expect(screen.getByText("Hello World")).not.toBeNull();
  });
});
