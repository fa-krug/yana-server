import { describe, expect, it } from "vitest";

import { decodeOpml, decodeOpmlOptions, encodeOpml, type OpmlExportFeed } from "./opml";

describe("encodeOpml / decodeOpml", () => {
  it("round-trips every field", () => {
    const feed: OpmlExportFeed = {
      name: "Heise",
      aggregator: "full_website",
      identifier: "https://www.heise.de/rss/heise-atom.xml",
      enabled: true,
      dailyLimit: 20,
      updateIntervalMinutes: 30,
      concurrency: 4,
      maxArticleAgeDays: 30,
      options: { ai_summarize: true },
      tags: ["Tech", "News"],
    };

    const xml = encodeOpml([feed]);
    const [entry] = decodeOpml(xml);

    expect(entry.name).toBe("Heise");
    expect(entry.identifier).toBe(feed.identifier);
    expect(entry.aggregatorType).toBe("full_website");
    expect(entry.enabled).toBe(true);
    expect(entry.dailyLimit).toBe(20);
    expect(entry.updateIntervalMinutes).toBe(30);
    expect(entry.concurrency).toBe(4);
    expect(entry.maxArticleAgeDays).toBe(30);
    expect(entry.tags).toEqual(["Tech", "News"]);
    expect(decodeOpmlOptions(entry.optionsBase64 as string)).toEqual({ ai_summarize: true });
  });

  it("omits yana:tags and yana:options when there is nothing to carry", () => {
    const feed: OpmlExportFeed = {
      name: "Plain",
      aggregator: "feed_content",
      identifier: "https://example.com/feed.xml",
      enabled: true,
      dailyLimit: 20,
      updateIntervalMinutes: 30,
      concurrency: 4,
      maxArticleAgeDays: 30,
      options: {},
      tags: [],
    };

    const xml = encodeOpml([feed]);
    expect(xml).not.toContain("yana:tags");
    expect(xml).not.toContain("yana:options");

    const [entry] = decodeOpml(xml);
    expect(entry.tags).toEqual([]);
    expect(entry.optionsBase64).toBeUndefined();
  });

  it("decodes foreign OPML with no yana: attributes at all", () => {
    const xml = `<?xml version="1.0"?>
<opml version="2.0">
  <body>
    <outline text="A Blog" xmlUrl="https://example.com/rss" type="rss" />
  </body>
</opml>`;

    const [entry] = decodeOpml(xml);
    expect(entry.name).toBe("A Blog");
    expect(entry.identifier).toBe("https://example.com/rss");
    expect(entry.aggregatorType).toBeUndefined();
    expect(entry.tags).toEqual([]);
  });

  it("skips an outline with neither a name nor an identifier", () => {
    const xml = `<opml version="2.0"><body><outline type="rss" /></body></opml>`;
    expect(decodeOpml(xml)).toEqual([]);
  });

  it("throws on a file with no <opml>/<body> structure", () => {
    expect(() => decodeOpml("<html><body>not opml</body></html>")).toThrow();
  });
});

describe("decodeOpmlOptions", () => {
  it("decodes a base64-encoded JSON object", () => {
    const encoded = Buffer.from(JSON.stringify({ a: 1 })).toString("base64");
    expect(decodeOpmlOptions(encoded)).toEqual({ a: 1 });
  });

  it("returns null for invalid base64/JSON", () => {
    expect(decodeOpmlOptions("not-valid-base64-json!!!")).toBeNull();
  });

  it("returns null when the decoded JSON is not an object", () => {
    const encoded = Buffer.from(JSON.stringify([1, 2, 3])).toString("base64");
    expect(decodeOpmlOptions(encoded)).toBeNull();
  });
});
