import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./markdown";

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
