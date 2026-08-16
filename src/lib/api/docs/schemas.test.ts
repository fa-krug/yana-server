import { describe, expect, it } from "vitest";

import {
  ArticleSummarySchema,
  FeedSchema,
  ReadingPositionSchema,
  TagSchema,
} from "@/lib/api/docs/schemas";
import {
  serializeArticleSummary,
  serializeFeed,
  serializeReadingPosition,
  serializeTag,
} from "@/lib/api/serializers";

describe("response schemas accept real serializer output", () => {
  it("ArticleSummarySchema", () => {
    const wire = serializeArticleSummary({
      id: 1,
      feedId: 2,
      name: "Title",
      identifier: "guid",
      date: new Date(),
      author: "Ada",
      icon: null,
      read: false,
      starred: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      // Remaining Article columns not read by serializeArticleSummary:
      rawContent: "",
      plainText: "",
    } as never);
    expect(() => ArticleSummarySchema.parse(wire)).not.toThrow();
  });

  it("FeedSchema", () => {
    const wire = serializeFeed(
      {
        id: 1,
        name: "Feed",
        aggregator: "full_website",
        identifier: "",
        enabled: true,
        dailyLimit: 20,
        updateIntervalMinutes: 30,
        concurrency: 4,
        logoImageHash: null,
        updatedAt: new Date(),
      } as never,
      [1, 2],
    );
    expect(() => FeedSchema.parse(wire)).not.toThrow();
  });

  it("TagSchema", () => {
    const wire = serializeTag({ id: 1, name: "News", color: "red" } as never);
    expect(() => TagSchema.parse(wire)).not.toThrow();
  });

  it("ReadingPositionSchema, both populated and empty", () => {
    expect(() =>
      ReadingPositionSchema.parse(
        serializeReadingPosition({
          readingPositionArticleId: 5,
          readingPositionUpdatedAt: new Date(),
        }),
      ),
    ).not.toThrow();
    expect(() =>
      ReadingPositionSchema.parse(
        serializeReadingPosition({
          readingPositionArticleId: null,
          readingPositionUpdatedAt: null,
        }),
      ),
    ).not.toThrow();
  });
});
