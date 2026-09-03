import { describe, expect, it } from "vitest";

import { parseBlocks } from "@/lib/aggregators/blocks/parser";
import { EMBED_PROVIDERS, type Block, type InlineRun } from "@/lib/aggregators/blocks/types";

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

    // Verified in-tree before the fix: `canonicalRuns()` trimmed the edge run
    // *before* filtering empties, so when the trim emptied the last run and
    // dropped it, the run newly exposed at that edge (still carrying its own
    // trailing space) was never trimmed on this pass -- only on a second one.
    //   pass1 last run: "a b " (untrimmed)
    //   pass2 last run: "a b"
    //   IDEMPOTENT: false
    // This is the exact input that showed it, not a paraphrase of it: a
    // three-run paragraph whose last run is pure whitespace, so trimming it
    // empties it and exposes the italic run as the new edge.
    it("is idempotent even when trimming the edge empties a run and exposes a new edge", () => {
      const blocks: Block[] = [
        {
          kind: "paragraph",
          runs: [
            { text: "  b  c\nd", bold: true },
            { text: "a  b  ", italic: true },
            { text: "   " },
          ],
        },
      ];

      const once = canonicalBlocks(blocks);
      const twice = canonicalBlocks(once);

      expect(twice).toEqual(once);
      // And the fully-trimmed shape a single pass should now reach directly,
      // rather than needing the second pass the bug used to require.
      expect(once).toEqual([
        {
          kind: "paragraph",
          runs: [
            { text: "b c d", bold: true },
            { text: "a b", italic: true },
          ],
        },
      ]);
    });

    it("drops a paragraph and a heading that canonicalize to no runs at all", () => {
      const blocks: Block[] = [
        { kind: "paragraph", runs: [{ text: "   " }] },
        { kind: "heading", level: 2, runs: [] },
        { kind: "paragraph", runs: [{ text: "kept" }] },
      ];

      expect(canonicalBlocks(blocks)).toEqual([{ kind: "paragraph", runs: [{ text: "kept" }] }]);
    });

    it("drops a blockquote/summary whose content canonicalized away to nothing", () => {
      const blocks: Block[] = [
        { kind: "blockquote", blocks: [{ kind: "paragraph", runs: [{ text: "  " }] }] },
        { kind: "summary", blocks: [{ kind: "paragraph", runs: [] }] },
      ];

      expect(canonicalBlocks(blocks)).toEqual([]);
    });

    it("drops an empty list item rather than keeping it as a stray paragraph plus a shorter list", () => {
      // The measured consequence of *not* dropping this in canonicalBlocks:
      // the empty first item serialized to a marker line ("- ") that lost its
      // required trailing space to `.trim()` on the way back and read as a
      // literal paragraph "-", with the second item then starting its own
      // one-item list -- two blocks out of what should be one list.
      const blocks: Block[] = [
        {
          kind: "list",
          ordered: false,
          items: [
            [{ kind: "paragraph", runs: [] }],
            [{ kind: "paragraph", runs: [{ text: "b" }] }],
          ],
        },
      ];

      const canonical = canonicalBlocks(blocks);
      expect(canonical).toEqual([
        { kind: "list", ordered: false, items: [[{ kind: "paragraph", runs: [{ text: "b" }] }]] },
      ]);
      expect(roundTrip(blocks)).toMatchObject(canonical);
    });

    it("drops a whole list once every item canonicalizes to nothing", () => {
      const blocks: Block[] = [
        { kind: "list", ordered: false, items: [[{ kind: "paragraph", runs: [] }]] },
      ];

      expect(canonicalBlocks(blocks)).toEqual([]);
    });

    it("clamps a heading level to 1-6, matching what the notation can round-trip", () => {
      const blocks: Block[] = [{ kind: "heading", level: 7, runs: [{ text: "Too deep" }] }];

      const canonical = canonicalBlocks(blocks);
      expect(canonical).toEqual([{ kind: "heading", level: 6, runs: [{ text: "Too deep" }] }]);
      expect(roundTrip(blocks)).toMatchObject(canonical);
    });

    it("agrees with the round trip about the same image once canonicalized", () => {
      // Before the fix: `serializeBlocks` pushed the *raw* block into
      // `doc.opaque` while serializing a *canonicalized* caption into the
      // text -- so the placeholder and the caption a rewrite saw disagreed
      // about the same image's whitespace.
      const blocks: Block[] = [
        { kind: "image", ref: "yana-img://x", caption: [{ text: "  spaced   caption  " }] },
      ];

      const doc = blocksToText(blocks);
      expect(doc.opaque).toEqual([
        { kind: "image", ref: "yana-img://x", caption: [{ text: "spaced caption" }] },
      ]);
      expect(doc.text).toContain("spaced caption");
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

  describe("fuzz: the round trip holds over many random trees", () => {
    // A tiny deterministic PRNG (mulberry32) rather than Math.random(): the
    // whole point of a fuzz test living in the suite is that a failure is
    // reproducible from its seed alone, and a flaky one that fails once in a
    // blue moon on CI is worse than not having it -- nobody would trust it
    // enough to investigate a failure rather than hit retry.
    function mulberry32(seed: number): () => number {
      let a = seed >>> 0;
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function randInt(rng: () => number, min: number, max: number): number {
      return min + Math.floor(rng() * (max - min + 1));
    }

    function pick<T>(rng: () => number, items: readonly T[]): T {
      return items[randInt(rng, 0, items.length - 1)];
    }

    // Deliberately adversarial: internal runs of whitespace of varying width,
    // leading/trailing space, tabs and newlines (what `parseBlocks()` really
    // emits), the empty string (an empty run), the notation's own delimiters
    // and escape character, Markdown-emphasis-looking text, line-start
    // markers, unicode, and a run made entirely of whitespace.
    const ADVERSARIAL_TEXTS = [
      "plain word",
      "two  spaces",
      "  leading and trailing  ",
      "line\nbreak",
      "line\r\nbreak",
      "tab\ttab",
      "",
      "   ",
      "\n\n\n",
      "back\\slash",
      "brackets [like this]",
      "a [link](L0) shaped string",
      "a [[M0]] shaped string",
      "<b>fake tag</b>",
      "**not bold**",
      "~~not strike~~",
      "`not code`",
      "# not a heading",
      "- not a list item",
      "1. not an ordered item",
      "> not a quote",
      "emoji \u{1F600} party",
      "café", // combining accent
      "a".repeat(40),
    ] as const;

    const LINK_POOL = [
      "https://example.com/a",
      "https://example.com/b?x=1",
      "https://example.com/a", // deliberately repeated, to exercise shared links
    ] as const;

    const IMAGE_REFS = ["yana-img://aaaa", "yana-img://bbbb", "https://example.com/i.png"] as const;

    const CODE_TEXTS = [
      "const a = 1;",
      "line one\nline two",
      "\ttabbed\tcode",
      "  spaced   code  ",
      "",
    ] as const;

    function randomRun(rng: () => number): InlineRun {
      const hasLink = rng() < 0.3;
      return {
        text: pick(rng, ADVERSARIAL_TEXTS),
        bold: rng() < 0.3,
        italic: rng() < 0.3,
        code: rng() < 0.15,
        strikethrough: rng() < 0.15,
        link: hasLink ? pick(rng, LINK_POOL) : "",
      };
    }

    function randomRuns(rng: () => number, max: number): InlineRun[] {
      const count = randInt(rng, 0, max);
      return Array.from({ length: count }, () => randomRun(rng));
    }

    /** `summary` and `blockquote` share this "container of blocks" shape. */
    function randomContainerBlocks(rng: () => number, depth: number): Block[] {
      const count = randInt(rng, 0, 3);
      return Array.from({ length: count }, () => randomBlock(rng, depth - 1));
    }

    function randomBlock(rng: () => number, depth: number): Block {
      const leafKinds = [
        "paragraph",
        "heading",
        "image",
        "embed",
        "code_block",
        "divider",
      ] as const;
      const containerKinds = [...leafKinds, "list", "blockquote", "summary"] as const;
      const kind = pick(rng, depth > 0 ? containerKinds : leafKinds);

      switch (kind) {
        case "paragraph":
          return { kind: "paragraph", runs: randomRuns(rng, 4) };
        case "heading":
          // Deliberately ranges past 1-6 sometimes, to exercise the clamp.
          return { kind: "heading", level: randInt(rng, 1, 8), runs: randomRuns(rng, 3) };
        case "list": {
          const itemCount = randInt(rng, 1, 3);
          return {
            kind: "list",
            ordered: rng() < 0.5,
            items: Array.from({ length: itemCount }, () => randomContainerBlocks(rng, depth)),
          };
        }
        case "blockquote":
          return { kind: "blockquote", blocks: randomContainerBlocks(rng, depth) };
        case "summary":
          return { kind: "summary", blocks: randomContainerBlocks(rng, depth) };
        case "image":
          return { kind: "image", ref: pick(rng, IMAGE_REFS), caption: randomRuns(rng, 2) };
        case "embed":
          return {
            kind: "embed",
            provider: pick(rng, EMBED_PROVIDERS),
            externalUrl: pick(rng, LINK_POOL),
            thumbnailRef: pick(rng, IMAGE_REFS),
            title: pick(rng, ADVERSARIAL_TEXTS),
          };
        case "code_block":
          return {
            kind: "code_block",
            text: pick(rng, CODE_TEXTS),
            language: pick(rng, ["", "js"]),
          };
        case "divider":
          return { kind: "divider" };
      }
    }

    function randomTree(rng: () => number): Block[] {
      const count = randInt(rng, 1, 6);
      // Depth 2: one level of list-in-quote/quote-in-list nesting, plus a
      // leaf level below it -- enough to exercise nested lists and
      // quotes-in-lists without the tree size becoming unbounded.
      return Array.from({ length: count }, () => randomBlock(rng, 2));
    }

    /**
     * `summary` is a deliberate, documented exception to the round-trip
     * identity: `blocksToText()` writes it as a blockquote and it reads back
     * as one (see the note on that case in `serializeBlocks()`), because a
     * summary only ever exists as this module's own output, never its input.
     * So the tree this fuzzer compares the round trip against is
     * `canonicalBlocks(tree)` with every `summary` relabelled `blockquote` --
     * not a looser check, just the one documented divergence accounted for
     * before asserting everything else is exact.
     */
    function summaryToBlockquote(blocks: Block[]): Block[] {
      return blocks.map((block): Block => {
        switch (block.kind) {
          case "summary":
            return { kind: "blockquote", blocks: summaryToBlockquote(block.blocks) };
          case "blockquote":
            return { ...block, blocks: summaryToBlockquote(block.blocks) };
          case "list":
            return { ...block, items: block.items.map(summaryToBlockquote) };
          default:
            return block;
        }
      });
    }

    const SEED = 20260903;
    // 3,000 trees, each up to 6 top-level blocks and 2 levels of nesting,
    // runs in well under a second on this suite's own machine -- comfortably
    // inside the root `testTimeout` of 20s even alongside everything else in
    // this file, while still covering nested lists, quotes-in-lists,
    // summaries and adversarial run text many times over per run. Raise the
    // count if a regression here ever needs a wider net; this is not a
    // ceiling the module is tuned to.
    const CASE_COUNT = 3000;

    it(`is idempotent and round-trip-stable over ${CASE_COUNT} random trees (seed ${SEED})`, () => {
      const rng = mulberry32(SEED);

      for (let i = 0; i < CASE_COUNT; i++) {
        const tree = randomTree(rng);
        const describeCase = () => `case ${i}: ${JSON.stringify(tree)}`;

        const once = canonicalBlocks(tree);
        expect(canonicalBlocks(once), describeCase()).toEqual(once);

        const doc = blocksToText(tree);
        const { blocks: parsed } = textToBlocks(doc.text, doc);
        expect(parsed, describeCase()).toEqual(summaryToBlockquote(once));

        // Text stability: re-serializing what came back reproduces exactly
        // what was sent, which is what lets `run.ts`'s echo detection compare
        // the two texts directly rather than the trees.
        expect(blocksToText(parsed).text, describeCase()).toBe(doc.text);
      }
    });
  });
});
