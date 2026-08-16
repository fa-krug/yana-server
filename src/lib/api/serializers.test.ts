import { describe, expect, it } from "vitest";

import type { Article, Feed, Tag } from "@/lib/db/schema";
import { serializeArticleSummary, serializeFeed, serializeTag } from "./serializers";

const baseArticle: Article = {
  id: 1,
  name: "Title",
  identifier: "https://example.com/a",
  rawContent: "",
  plainText: "",
  contentHash: null,
  date: new Date("2026-01-01T00:00:00Z"),
  read: false,
  starred: true,
  author: "",
  icon: null,
  feedId: 5,
  createdAt: new Date("2026-01-02T00:00:00Z"),
  updatedAt: new Date("2026-01-03T00:00:00Z"),
};

describe("serializeArticleSummary", () => {
  it("projects dates to ISO strings and keeps booleans", () => {
    const wire = serializeArticleSummary(baseArticle);
    expect(wire).toEqual({
      id: 1,
      feedId: 5,
      name: "Title",
      identifier: "https://example.com/a",
      date: "2026-01-01T00:00:00.000Z",
      author: "",
      icon: null,
      read: false,
      starred: true,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
  });
});

describe("serializeFeed", () => {
  it("attaches the given tagIds", () => {
    const feed = {
      id: 1,
      name: "Feed",
      aggregator: "full_website",
      identifier: "https://example.com",
      dailyLimit: 20,
      enabled: true,
      userId: "u1",
      redditSubredditId: null,
      youtubeChannelId: null,
      options: {},
      logoSourceUrl: "",
      logoImageHash: "abc123",
      createdAt: new Date(),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    } as Feed;

    expect(serializeFeed(feed, [1, 2])).toMatchObject({
      id: 1,
      tagIds: [1, 2],
      logoImageHash: "abc123",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("serializeTag", () => {
  it("projects id, name, color", () => {
    expect(serializeTag({ id: 1, name: "News", color: "red" } as Tag)).toEqual({
      id: 1,
      name: "News",
      color: "red",
    });
  });
});
