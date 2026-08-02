import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import {
  cleanDataAttributes,
  cleanHtml,
  getBaseFilename,
  removeEmptyElements,
  removeImageByUrl,
  removeSanitizedAttributes,
  removeSelectors,
  sanitizeClassNames,
  sanitizeHtmlAttributes,
} from "./clean";

describe("HTML cleaning utilities", () => {
  describe("getBaseFilename", () => {
    it("removes extensions and responsive variant suffixes", () => {
      expect(getBaseFilename("image-780x438.jpg")).toBe("image");
      expect(getBaseFilename("image-1280x720-1.jpg")).toBe("image");
      expect(getBaseFilename("image-1280x720-1-780x438.jpg")).toBe("image");
      expect(getBaseFilename("image.jpg")).toBe("image");
      expect(getBaseFilename("photo-1Wef.png")).toBe("photo");
    });
  });

  describe("cleanHtml", () => {
    it("removes HTML comments", () => {
      const html = "<!-- top comment --><div><p>Hello<!-- inner comment --></p></div>";
      const cleaned = cleanHtml(html);
      expect(cleaned).not.toContain("<!--");
      expect(cleaned).toContain("<p>Hello</p>");
    });
  });

  describe("removeSelectors", () => {
    it("removes elements matching selectors", () => {
      const $ = cheerio.load("<div class='ad'>Ad</div><p>Content</p>");
      removeSelectors($, [".ad"]);
      expect($.html()).not.toContain("Ad");
      expect($.html()).toContain("<p>Content</p>");
    });
  });

  describe("removeEmptyElements", () => {
    it("removes empty paragraphs but preserves those with media", () => {
      const $ = cheerio.load(`
        <p></p>
        <p>   </p>
        <p><img src="test.jpg"></p>
        <p>Text</p>
      `);
      removeEmptyElements($, ["p"]);
      expect($("p").length).toBe(2);
      expect($.html()).toContain("test.jpg");
      expect($.html()).toContain("Text");
    });
  });

  describe("cleanDataAttributes", () => {
    it("removes non-kept data attributes", () => {
      const $ = cheerio.load('<img src="a.jpg" data-src="b.jpg" data-tracking="123" data-custom="xyz">');
      cleanDataAttributes($);
      expect($("img").attr("data-src")).toBe("b.jpg");
      expect($("img").attr("data-tracking")).toBeUndefined();
      expect($("img").attr("data-custom")).toBeUndefined();
    });
  });

  describe("removeImageByUrl", () => {
    it("removes image by exact URL", () => {
      const $ = cheerio.load('<div><img src="https://example.com/hero.jpg"><img src="https://example.com/other.jpg"></div>');
      removeImageByUrl($, "https://example.com/hero.jpg");
      expect($("img").length).toBe(1);
      expect($("img").attr("src")).toBe("https://example.com/other.jpg");
    });

    it("removes image by filename match", () => {
      const $ = cheerio.load('<div><img src="/assets/hero_banner.jpg"></div>');
      removeImageByUrl($, "https://cdn.example.com/uploads/hero_banner.jpg");
      expect($("img").length).toBe(0);
    });

    it("removes image by responsive variant suffix match", () => {
      const $ = cheerio.load('<div><img src="https://example.com/hero_banner-780x438.jpg"></div>');
      removeImageByUrl($, "https://example.com/hero_banner.jpg");
      expect($("img").length).toBe(0);
    });

    it("ignores generic image names for loose matching", () => {
      const $ = cheerio.load('<div><img src="https://example.com/path1/image.jpg"></div>');
      removeImageByUrl($, "https://example.com/path2/image.jpg");
      expect($("img").length).toBe(1);
    });
  });

  describe("sanitizeClassNames", () => {
    it("moves class attributes to data-sanitized-class", () => {
      const $ = cheerio.load('<div class="main-header flex">Header</div>');
      sanitizeClassNames($);
      expect($("div").attr("class")).toBeUndefined();
      expect($("div").attr("data-sanitized-class")).toBe("main-header flex");
    });
  });

  describe("sanitizeHtmlAttributes", () => {
    it("strips dangerous elements and sanitizes attributes", () => {
      const $ = cheerio.load(`
        <div id="hero" class="box" style="color:red;" onclick="alert(1)" data-foo="bar" data-src="img.jpg">
          <script>console.log(1);</script>
          <iframe src="frame.html"></iframe>
          <p>Text</p>
        </div>
      `);
      sanitizeHtmlAttributes($);
      expect($.html()).not.toContain("<script>");
      expect($.html()).not.toContain("<iframe>");
      expect($("div").attr("onclick")).toBeUndefined();
      expect($("div").attr("id")).toBeUndefined();
      expect($("div").attr("class")).toBeUndefined();
      expect($("div").attr("style")).toBeUndefined();
      expect($("div").attr("data-foo")).toBeUndefined();
      expect($("div").attr("data-sanitized-id")).toBe("hero");
      expect($("div").attr("data-sanitized-class")).toBe("box");
      expect($("div").attr("data-sanitized-style")).toBe("color:red;");
      expect($("div").attr("data-sanitized-foo")).toBe("bar");
      expect($("div").attr("data-src")).toBe("img.jpg");
    });
  });

  describe("removeSanitizedAttributes", () => {
    it("removes all data-sanitized-* attributes", () => {
      const $ = cheerio.load('<div data-sanitized-class="box" data-sanitized-id="hero" title="Header">Text</div>');
      removeSanitizedAttributes($);
      expect($("div").attr("data-sanitized-class")).toBeUndefined();
      expect($("div").attr("data-sanitized-id")).toBeUndefined();
      expect($("div").attr("title")).toBe("Header");
    });
  });
});
