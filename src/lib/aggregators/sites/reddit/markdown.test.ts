import { describe, expect, it } from "vitest";
import { convertRedditMarkdown, markdownToHtml } from "./markdown";

describe("markdownToHtml tables", () => {
  it("converts a GFM table into an HTML table", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    const html = markdownToHtml(md);

    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<th>B</th>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<td>4</td>");
    expect(html).toContain("</table>");
  });

  it("applies inline emphasis inside table cells", () => {
    const md = "| A |\n| --- |\n| **bold** |";
    const html = markdownToHtml(md);
    expect(html).toContain("<strong>bold</strong>");
  });

  it("still renders a plain paragraph containing a pipe character as a paragraph", () => {
    const html = markdownToHtml("just a | pipe, not a table");
    expect(html).not.toContain("<table>");
    expect(html).toContain("<p>");
  });
});

describe("markdownToHtml block quotes", () => {
  it("quotes a line whose marker has no space after it", () => {
    const html = markdownToHtml(">Fading Echo is coming to Nintendo Switch 2 in 2026!");
    expect(html).toBe(
      "<blockquote><p>Fading Echo is coming to Nintendo Switch 2 in 2026!</p></blockquote>",
    );
  });

  it("keeps each quoted paragraph its own quote", () => {
    const html = markdownToHtml(">first\n\n>second\n\nplain");
    expect(html).toBe(
      "<blockquote><p>first</p></blockquote>\n<blockquote><p>second</p></blockquote>\n<p>plain</p>",
    );
  });

  it("applies inline markdown inside a quote", () => {
    expect(markdownToHtml("> **bold**")).toContain("<strong>bold</strong>");
  });

  it("nests a quote inside a quote", () => {
    const html = markdownToHtml("> outer\n> > inner");
    expect(html).toBe(
      "<blockquote><p>outer</p>\n<blockquote><p>inner</p></blockquote></blockquote>",
    );
  });

  it("nests a quote whose markers carry no spaces", () => {
    const html = markdownToHtml(">outer\n>>inner\n>>>deepest");
    expect(html).toBe(
      "<blockquote><p>outer</p>\n<blockquote><p>inner</p>\n" +
        "<blockquote><p>deepest</p></blockquote></blockquote></blockquote>",
    );
  });

  it("quotes lines that follow leading paragraph text in the same block", () => {
    const html = markdownToHtml("Look at this:\n>quoted");
    expect(html).toBe("<p>Look at this:</p>\n<blockquote><p>quoted</p></blockquote>");
  });

  it("leaves a spoiler marker alone", () => {
    const html = markdownToHtml(">!secret!<");
    expect(html).not.toContain("<blockquote>");
  });
});

describe("convertRedditMarkdown escaped quote markers", () => {
  it("quotes a line whose marker arrived HTML-escaped from the Reddit API", () => {
    const html = convertRedditMarkdown("&gt;Fading Echo is coming to Nintendo Switch 2 in 2026!");
    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("&gt;Fading");
  });

  it("nests escaped markers the same way as literal ones", () => {
    const html = convertRedditMarkdown("&gt;outer\n&gt;&gt;inner");
    expect(html).toBe(
      "<blockquote><p>outer</p>\n<blockquote><p>inner</p></blockquote></blockquote>",
    );
  });

  it("leaves an escaped marker inside a line as text", () => {
    const html = convertRedditMarkdown("five &gt; four");
    expect(html).not.toContain("<blockquote>");
    expect(html).toContain("&gt; four");
  });
});

describe("convertRedditMarkdown zero-width-space entity", () => {
  it("removes the standalone paragraph-spacer entity", () => {
    const html = convertRedditMarkdown("Paragraph one.\n\n&#x200B;\n\nParagraph two.");
    expect(html).not.toContain("&#x200B;");
    expect(html).not.toContain("&amp;#x200B;");
  });

  it("removes the entity when it appears inside a code span", () => {
    const html = convertRedditMarkdown("Here is `code&#x200B;span` example.");
    expect(html).not.toContain("&#x200B;");
    expect(html).not.toContain("&amp;#x200B;");
  });

  it("removes a literal zero-width space character", () => {
    const html = convertRedditMarkdown("before​after");
    expect(html).not.toContain("​");
  });
});
