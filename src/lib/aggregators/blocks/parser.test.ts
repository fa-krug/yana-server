import { describe, expect, it } from "vitest";
import { isSafeUrl, parseBlocks, plainTextOf } from "./parser";
import type {
  Blockquote,
  CodeBlock,
  EmbedBlock,
  Heading,
  ImageBlock,
  ListBlock,
  Paragraph,
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

  it("preserves code block whitespace verbatim in pre tags", () => {
    const html = `<pre><code>function add(a, b) {\n  return a + b;\n}</code></pre>`;
    const blocks = parseBlocks(html);
    expect(blocks).toHaveLength(1);
    const code = blocks[0] as CodeBlock;
    expect(code.kind).toBe("code_block");
    expect(code.text).toBe("function add(a, b) {\n  return a + b;\n}");
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
