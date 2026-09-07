import { describe, expect, it } from "vitest";

import { feedUrlInHtml, parseXmlFeed, unescapeEntities } from "./rss-parser";

describe("rss-parser", () => {
  describe("unescapeEntities", () => {
    it("unescapes numeric and named HTML entities", () => {
      expect(unescapeEntities("Apple&#8217;s iPhone")).toBe("Apple’s iPhone");
      expect(unescapeEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
      expect(unescapeEntities("It&#39;s &lt;cool&gt;")).toBe("It's <cool>");
    });

    it("is idempotent when called on already unescaped strings", () => {
      const plain = "Apple's iPhone & iPad";
      expect(unescapeEntities(plain)).toBe(plain);
    });
  });

  describe("parseXmlFeed", () => {
    it("parses RSS 2.0 feed xml", () => {
      const rssXml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://example.com</link>
          <item>
            <title>Item 1 &#8217; Title</title>
            <link>https://example.com/1</link>
            <description>Item 1 Description</description>
            <pubDate>Mon, 02 Aug 2026 08:00:00 GMT</pubDate>
            <author>Author Name</author>
          </item>
        </channel>
      </rss>`;

      const parsed = parseXmlFeed(rssXml);
      expect(parsed.title).toBe("Test Feed");
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].title).toBe("Item 1 ’ Title");
      expect(parsed.entries[0].link).toBe("https://example.com/1");
      expect(parsed.entries[0].summary).toBe("Item 1 Description");
    });

    /**
     * The categories are read for one consumer: the advertising filter in
     * `BaseAggregator.filterArticles()`. This is Mein-MMO's real shape -- the
     * label sits beside topical categories, and the entry order is what the
     * feed emits.
     */
    it("reads an RSS item's categories", () => {
      const rssXml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Mein-MMO</title>
          <item>
            <title>Mafia guenstig als Disc-Version</title>
            <link>https://mein-mmo.de/deal/</link>
            <description>Deal</description>
            <category><![CDATA[Anzeige]]></category>
            <category><![CDATA[Deals]]></category>
            <category><![CDATA[Deals]]></category>
          </item>
          <item>
            <title>WoW: Naechster Privat-Server schliesst</title>
            <link>https://mein-mmo.de/news/</link>
            <description>News</description>
          </item>
        </channel>
      </rss>`;

      const parsed = parseXmlFeed(rssXml);
      // De-duplicated, in feed order.
      expect(parsed.entries[0].categories).toEqual(["Anzeige", "Deals"]);
      // Absent, not empty: an entry that never had the field is a different
      // thing from one that has no categories.
      expect(parsed.entries[1].categories).toBeUndefined();
    });

    it("reads an Atom entry's categories from term, preferring a human label", () => {
      const atomXml = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom Test</title>
        <entry>
          <title>Sponsored thing</title>
          <link rel="alternate" href="https://example.com/atom1" />
          <category term="advertorial" label="Advertorial" />
          <category term="tech" />
        </entry>
      </feed>`;

      const parsed = parseXmlFeed(atomXml);
      expect(parsed.entries[0].categories).toEqual(["Advertorial", "tech"]);
    });

    it("parses Atom feed xml", () => {
      const atomXml = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom Test</title>
        <entry>
          <title>Atom Entry 1</title>
          <link rel="alternate" href="https://example.com/atom1" />
          <content>Atom Content</content>
          <updated>2026-08-02T08:00:00Z</updated>
          <author><name>Atom Author</name></author>
        </entry>
      </feed>`;

      const parsed = parseXmlFeed(atomXml);
      expect(parsed.title).toBe("Atom Test");
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].link).toBe("https://example.com/atom1");
      expect(parsed.entries[0].summary).toBe("Atom Content");
    });

    it("throws error when no items or entries are found", () => {
      const emptyXml = `<?xml version="1.0"?><rss><channel><title>Empty</title></channel></rss>`;
      expect(() => parseXmlFeed(emptyXml)).toThrow("No feed entries found");
    });
  });

  describe("feedUrlInHtml", () => {
    it("extracts advertised feed link and resolves absolute URL", () => {
      const html = `<html>
        <head>
          <link rel="alternate" type="application/rss+xml" href="/feed.xml" />
        </head>
      </html>`;
      const feedUrl = feedUrlInHtml(html, "https://example.com/news/");
      expect(feedUrl).toBe("https://example.com/feed.xml");
    });

    it("prioritizes RSS over Atom feed link", () => {
      const html = `<html>
        <head>
          <link rel="alternate" type="application/atom+xml" href="/atom.xml" />
          <link rel="alternate" type="application/rss+xml" href="/rss.xml" />
        </head>
      </html>`;
      const feedUrl = feedUrlInHtml(html, "https://example.com");
      expect(feedUrl).toBe("https://example.com/rss.xml");
    });
  });
});
