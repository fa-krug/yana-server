import { describe, expect, it } from "vitest";
import {
  buildDailymotionFacadeHtml,
  buildHeaderHtml,
  escapeHtml,
  extractYoutubeVideoId,
  formatArticleContent,
} from "./format";

describe("content format utilities", () => {
  describe("escapeHtml", () => {
    it("escapes quotes, ampersands, and angle brackets", () => {
      expect(escapeHtml('<script alert="xss">&</script>')).toBe(
        "&lt;script alert=&quot;xss&quot;&gt;&amp;&lt;/script&gt;"
      );
    });
  });

  describe("extractYoutubeVideoId", () => {
    it("extracts ID from standard watch and short URLs", () => {
      expect(extractYoutubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
        "dQw4w9WgXcQ"
      );
      expect(extractYoutubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
      expect(extractYoutubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(
        "dQw4w9WgXcQ"
      );
    });
  });

  describe("buildDailymotionFacadeHtml", () => {
    it("builds dailymotion facade HTML container", () => {
      const html = buildDailymotionFacadeHtml("x81234");
      expect(html).toContain('class="dailymotion-embed-container"');
      expect(html).toContain('data-embed="https://www.dailymotion.com/embed/video/x81234"');
      expect(html).toContain('href="https://www.dailymotion.com/video/x81234"');
    });
  });

  describe("buildHeaderHtml", () => {
    it("returns null when headerImageUrl is null or empty", () => {
      expect(buildHeaderHtml(null, "Title")).toBeNull();
      expect(buildHeaderHtml("", "Title")).toBeNull();
    });

    it("builds Youtube video header when URL is Youtube", () => {
      const header = buildHeaderHtml("https://youtu.be/dQw4w9WgXcQ", "Title");
      expect(header).not.toBeNull();
      expect(header).toContain('<header style="margin-bottom: 1.5em; text-align: center;">');
      expect(header).toContain('data-embed="https://www.youtube.com/embed/dQw4w9WgXcQ"');
    });

    it("builds image header with escaped attributes and optional caption", () => {
      const header = buildHeaderHtml(
        "https://example.com/img.jpg?a=1&b=2",
        'My "Title"',
        "<figcaption>Photo credit</figcaption>"
      );
      expect(header).not.toBeNull();
      expect(header).toContain('src="https://example.com/img.jpg?a=1&amp;b=2"');
      expect(header).toContain('alt="My &quot;Title&quot;"');
      expect(header).toContain("<figcaption>Photo credit</figcaption>");
    });
  });

  describe("formatArticleContent", () => {
    it("formats article content with header and sections", () => {
      const formatted = formatArticleContent(
        "<p>Hello world</p>",
        "My Article",
        "https://example.com/art",
        "https://example.com/header.jpg",
        null,
        "<p>Comment 1</p>"
      );

      expect(formatted).toContain("<header");
      expect(formatted).toContain(
        '<section data-sanitized-class="article-content"><p>Hello world</p></section>'
      );
      expect(formatted).toContain(
        '<section data-sanitized-class="article-comments"><p>Comment 1</p></section>'
      );
    });

    it("uses pre-built headerHtml when provided", () => {
      const customHeader = "<header>Custom Header</header>";
      const formatted = formatArticleContent(
        "<p>Content</p>",
        "Title",
        "https://example.com",
        "https://example.com/img.jpg",
        null,
        null,
        customHeader
      );

      expect(formatted).toContain("<header>Custom Header</header>");
    });
  });
});
