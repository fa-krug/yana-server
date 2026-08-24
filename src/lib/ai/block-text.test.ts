import { describe, expect, it } from "vitest";

import { parseBlocks } from "@/lib/aggregators/blocks/parser";
import type { Block } from "@/lib/aggregators/blocks/types";

import { blocksToText, canonicalBlocks, textToBlocks } from "./block-text";

/**
 * The one contract this module has to keep: a document it wrote, read back
 * unchanged, is the tree it started from.
 *
 * Everything else here is a property of that round trip, so the helper is the
 * test. `parseBlocks()` is the source of the trees rather than hand-built
 * literals, because hand-built ones drift from what the parser actually emits
 * (fully-populated runs, `link: ""` rather than absent) and would pass while
 * the real pairing broke.
 */
function roundTrip(blocks: Block[]): Block[] {
  const doc = blocksToText(blocks);
  return textToBlocks(doc.text, doc).blocks;
}

function fromHtml(html: string): Block[] {
  return parseBlocks(html, "https://example.com/a");
}

describe("blocksToText / textToBlocks", () => {
  describe("the round trip is the contract", () => {
    it.each([
      ["a paragraph", "<p>Hello there.</p>"],
      ["several paragraphs", "<p>One.</p><p>Two.</p><p>Three.</p>"],
      [
        "every inline style",
        "<p>Hello <b>bold</b> and <i>italic</i> and <code>code</code> and <s>strike</s>.</p>",
      ],
      ["nested styles", "<p><b>bold and <i>also italic</i></b> done.</p>"],
      ["every heading level", "<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h5>E</h5><h6>F</h6>"],
      ["an unordered list", "<ul><li>First</li><li>Second</li></ul>"],
      ["an ordered list", "<ol><li>Step one</li><li>Step two</li></ol>"],
      ["a blockquote", "<blockquote><p>A wise quote.</p></blockquote>"],
      ["a blockquote of two paragraphs", "<blockquote><p>One.</p><p>Two.</p></blockquote>"],
      ["a divider", "<p>Before.</p><hr><p>After.</p>"],
      ["a code block", "<pre><code>const a = 1;\nconst b = 2;</code></pre>"],
      ["a code block with a language", '<pre><code class="language-js">let x = 1;</code></pre>'],
      ["an image", '<p>Text.</p><img src="https://example.com/i.png">'],
      [
        "an image with a caption",
        '<figure><img src="https://example.com/i.png"><figcaption>The caption</figcaption></figure>',
      ],
      ["a link", '<p>See <a href="https://example.com/x">this page</a> for more.</p>'],
      [
        "two links to the same target",
        '<p><a href="https://example.com/x">one</a> and <a href="https://example.com/x">two</a></p>',
      ],
      ["a styled link", '<p><a href="https://example.com/x"><b>bold link</b></a></p>'],
      ["a heading followed by a list", "<h2>Title</h2><ul><li>a</li><li>b</li></ul>"],
      ["a list then a paragraph", "<ul><li>a</li></ul><p>After the list.</p>"],
      ["two adjacent lists", "<ul><li>a</li></ul><ol><li>b</li></ol>"],
    ])("survives %s", (_label, html) => {
      const blocks = fromHtml(html);
      expect(blocks.length).toBeGreaterThan(0);
      expect(roundTrip(blocks)).toEqual(canonicalBlocks(blocks));
    });

    it("survives a document with all of it at once", () => {
      const blocks = fromHtml(`
        <h1>Heading</h1>
        <p>Intro with a <a href="https://example.com/x">link</a> and <b>bold</b>.</p>
        <img src="https://example.com/lead.png">
        <ul><li>one</li><li>two with <i>italic</i></li></ul>
        <blockquote><p>Quoted.</p></blockquote>
        <pre><code class="language-ts">const x: number = 1;</code></pre>
        <hr>
        <p>Outro.</p>
      `);
      expect(blocks.length).toBeGreaterThan(6);
      expect(roundTrip(blocks)).toEqual(canonicalBlocks(blocks));
    });
  });

  describe("canonicalBlocks is the round trip's specification", () => {
    it("is idempotent, so it is a normal form rather than a transformation", () => {
      const blocks = fromHtml("<p>A  paragraph\nwith   odd   spacing.</p><p>a<span>b</span>c</p>");
      const once = canonicalBlocks(blocks);

      expect(canonicalBlocks(once)).toEqual(once);
    });

    it("collapses a newline inside a run instead of letting it split the paragraph", () => {
      // Measured on real pages before this existed: `parseBlocks()` leaves \n
      // in run text (HTML source line breaks, and its own table flattening),
      // and a line-oriented notation read those back as extra paragraphs -- a
      // 7-block article came back as 9.
      const blocks = fromHtml("<p>First line\nsecond line of the same paragraph.</p>");
      expect(blocks).toHaveLength(1);

      const back = roundTrip(blocks);

      expect(back).toHaveLength(1);
      expect(back).toEqual(canonicalBlocks(blocks));
      expect((back[0] as { runs: { text: string }[] }).runs[0].text).toBe(
        "First line second line of the same paragraph.",
      );
    });

    it("keeps whitespace inside a code run, where it is content", () => {
      const blocks = fromHtml("<p><code>a   b</code></p>");

      expect(canonicalBlocks(blocks)).toEqual(blocks);
      expect(roundTrip(blocks)).toEqual(blocks);
    });
  });

  describe("prose containing the notation's own characters", () => {
    it.each([
      ["asterisks", "<p>2 * 3 * 4 equals 24.</p>"],
      ["a bold-looking pair", "<p>He said **not bold** out loud.</p>"],
      ["backticks", "<p>Use the ` character carefully.</p>"],
      ["an angle bracket", "<p>If a &lt; b then stop.</p>"],
      ["a tag-looking string", "<p>The literal &lt;b&gt; typed out.</p>"],
      ["square brackets", "<p>An aside [like this] mid-sentence.</p>"],
      ["a link-looking string", "<p>See [text](L0) written literally.</p>"],
      ["a placeholder-looking string", "<p>The token [[M0]] typed by hand.</p>"],
      ["a backslash", "<p>A path like C:\\Users\\me here.</p>"],
      ["tildes", "<p>Roughly ~~ two of them.</p>"],
      ["a leading hash", "<p># not a heading</p>"],
      ["a leading dash", "<p>- not a list item</p>"],
      ["a leading angle bracket", "<p>&gt; not a quote</p>"],
      ["a leading number and dot", "<p>1. not an ordered item</p>"],
    ])("keeps %s literal", (_label, html) => {
      const blocks = fromHtml(html);
      expect(roundTrip(blocks)).toEqual(canonicalBlocks(blocks));
    });

    // Backticks are not delimiters in this notation -- a code run is `<code>`
    // tags -- so they are ordinary text inside one and need no escaping at all.
    it("keeps backticks inside a code span literal", () => {
      const blocks = fromHtml("<p><code>a ` b `` c</code></p>");
      expect(roundTrip(blocks)).toEqual(canonicalBlocks(blocks));
    });
  });

  describe("what the model never sees", () => {
    it("sends no URL, only an index", () => {
      const doc = blocksToText(
        fromHtml('<p><a href="https://tracker.example.com/x?utm=abc">click</a></p>'),
      );

      expect(doc.text).not.toContain("tracker.example.com");
      expect(doc.text).toContain("(L0)");
      expect(doc.links).toEqual(["https://tracker.example.com/x?utm=abc"]);
    });

    it("sends no image ref, embed data or code, only a placeholder", () => {
      const doc = blocksToText(
        fromHtml(
          '<img src="yana-img://deadbeef">' +
            "<pre><code>rm -rf /tmp/secret</code></pre>" +
            '<p><iframe src="https://www.youtube.com/embed/abc123"></iframe></p>',
        ),
      );

      expect(doc.text).not.toContain("yana-img://");
      expect(doc.text).not.toContain("rm -rf");
      expect(doc.text).not.toContain("youtube.com");
      // Code is not merely hidden -- it is not sent at all, which is both
      // cheaper and the only correct answer for a translation request.
      expect(doc.opaque.some((b) => b.kind === "code_block")).toBe(true);
      expect(doc.text).toMatch(/\[\[M\d+\]\]/);
    });

    it("does send an image caption, which is prose a rewrite should reach", () => {
      const doc = blocksToText(
        fromHtml(
          '<figure><img src="yana-img://x"><figcaption>A caption to translate</figcaption></figure>',
        ),
      );

      expect(doc.text).toContain("A caption to translate");
      expect(doc.text).not.toContain("yana-img://");
    });
  });

  describe("what the model is allowed to do: restructure", () => {
    const doc = () =>
      blocksToText(fromHtml('<p>First.</p><img src="yana-img://x"><p>Second.</p><p>Third.</p>'));

    it("accepts a different number of paragraphs than it was given", () => {
      const d = doc();
      const { blocks } = textToBlocks("One merged paragraph now.\n\n[[M0]]", d);

      expect(blocks).toEqual([
        {
          kind: "paragraph",
          runs: [expect.objectContaining({ text: "One merged paragraph now." })],
        },
        expect.objectContaining({ kind: "image" }),
      ]);
    });

    it("accepts blocks in a different order, media included", () => {
      const d = doc();
      const { blocks, droppedOpaque } = textToBlocks("[[M0]]\n\nMoved above the prose.", d);

      expect(blocks[0]).toMatchObject({ kind: "image" });
      expect(blocks[1]).toMatchObject({ kind: "paragraph" });
      expect(droppedOpaque).toEqual([]);
    });

    it("accepts structure the input never had", () => {
      const d = doc();
      const { blocks } = textToBlocks("## A heading it invented\n\n- and\n- a list", d);

      expect(blocks).toMatchObject([
        { kind: "heading", level: 2 },
        { kind: "list", ordered: false },
      ]);
    });
  });

  describe("what a mangled answer costs", () => {
    it("reports a dropped placeholder rather than losing it silently", () => {
      const d = blocksToText(fromHtml('<img src="yana-img://a"><p>Text.</p><hr>'));
      expect(d.opaque).toHaveLength(2);

      const { droppedOpaque } = textToBlocks("Text only.", d);

      // Silently losing an article's lead image looks exactly like an article
      // that never had one, so the caller is told.
      expect(droppedOpaque).toEqual([0, 1]);
    });

    it("drops a placeholder the model invented rather than throwing", () => {
      const d = blocksToText(fromHtml("<p>Text.</p>"));
      const { blocks } = textToBlocks("Text.\n\n[[M99]]", d);

      expect(blocks).toHaveLength(1);
    });

    it("keeps every word when a delimiter is left unmatched", () => {
      const d = blocksToText(fromHtml("<p>x</p>"));
      const { blocks } = textToBlocks("A **stray marker and *another one", d);

      // What a total parser owes: no throw, one block, and no prose lost.
      // Markdown emphasis is not notation here -- inline styling is `<b>`/`<i>`
      // tags precisely so that two adjacent styled runs cannot serialize to a
      // row of asterisks nobody can split the same way twice -- so these
      // asterisks come back as the literal characters the model wrote.
      expect(blocks).toHaveLength(1);
      const runs = (blocks[0] as { runs: { text: string }[] }).runs;
      const words = runs
        .map((r) => r.text)
        .join("")
        .replace(/[*]/g, "");
      expect(words).toBe("A stray marker and another one");
    });

    it("ignores a link index that does not resolve", () => {
      const d = blocksToText(fromHtml("<p>x</p>"));
      const { blocks } = textToBlocks("See [this](L42) page.", d);

      const runs = (blocks[0] as { runs: { text: string; link: string }[] }).runs;
      expect(runs.map((r) => r.text).join("")).toBe("See [this](L42) page.");
      expect(runs.every((r) => !r.link)).toBe(true);
    });
  });

  describe("size", () => {
    it("is a fraction of the HTML it replaces", () => {
      // The whole point. A link-dense document is the worst case for the HTML
      // form (every href billed twice) and the best case for this one (every
      // href replaced by two characters).
      const html =
        "<article>" +
        Array.from(
          { length: 30 },
          (_, i) =>
            `<p data-sanitized-class="paragraph body-text" data-sanitized-id="p${i}">` +
            `Sentence number ${i} with <a href="https://example.com/very/long/path/${i}?utm_source=feed">a link</a>.` +
            "</p>",
        ).join("") +
        "</article>";

      const blocks = fromHtml(html);
      const doc = blocksToText(blocks);

      expect(doc.text.length).toBeLessThan(html.length / 3);
      expect(roundTrip(blocks)).toEqual(canonicalBlocks(blocks));
    });
  });
});
