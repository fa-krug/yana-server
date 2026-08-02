import { describe, expect, it } from "vitest";
import { compareToGolden, loadCases, GoldenRecord, ActualResult } from "./compare";

describe("compare parity harness", () => {
  describe("loadCases", () => {
    it("loads parity/cases.json", () => {
      const cases = loadCases();
      expect(cases.length).toBeGreaterThan(0);
      const first = cases[0];
      expect(first).toHaveProperty("id");
      expect(first).toHaveProperty("aggregator");
      expect(first).toHaveProperty("fixture");
      expect(first).toHaveProperty("options");
      expect(first).toHaveProperty("identifier");
    });
  });

  describe("compareToGolden", () => {
    const sampleGolden: GoldenRecord = {
      parityVersion: 1,
      caseId: "sample/test",
      aggregator: "sample",
      fixture: "html/sample.html",
      options: {},
      article: {
        title: "Test Title",
        identifier: "https://example.com/test",
        author: "Author Name",
        date: "2026-06-07T00:00:00.000Z",
        plainText: "Sample plain text",
      },
      document: {
        version: 1,
        blocks: [
          {
            type: "paragraph",
            runs: [{ text: "Sample plain text", styles: [], link: null }],
          },
          {
            type: "image",
            ref: "yana-img://hash_golden_123",
            caption: [],
          },
        ],
      },
      images: [
        {
          key: "img:0",
          sourceUrl: "https://example.com/image.jpg",
          contentType: "image/jpeg",
          width: 800,
          height: 600,
          byteSize: 10000,
          contentHash: "hash_golden_123",
        },
      ],
    };

    it("returns ok: true for matching actual result even with different contentHash", () => {
      const actual: ActualResult = {
        article: {
          title: "Test Title",
          identifier: "https://example.com/test",
          author: "Author Name",
          date: "2026-06-07T00:00:00.000Z",
          plainText: "Sample plain text",
        },
        document: {
          version: 1,
          blocks: [
            {
              type: "paragraph",
              runs: [{ text: "Sample plain text", styles: [], link: null }],
            },
            {
              type: "image",
              ref: "yana-img://hash_actual_456",
              caption: [],
            },
          ],
        },
        images: [
          {
            sourceUrl: "https://example.com/image.jpg",
            contentType: "image/jpeg",
            width: 800,
            height: 600,
            byteSize: 11000, // +10%, within ±25%
            contentHash: "hash_actual_456",
          },
        ],
      };

      const result = compareToGolden(sampleGolden, actual);
      expect(result).toEqual({ ok: true });
    });

    it("detects article title mismatch", () => {
      const actual: ActualResult = {
        article: {
          title: "Wrong Title",
          identifier: "https://example.com/test",
          author: "Author Name",
          date: "2026-06-07T00:00:00.000Z",
          plainText: "Sample plain text",
        },
        document: sampleGolden.document,
        images: sampleGolden.images,
      };

      const result = compareToGolden(sampleGolden, actual);
      expect(result.ok).toBe(false);
      expect(result.diff).toContain("Article title mismatch");
    });

    it("detects article identifier mismatch", () => {
      const actual: ActualResult = {
        article: {
          title: "Test Title",
          identifier: "https://example.com/wrong",
          author: "Author Name",
          date: "2026-06-07T00:00:00.000Z",
          plainText: "Sample plain text",
        },
        document: sampleGolden.document,
        images: sampleGolden.images,
      };

      const result = compareToGolden(sampleGolden, actual);
      expect(result.ok).toBe(false);
      expect(result.diff).toContain("Article identifier mismatch");
    });

    it("detects article author mismatch", () => {
      const actual: ActualResult = {
        article: {
          title: "Test Title",
          identifier: "https://example.com/test",
          author: "Different Author",
          date: "2026-06-07T00:00:00.000Z",
          plainText: "Sample plain text",
        },
        document: sampleGolden.document,
        images: sampleGolden.images,
      };

      const result = compareToGolden(sampleGolden, actual);
      expect(result.ok).toBe(false);
      expect(result.diff).toContain("Article author mismatch");
    });

    it("detects article date mismatch", () => {
      const actual: ActualResult = {
        article: {
          title: "Test Title",
          identifier: "https://example.com/test",
          author: "Author Name",
          date: "2026-01-01T00:00:00.000Z",
          plainText: "Sample plain text",
        },
        document: sampleGolden.document,
        images: sampleGolden.images,
      };

      const result = compareToGolden(sampleGolden, actual);
      expect(result.ok).toBe(false);
      expect(result.diff).toContain("Article date mismatch");
    });

    it("detects article plainText mismatch", () => {
      const actual: ActualResult = {
        article: {
          title: "Test Title",
          identifier: "https://example.com/test",
          author: "Author Name",
          date: "2026-06-07T00:00:00.000Z",
          plainText: "Different text",
        },
        document: sampleGolden.document,
        images: sampleGolden.images,
      };

      const result = compareToGolden(sampleGolden, actual);
      expect(result.ok).toBe(false);
      expect(result.diff).toContain("Article plainText mismatch");
    });

    it("detects document block tree mismatch", () => {
      const actual: ActualResult = {
        article: sampleGolden.article,
        document: {
          version: 1,
          blocks: [
            {
              type: "paragraph",
              runs: [{ text: "Diff text", styles: [], link: null }],
            },
          ],
        },
        images: sampleGolden.images,
      };

      const result = compareToGolden(sampleGolden, actual);
      expect(result.ok).toBe(false);
      expect(result.diff).toContain("document");
    });

    it("detects image dimension mismatch", () => {
      const actual: ActualResult = {
        article: sampleGolden.article,
        document: sampleGolden.document,
        images: [
          {
            sourceUrl: "https://example.com/image.jpg",
            contentType: "image/jpeg",
            width: 1024, // golden is 800
            height: 600,
            byteSize: 10000,
          },
        ],
      };

      const result = compareToGolden(sampleGolden, actual);
      expect(result.ok).toBe(false);
      expect(result.diff).toContain("width mismatch");
    });

    it("accepts image byteSize within ±25%", () => {
      const actualLow: ActualResult = {
        article: sampleGolden.article,
        document: sampleGolden.document,
        images: [{ ...sampleGolden.images[0], byteSize: 7500 }], // -25%
      };
      const actualHigh: ActualResult = {
        article: sampleGolden.article,
        document: sampleGolden.document,
        images: [{ ...sampleGolden.images[0], byteSize: 12500 }], // +25%
      };

      expect(compareToGolden(sampleGolden, actualLow)).toEqual({ ok: true });
      expect(compareToGolden(sampleGolden, actualHigh)).toEqual({ ok: true });
    });

    it("rejects image byteSize outside ±25%", () => {
      const actualTooLow: ActualResult = {
        article: sampleGolden.article,
        document: sampleGolden.document,
        images: [{ ...sampleGolden.images[0], byteSize: 7499 }], // < -25%
      };
      const actualTooHigh: ActualResult = {
        article: sampleGolden.article,
        document: sampleGolden.document,
        images: [{ ...sampleGolden.images[0], byteSize: 12501 }], // > +25%
      };

      const resLow = compareToGolden(sampleGolden, actualTooLow);
      expect(resLow.ok).toBe(false);
      expect(resLow.diff).toContain("outside ±25%");

      const resHigh = compareToGolden(sampleGolden, actualTooHigh);
      expect(resHigh.ok).toBe(false);
      expect(resHigh.diff).toContain("outside ±25%");
    });
  });
});
