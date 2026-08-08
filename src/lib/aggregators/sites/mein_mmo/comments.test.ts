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
    <div class="wpd-thread-list">
      <div class="wpd-comment">
        <div class="wpd-comment-author"><a>Alex</a></div>
        <div class="wpd-comment-right" id="comment-1"></div>
        <div class="wpd-comment-text"><p>Nice article!</p></div>
      </div>
    </div>
  `;
}

describe("extractComments", () => {
  it("renders the Comments heading and source link in English by default", () => {
    const html = extractComments(pageWithOneComment(), "https://mein-mmo.de/a", 5, DEFAULT_CHROME_LABELS);

    expect(html).toContain(">Comments</a></h3>");
    expect(html).toContain(">source</a>");
  });

  it("renders the Comments heading and source link in the passed-in locale's labels", () => {
    const html = extractComments(pageWithOneComment(), "https://mein-mmo.de/a", 5, GERMAN_LABELS);

    expect(html).toContain(">Kommentare</a></h3>");
    expect(html).toContain(">Quelle</a>");
    expect(html).not.toContain("Comments");
    expect(html).not.toContain(">source<");
  });
});
