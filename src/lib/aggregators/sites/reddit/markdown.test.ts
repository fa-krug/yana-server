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

describe("convertRedditMarkdown backslash escapes", () => {
  it("renders an escaped list marker as a literal dash", () => {
    const html = convertRedditMarkdown("\\- sonic racing crossworlds");
    expect(html).toBe("<p>- sonic racing crossworlds</p>");
  });

  it("keeps escaped dashes out of a list", () => {
    const html = convertRedditMarkdown("\\- one\n\\- two");
    expect(html).not.toContain("<ul>");
    expect(html).not.toContain("\\");
  });

  it("still builds a list from unescaped dashes", () => {
    expect(convertRedditMarkdown("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
  });

  // The whole of CommonMark's escapable set, so the character class cannot
  // drift out of agreement with the set Reddit's editor actually escapes.
  const ESCAPABLE = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
  const AS_ENTITY: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  it.each([...ESCAPABLE])("unescapes %s", (char) => {
    // Reddit's `body` is HTML-escaped, so the five characters escapeHtml()
    // touches arrive as entities rather than as themselves. Only three of them
    // come back out as entities: cheerio, which serializes the finished
    // markup, leaves a quote in text content as itself.
    const escaped = `\\${AS_ENTITY[char] ?? char}`;
    const rendered = char.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = convertRedditMarkdown(`before${escaped}after`);

    expect(html).toBe(`<p>before${rendered}after</p>`);
  });

  it("leaves a backslash before a character markdown never escapes", () => {
    expect(convertRedditMarkdown("\\d+ matches")).toContain("\\d+ matches");
    expect(convertRedditMarkdown("\\1. not a list")).toContain("\\1. not a list");
  });

  it("stops an escaped character from being read as syntax", () => {
    expect(convertRedditMarkdown("\\*not italic\\*")).toBe("<p>*not italic*</p>");
    expect(convertRedditMarkdown("\\^caret")).not.toContain("<sup>");
    expect(convertRedditMarkdown("\\~~not struck~~")).not.toContain("<del>");
    expect(convertRedditMarkdown("\\#not a heading")).not.toContain("<h1>");
    // The bare URL is still autolinked, exactly as Reddit does it -- what the
    // escape has to prevent is the label becoming the link's text.
    expect(convertRedditMarkdown("\\[label\\](http://example.com)")).not.toContain(">label</a>");
  });

  it("does not read an escaped quote marker as a quote", () => {
    const html = convertRedditMarkdown("\\&gt;not quoted");
    expect(html).not.toContain("<blockquote>");
    expect(html).toBe("<p>&gt;not quoted</p>");
  });

  it("resolves an escape that arrived as an HTML entity", () => {
    expect(convertRedditMarkdown("5 \\&lt; 10 at AT\\&amp;T")).toBe("<p>5 &lt; 10 at AT&amp;T</p>");
  });

  it("turns an escaped backslash into one literal backslash", () => {
    expect(convertRedditMarkdown("C:\\\\Users")).toBe("<p>C:\\Users</p>");
  });

  it("leaves backslashes inside a code span alone", () => {
    expect(convertRedditMarkdown("match `\\d+` and `\\.` here")).toContain(
      "<code>\\d+</code> and <code>\\.</code>",
    );
  });

  it("leaves backslashes inside a fenced block alone", () => {
    const html = convertRedditMarkdown("```\nsed 's/a\\-b/c/'\n```");
    expect(html).toContain("sed 's/a\\-b/c/'");
  });

  it("resolves escapes in the paragraph after an unclosed fence", () => {
    const html = convertRedditMarkdown("```\ncode \\- here\n\nafter \\- here");
    expect(html).toContain("code \\- here");
    expect(html).toContain("after - here");
  });

  it("drops the backslash of a hard line break", () => {
    const html = convertRedditMarkdown("line one\\\nline two");
    expect(html).not.toContain("\\");
    expect(html).toContain("<br>");
  });

  it("keeps an escaped character out of the href it sits in", () => {
    const html = convertRedditMarkdown("[label](http://example.com/a\\_b)");
    expect(html).toContain('href="http://example.com/a_b"');
  });

  it("drops a placeholder character forged in the source", () => {
    // The escape survives the pipeline as a Private Use Area character; one
    // typed by a commenter would otherwise be indistinguishable from it.
    const html = convertRedditMarkdown("a\uE03Cb\uE026c");
    expect(html).toBe("<p>abc</p>");
  });

  it("unescapes for a direct markdownToHtml caller too", () => {
    expect(markdownToHtml("\\- literal")).toBe("<p>- literal</p>");
  });
});
