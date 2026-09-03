import { describe, expect, it } from "vitest";

import { DEFAULT_CHROME_LABELS } from "../../chrome-labels";
import { extractComments } from "./comments";

const GERMAN_LABELS = {
  ...DEFAULT_CHROME_LABELS,
  comments: "Kommentare",
  source: "Quelle",
};

function pageWithOneComment(): string {
  return `
    <div class="MtnCommentScroll">
      <div class="MtnComment" id="comment-1">
        <span class="MtnCommentAccountName">Alex</span>
        <span class="MtnCommentTime"><span>2026-01-01</span></span>
        <div class="MtnCommentText"><p>Nice article!</p></div>
      </div>
    </div>
  `;
}

function pageWithAnonymousComment(): string {
  return `
    <div class="MtnCommentScroll">
      <div class="MtnComment" id="comment-1">
        <div class="MtnCommentText"><p>Nice article!</p></div>
      </div>
    </div>
  `;
}

describe("extractComments", () => {
  it("renders the Comments heading and source link in English by default", () => {
    const html = extractComments(
      pageWithOneComment(),
      "https://mactechnews.de/a",
      5,
      DEFAULT_CHROME_LABELS,
    );

    expect(html).toContain(">Comments</a></h3>");
    expect(html).toContain(">source</a>");
  });

  it("renders the Comments heading and source link in the passed-in locale's labels", () => {
    const html = extractComments(
      pageWithOneComment(),
      "https://mactechnews.de/a",
      5,
      GERMAN_LABELS,
    );

    expect(html).toContain(">Kommentare</a></h3>");
    expect(html).toContain(">Quelle</a>");
    expect(html).not.toContain("Comments");
    expect(html).not.toContain(">source<");
  });

  it("falls back to the locale's unknownAuthor label when no author element is found", () => {
    const html = extractComments(pageWithAnonymousComment(), "https://mactechnews.de/a", 5, {
      ...DEFAULT_CHROME_LABELS,
      unknownAuthor: "Unbekannt",
    });

    expect(html).toContain("<strong>Unbekannt</strong>");
  });

  // Characterisation pin (2026-09-03 pipeline-review-3 Task 2): the exact
  // byte output of today's implementation, captured before the shared
  // `buildCommentsSection()` consolidation, so the refactor cannot silently
  // change the nesting, the timestamp format or the section wrapper.
  it("pins the exact section markup for a single dated comment", () => {
    const html = extractComments(
      pageWithOneComment(),
      "https://mactechnews.de/a",
      5,
      DEFAULT_CHROME_LABELS,
    );

    expect(html).toBe(
      '<section><h3><a href="https://mactechnews.de/a#comments">Comments</a></h3>' +
        "<blockquote><p><strong>Alex</strong> (2026-01-01) | " +
        '<a href="https://mactechnews.de/a#comment-1">source</a></p>' +
        "<div><div><p>Nice article!</p></div></div></blockquote></section>",
    );
  });

  it("pins null (no section at all) when no comment container is found", () => {
    const html = extractComments(
      `<div>no comments here</div>`,
      "https://mactechnews.de/a",
      5,
      DEFAULT_CHROME_LABELS,
    );

    expect(html).toBeNull();
  });

  it("pins null (no section at all) when the container has no comments", () => {
    const html = extractComments(
      `<div class="MtnCommentScroll"></div>`,
      "https://mactechnews.de/a",
      5,
      DEFAULT_CHROME_LABELS,
    );

    expect(html).toBeNull();
  });
});
