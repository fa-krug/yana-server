import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CHROME_LABELS } from "../chrome-labels";
import { buildCommentsSection, type CommentSpec } from "./section";

interface Item {
  author: string;
  body: string;
  url: string;
}

function specFor(overrides: Partial<CommentSpec<Item[], Item>> = {}): CommentSpec<Item[], Item> {
  return {
    list: (source) => source,
    author: (c) => c.author,
    bodyHtml: (c) => c.body,
    anchorUrl: (c) => c.url,
    ...overrides,
  };
}

describe("buildCommentsSection", () => {
  it("returns null when the list is empty and no emptyLabel is set", () => {
    const html = buildCommentsSection(
      specFor(),
      [],
      "https://example.com#comments",
      5,
      DEFAULT_CHROME_LABELS,
    );

    expect(html).toBeNull();
  });

  it("shows the heading and the emptyLabel message when the list is empty and emptyLabel is set", () => {
    const html = buildCommentsSection(
      specFor({ emptyLabel: "noCommentsYet" }),
      [],
      "https://example.com#comments",
      5,
      DEFAULT_CHROME_LABELS,
    );

    expect(html).toBe(
      '<h3><a href="https://example.com#comments">Comments</a></h3>' +
        "<p><em>No comments yet.</em></p>",
    );
  });

  it("renders no heading link at all when sectionUrl is null", () => {
    const html = buildCommentsSection(
      specFor({ emptyLabel: "commentsDisabled" }),
      [],
      null,
      5,
      DEFAULT_CHROME_LABELS,
    );

    expect(html).toBe("<h3>Comments</h3><p><em>Comments disabled.</em></p>");
  });

  it("wraps the section in the configured tag and class", () => {
    const html = buildCommentsSection(
      specFor({ wrapTag: "div", wrapClass: "my-comments" }),
      [{ author: "Alex", body: "<p>hi</p>", url: "https://example.com/1" }],
      "https://example.com#comments",
      5,
      DEFAULT_CHROME_LABELS,
    );

    expect(html).toContain('<div class="my-comments"><h3>');
    expect(html).toContain("</div>");
  });

  it("sanitizes every comment body unconditionally, even when the caller forgets to", () => {
    const html = buildCommentsSection(
      specFor(),
      [
        {
          author: "Alex",
          body: '<script>alert(1)</script><p onclick="x()">hi</p>',
          url: "https://example.com/1",
        },
      ],
      "https://example.com#comments",
      5,
      DEFAULT_CHROME_LABELS,
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onclick");
  });

  it("slices to max before rendering", () => {
    const items: Item[] = Array.from({ length: 5 }, (_, i) => ({
      author: `author-${i}`,
      body: `body-${i}`,
      url: `https://example.com/${i}`,
    }));

    const html = buildCommentsSection(
      specFor(),
      items,
      "https://example.com#comments",
      2,
      DEFAULT_CHROME_LABELS,
    );

    expect(html).toContain("author-0");
    expect(html).toContain("author-1");
    expect(html).not.toContain("author-2");
  });

  it("logs via onLog and returns null when list() throws, instead of propagating", () => {
    const boom = new Error("selector exploded");
    const onLog = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const html = buildCommentsSection(
      specFor({
        list: () => {
          throw boom;
        },
      }),
      [],
      "https://example.com#comments",
      5,
      DEFAULT_CHROME_LABELS,
      onLog,
    );

    expect(html).toBeNull();
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onLog.mock.calls[0][0]).toContain("selector exploded");
    expect(onLog.mock.calls[0][0]).toContain("https://example.com#comments");
    warnSpy.mockRestore();
  });

  it("logs via onLog and returns null when rendering an item throws", () => {
    const onLog = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const html = buildCommentsSection(
      specFor({
        bodyHtml: () => {
          throw new Error("bad item");
        },
      }),
      [{ author: "Alex", body: "irrelevant", url: "https://example.com/1" }],
      "https://example.com#comments",
      5,
      DEFAULT_CHROME_LABELS,
      onLog,
    );

    expect(html).toBeNull();
    expect(onLog).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
