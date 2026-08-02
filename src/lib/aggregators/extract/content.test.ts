import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import {
  DEFAULT_CONTENT_SELECTORS,
  DEFAULT_IGNORE_SELECTORS,
  MANDATORY_REMOVE_SELECTORS,
  extractMainContent,
  extractMainContentIfPresent,
  selectContentElements,
} from "./content";

describe("content extraction", () => {
  it("exports standard selectors", () => {
    expect(MANDATORY_REMOVE_SELECTORS).toContain("script");
    expect(MANDATORY_REMOVE_SELECTORS).toContain("style");
    expect(DEFAULT_CONTENT_SELECTORS).toContain("article");
    expect(DEFAULT_IGNORE_SELECTORS).toContain(".advertisement");
  });

  describe("selectContentElements", () => {
    it("returns matching elements in document order and enforces outermost-wins", () => {
      const html = `
        <div class="container">
          <main id="main">
            <article class="article-content">
              <p>Inside article</p>
            </article>
          </main>
          <article class="standalone">
            <p>Standalone article</p>
          </article>
        </div>
      `;
      const $ = cheerio.load(html);
      const elements = selectContentElements($, ["main", ".article-content", "article"]);

      expect(elements.length).toBe(2);
      expect($(elements[0]).attr("id")).toBe("main");
      expect($(elements[1]).attr("class")).toBe("standalone");
    });

    it("respects firstMatchOnly option", () => {
      const html = `
        <article class="first"><p>First</p></article>
        <article class="second"><p>Second</p></article>
      `;
      const $ = cheerio.load(html);
      const elements = selectContentElements($, ["article"], true);

      expect(elements.length).toBe(1);
      expect($(elements[0]).attr("class")).toBe("first");
    });

    it("handles invalid selectors gracefully", () => {
      const html = `<article><p>Hello</p></article>`;
      const $ = cheerio.load(html);
      const elements = selectContentElements($, ["invalid[[selector", "article"]);

      expect(elements.length).toBe(1);
    });
  });

  describe("extractMainContentIfPresent", () => {
    it("returns null when no content selector matches", () => {
      const html = `<html><body><div class="sidebar">Nav</div></body></html>`;
      const result = extractMainContentIfPresent(html, ["article", ".entry"]);
      expect(result).toBeNull();
    });

    it("extracts matching content and removes mandatory and optional remove selectors", () => {
      const html = `
        <html>
          <body>
            <article>
              <script>alert(1);</script>
              <p>Article body</p>
              <div class="ad">Buy now!</div>
            </article>
          </body>
        </html>
      `;
      const result = extractMainContentIfPresent(html, ["article"], [".ad"]);
      expect(result).not.toBeNull();
      expect(result).not.toContain("<script>");
      expect(result).not.toContain("Buy now!");
      expect(result).toContain("<p>Article body</p>");
    });
  });

  describe("extractMainContent", () => {
    it("falls back to body when no content selector matches", () => {
      const html = `<html><body><script>var x=1;</script><p>Fallback content</p></body></html>`;
      const result = extractMainContent(html, ["article"]);
      expect(result).toContain("<body>");
      expect(result).toContain("<p>Fallback content</p>");
      expect(result).not.toContain("<script>");
    });

    it("returns extracted content when present", () => {
      const html = `
        <main>
          <p>Main content</p>
        </main>
      `;
      const result = extractMainContent(html, ["main"]);
      expect(result).toContain("<main>");
      expect(result).toContain("<p>Main content</p>");
    });
  });
});
