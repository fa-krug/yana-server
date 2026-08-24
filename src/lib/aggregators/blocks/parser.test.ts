import { describe, expect, it } from "vitest";
import { DEFAULT_CHROME_LABELS } from "../chrome-labels";
import { buildHeaderHtml } from "../extract/format";
import { isSafeUrl, parseBlocks, plainTextOf } from "./parser";
import type {
  Block,
  Blockquote,
  CodeBlock,
  EmbedBlock,
  Heading,
  ImageBlock,
  ListBlock,
  Paragraph,
  SummaryBlock,
} from "./types";

describe("isSafeUrl", () => {
  it("allows safe http, https, mailto, relative, and scheme-relative URLs", () => {
    expect(isSafeUrl("http://example.com")).toBe(true);
    expect(isSafeUrl("https://example.com/path?q=1")).toBe(true);
    expect(isSafeUrl("mailto:test@example.com")).toBe(true);
    expect(isSafeUrl("/relative/path")).toBe(true);
    expect(isSafeUrl("relative/path")).toBe(true);
    expect(isSafeUrl("//example.com/path")).toBe(true);
  });

  it("rejects dangerous or unsupported schemes", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeUrl("vbscript:msgbox")).toBe(false);
    expect(isSafeUrl("")).toBe(false);
  });
});

describe("parseBlocks", () => {
  it("returns empty array for empty or whitespace HTML", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("   \n  ")).toEqual([]);
  });

  it("parses paragraphs and inline styling", () => {
    const html = `<p>Hello <b>bold</b> and <i>italic</i> and <code>code</code> and <s>strike</s>.</p>`;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(1);
    const p = blocks[0] as Paragraph;
    expect(p.kind).toBe("paragraph");
    expect(p.runs).toEqual([
      { text: "Hello ", bold: false, italic: false, code: false, strikethrough: false, link: "" },
      { text: "bold", bold: true, italic: false, code: false, strikethrough: false, link: "" },
      { text: " and ", bold: false, italic: false, code: false, strikethrough: false, link: "" },
      { text: "italic", bold: false, italic: true, code: false, strikethrough: false, link: "" },
      { text: " and ", bold: false, italic: false, code: false, strikethrough: false, link: "" },
      { text: "code", bold: false, italic: false, code: true, strikethrough: false, link: "" },
      { text: " and ", bold: false, italic: false, code: false, strikethrough: false, link: "" },
      { text: "strike", bold: false, italic: false, code: false, strikethrough: true, link: "" },
      { text: ".", bold: false, italic: false, code: false, strikethrough: false, link: "" },
    ]);
  });

  it("resolves links against baseUrl and strips unsafe hrefs", () => {
    const html = `
      <p>
        <a href="article2.html">Safe relative</a>
        <a href="javascript:alert(1)">Unsafe script</a>
      </p>
    `;
    const blocks = parseBlocks(html, "https://example.com/blog/");
    expect(blocks).toHaveLength(1);
    const p = blocks[0] as Paragraph;
    expect(p.runs[0].link).toBe("https://example.com/blog/article2.html");
    expect(p.runs[2].link).toBe("");
  });

  describe("inline styling and links survive as a direct child of any container", () => {
    /**
     * The regression this covers: `inlineRuns()` reads a tag only while
     * descending *into* it, and `convert()` used to hand it an inline element
     * with no styling context -- so the element's own `<b>`/`<i>`/`<a href>`
     * was ignored. It worked in a `<p>` (that branch passes the paragraph, so
     * the styled tag is a child) and nowhere else.
     */
    const styleFlags = (blocks: Block[]) =>
      (JSON.stringify(blocks).match(/"(bold|italic|code|strikethrough)":true/g) || []).length;

    it.each([
      ["a list item", "<ul><li>a <b>x</b></li></ul>"],
      ["an ordered list item", "<ol><li>a <i>x</i></li></ol>"],
      ["a bare blockquote", "<blockquote>a <b>x</b></blockquote>"],
      ["a bare div", "<div>a <b>x</b></div>"],
      ["a paragraph, as it always did", "<p>a <b>x</b></p>"],
    ])("keeps styling inside %s", (_label, html) => {
      expect(styleFlags(parseBlocks(html, "https://example.com/"))).toBe(1);
    });

    it("keeps a link's href inside a list item", () => {
      // The more serious half: the href was dropped outright, so every
      // bulleted list of links in every article stored plain text.
      const blocks = parseBlocks(
        '<ul><li>See <a href="https://example.com/target">the docs</a> here</li></ul>',
        "https://example.com/",
      );

      const item = (blocks[0] as ListBlock).items[0][0] as Paragraph;
      expect(item.runs.map((r) => r.link)).toEqual(["", "https://example.com/target", ""]);
    });

    it("still refuses an unsafe href in that position", () => {
      // The fix routes through the same `resolveUrl`/`isSafeUrl` path as a
      // link in a paragraph, so it must not have opened a hole.
      const blocks = parseBlocks(
        '<ul><li><a href="javascript:alert(1)">x</a></li></ul>',
        "https://example.com/",
      );

      const item = (blocks[0] as ListBlock).items[0][0] as Paragraph;
      expect(item.runs.every((r) => r.link === "")).toBe(true);
    });

    it("combines an element's own styling with its children's", () => {
      const blocks = parseBlocks(
        '<ul><li><a href="https://example.com/z"><b>bold link</b></a></li></ul>',
        "https://example.com/",
      );

      const item = (blocks[0] as ListBlock).items[0][0] as Paragraph;
      expect(item.runs[0]).toMatchObject({
        text: "bold link",
        bold: true,
        link: "https://example.com/z",
      });
    });
  });

  it("parses headings h1-h6", () => {
    const html = `<h1>Title 1</h1><h2>Title 2</h2><h3>Title 3</h3><h4>Title 4</h4><h5>Title 5</h5><h6>Title 6</h6>`;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(6);
    expect(blocks.map((b) => (b as Heading).level)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("parses unordered and ordered lists", () => {
    const html = `
      <ul>
        <li>First bullet</li>
        <li>Second bullet</li>
      </ul>
      <ol>
        <li>Step 1</li>
        <li>Step 2</li>
      </ol>
    `;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(2);

    const ul = blocks[0] as ListBlock;
    expect(ul.kind).toBe("list");
    expect(ul.ordered).toBe(false);
    expect(ul.items).toHaveLength(2);

    const ol = blocks[1] as ListBlock;
    expect(ol.kind).toBe("list");
    expect(ol.ordered).toBe(true);
    expect(ol.items).toHaveLength(2);
  });

  it("parses blockquotes", () => {
    const html = `<blockquote><p>A wise quote.</p></blockquote>`;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(1);
    const bq = blocks[0] as Blockquote;
    expect(bq.kind).toBe("blockquote");
    expect(bq.blocks).toHaveLength(1);
    expect((bq.blocks[0] as Paragraph).runs[0].text).toBe("A wise quote.");
  });

  it("parses the AI summary's section into a summary block of its own", () => {
    const html = `<section data-sanitized-class="yana-ai-summary"><p>The gist.</p></section>`;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(1);
    const summary = blocks[0] as SummaryBlock;
    expect(summary.kind).toBe("summary");
    expect((summary.blocks[0] as Paragraph).runs[0].text).toBe("The gist.");
  });

  it("recognizes the summary by an unsanitized class too, as the aggregation path emits it", () => {
    const html = `<section class="yana-ai-summary"><p>One.</p><p>Two.</p></section>`;
    const blocks = parseBlocks(html);
    // Two paragraphs of prose stay inside the one summary block rather than
    // pushing the article down the document.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "summary",
      blocks: [{ kind: "paragraph" }, { kind: "paragraph" }],
    });
  });

  it("drops an empty summary section rather than emitting a childless block", () => {
    expect(parseBlocks(`<section data-sanitized-class="yana-ai-summary">   </section>`)).toEqual(
      [],
    );
  });

  it("preserves code block whitespace verbatim in pre tags", () => {
    const html = `<pre><code>function add(a, b) {\n  return a + b;\n}</code></pre>`;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(1);
    const code = blocks[0] as CodeBlock;
    expect(code.kind).toBe("code_block");
    expect(code.text).toBe("function add(a, b) {\n  return a + b;\n}");
  });

  it("extracts the language from a language- class on pre > code", () => {
    const blocks = parseBlocks(`<pre><code class="language-ts">const x = 1;</code></pre>`);
    expect(blocks).toHaveLength(1);
    const code = blocks[0] as CodeBlock;
    expect(code.kind).toBe("code_block");
    expect(code.language).toBe("ts");
  });

  it("accepts the short lang- prefix and ignores unrelated classes", () => {
    const blocks = parseBlocks(`<pre><code class="hljs lang-python numbered">x = 1</code></pre>`);
    const code = blocks[0] as CodeBlock;
    expect(code.language).toBe("python");
  });

  it("leaves language empty when pre has no code class", () => {
    const blocks = parseBlocks(`<pre><code>plain</code></pre>`);
    expect((blocks[0] as CodeBlock).language).toBe("");

    const bare = parseBlocks(`<pre>no code element</pre>`);
    expect((bare[0] as CodeBlock).language).toBe("");
  });

  it("parses divider hr tags", () => {
    const html = `<p>Before</p><hr><p>After</p>`;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(3);
    expect(blocks[1].kind).toBe("divider");
  });

  it("flattens table rows into paragraphs separated by em dash and bolds th headers", () => {
    const html = `
      <table>
        <tr><th>Header 1</th><th>Header 2</th></tr>
        <tr><td>Data 1</td><td>Data 2</td></tr>
      </table>
    `;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(2);

    const row1 = blocks[0] as Paragraph;
    expect(row1.runs.map((r) => r.text)).toEqual(["Header 1", " — ", "Header 2"]);
    expect(row1.runs[0].bold).toBe(true);
    expect(row1.runs[2].bold).toBe(true);

    const row2 = blocks[1] as Paragraph;
    expect(row2.runs.map((r) => r.text)).toEqual(["Data 1", " — ", "Data 2"]);
    expect(row2.runs[0].bold).toBe(false);
  });

  it("parses image blocks and lazy load attributes", () => {
    const html = `<img data-lazy-src="image.png" alt="Test Image">`;
    const blocks = parseBlocks(html, "https://example.com/");
    expect(blocks).toHaveLength(1);
    const img = blocks[0] as ImageBlock;
    expect(img.kind).toBe("image");
    expect(img.ref).toBe("https://example.com/image.png");
  });

  it("attaches figcaption to figure image caption", () => {
    const html = `
      <figure>
        <img src="photo.jpg">
        <figcaption>Photo caption text</figcaption>
      </figure>
    `;
    const blocks = parseBlocks(html, "https://example.com/");
    expect(blocks).toHaveLength(1);
    const img = blocks[0] as ImageBlock;
    expect(img.kind).toBe("image");
    expect(img.caption).toEqual([
      {
        text: "Photo caption text",
        bold: false,
        italic: false,
        code: false,
        strikethrough: false,
        link: "",
      },
    ]);
  });

  it("parses video embeds", () => {
    const html = `<video src="https://example.com/video.mp4" poster="https://example.com/poster.jpg"></video>`;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(1);
    const embed = blocks[0] as EmbedBlock;
    expect(embed.kind).toBe("embed");
    expect(embed.provider).toBe("video");
    expect(embed.externalUrl).toBe("https://example.com/video.mp4");
    expect(embed.thumbnailRef).toBe("https://example.com/poster.jpg");
  });

  it("parses YouTube embed facades", () => {
    const html = `<div class="youtube-embed" data-embed="https://www.youtube.com/watch?v=dQw4w9WgXcQ"><img src="thumb.jpg"></div>`;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(1);
    const embed = blocks[0] as EmbedBlock;
    expect(embed.kind).toBe("embed");
    expect(embed.provider).toBe("youtube");
    expect(embed.externalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(embed.thumbnailRef).toBe("thumb.jpg");
  });

  it("parses tweet embeds from blockquotes", () => {
    const html = `
      <blockquote class="twitter-tweet">
        <p>This is a tweet</p>
        <a href="https://twitter.com/jack/status/20">View on X</a>
      </blockquote>
    `;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(1);
    const embed = blocks[0] as EmbedBlock;
    expect(embed.kind).toBe("embed");
    expect(embed.provider).toBe("tweet");
    expect(embed.externalUrl).toBe("https://twitter.com/jack/status/20");
    expect(embed.title).toBe("This is a tweet View on X");
  });

  it("drops image blocks from header tags", () => {
    const html = `<header><img src="hero.jpg"><p>Article Headline</p></header>`;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("paragraph");
    expect((blocks[0] as Paragraph).runs[0].text).toBe("Article Headline");
  });

  it("keeps the image in a media-header -- TagesschauAggregator's own header, not decorative chrome", () => {
    // Unlike a generic article-body <header> (a byline, a date, sometimes a
    // site logo -- decorative, correctly dropped above), `media-header` is
    // TagesschauAggregator's convention for the header image or video poster
    // it deliberately built (see extractMediaHeader() in
    // sites/tagesschau/media.ts). Dropping it here silently threw away an
    // image the aggregator had already fetched and stored.
    const html = `<header class="media-header"><div class="media-image"><img src="yana-img://${"a".repeat(64)}"></div></header>`;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("image");
  });

  it("keeps the lead image built by buildHeaderHtml() -- every generic full-website aggregator's header, not decorative chrome", () => {
    // FullWebsiteAggregator.processContent() (and every site aggregator that
    // reuses it -- Ars Technica, Heise, mactechnews, mein_mmo, reddit,
    // podcast) builds its lead image via buildHeaderHtml() in extract/format.ts
    // and hands the result straight to parseBlocks() as the article's raw
    // content. That header must survive here, or every one of those sites
    // shows no header image in the reading view.
    const html = buildHeaderHtml(
      DEFAULT_CHROME_LABELS,
      `yana-img://${"a".repeat(64)}`,
      "Headline",
    )!;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("image");
  });

  it("ignores dropped tags like script, style, and form", () => {
    const html = `<script>alert('xss')</script><style>body { color: red; }</style><p>Surviving text</p>`;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as Paragraph).runs[0].text).toBe("Surviving text");
  });
});

describe("plainTextOf", () => {
  it("flattens blocks into search plain text separated by blank lines", () => {
    const blocks = parseBlocks(`
      <h1>Heading Title</h1>
      <p>Paragraph text with <b>bold</b> words.</p>
      <ul>
        <li>Item one</li>
        <li>Item two</li>
      </ul>
      <pre><code>const code = true;</code></pre>
      <figure>
        <img src="photo.jpg">
        <figcaption>Image caption</figcaption>
      </figure>
    `);

    const text = plainTextOf(blocks);
    expect(text).toBe(
      "Heading Title\n\nParagraph text with bold words.\n\nItem one\n\nItem two\n\nconst code = true;\n\nImage caption",
    );
  });
});
