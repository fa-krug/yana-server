import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "./schema";
import { freshDrizzle } from "./test-support";

/**
 * One real relational query per declared association.
 *
 * Drizzle's relation declarations are invisible to `tsc`: a `one()` on the
 * non-FK side of a one-to-one whose partner never declares
 * `fields`/`references` compiles fine and throws "There is not enough
 * information to infer relation" the first time anybody runs `db.query.*`
 * against it. That is exactly how `users.settings` shipped broken. Only an
 * executed query catches it, so every association gets traversed here.
 */
describe("relations", () => {
  let connection: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    ({ connection, db } = freshDrizzle());

    db.insert(schema.users).values({ id: "u1", email: "u1@example.com" }).run();
    db.insert(schema.userSettings).values({ userId: "u1" }).run();
    db.insert(schema.redditSubreddits).values({ id: 1, displayName: "programming" }).run();
    db.insert(schema.youtubeChannels).values({ id: 1, channelId: "UC1", title: "Chan" }).run();
    db.insert(schema.feeds)
      .values({
        id: 1,
        name: "Feed",
        userId: "u1",
        redditSubredditId: 1,
        youtubeChannelId: 1,
      })
      .run();
    db.insert(schema.tags).values({ id: 1, name: "News", userId: "u1" }).run();
    db.insert(schema.feedTags).values({ feedId: 1, tagId: 1 }).run();
    db.insert(schema.articles)
      .values({ id: 1, name: "Article", identifier: "i1", date: new Date(0), feedId: 1 })
      .run();
    // A two-level block tree: a list whose child is a list_item.
    db.insert(schema.articleBlocks)
      .values({ id: 1, articleId: 1, parentId: null, position: 0, kind: "list" })
      .run();
    db.insert(schema.articleBlocks)
      .values({ id: 2, articleId: 1, parentId: 1, position: 0, kind: "list_item" })
      .run();
    db.insert(schema.articleInlineRuns)
      .values({ blockId: 2, position: 0, text: "hello", bold: true })
      .run();
    // Better Auth's satellite rows, inserted the way its adapter does: string
    // ids it generated itself, not autoincrement.
    db.insert(schema.sessions)
      .values({ id: "s1", token: "tok1", userId: "u1", expiresAt: new Date(1) })
      .run();
    db.insert(schema.accounts)
      .values({ id: "a1", accountId: "u1", providerId: "credential", userId: "u1" })
      .run();
    db.insert(schema.passkeys)
      .values({
        id: "p1",
        name: "Laptop",
        publicKey: "pk",
        userId: "u1",
        credentialID: "cred1",
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      })
      .run();
  });

  afterEach(() => {
    if (connection.open) connection.close();
  });

  it("traverses users -> settings, feeds, tags", async () => {
    const user = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.id, "u1"),
      with: { settings: true, feeds: true, tags: true },
    });

    expect(user?.settings?.userId).toBe("u1");
    expect(user?.feeds.map((feed) => feed.name)).toEqual(["Feed"]);
    expect(user?.tags.map((tag) => tag.name)).toEqual(["News"]);
  });

  it("traverses users -> sessions, accounts, passkeys", async () => {
    const user = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.id, "u1"),
      with: { sessions: true, accounts: true, passkeys: true },
    });

    expect(user?.sessions.map((session) => session.token)).toEqual(["tok1"]);
    expect(user?.accounts.map((account) => account.providerId)).toEqual(["credential"]);
    expect(user?.passkeys.map((key) => key.credentialID)).toEqual(["cred1"]);
  });

  it("traverses sessions, accounts and passkeys -> user", async () => {
    const session = await db.query.sessions.findFirst({ with: { user: true } });
    const account = await db.query.accounts.findFirst({ with: { user: true } });
    const key = await db.query.passkeys.findFirst({ with: { user: true } });

    expect(session?.user.email).toBe("u1@example.com");
    expect(account?.user.email).toBe("u1@example.com");
    expect(key?.user.email).toBe("u1@example.com");
  });

  it("traverses user_settings -> owner", async () => {
    const settings = await db.query.userSettings.findFirst({ with: { owner: true } });

    expect(settings?.owner.email).toBe("u1@example.com");
  });

  it("traverses feeds -> owner, articles, feedTags", async () => {
    const feed = await db.query.feeds.findFirst({
      with: { owner: true, articles: true, feedTags: true },
    });

    expect(feed?.owner.id).toBe("u1");
    expect(feed?.articles.map((article) => article.identifier)).toEqual(["i1"]);
    expect(feed?.feedTags.map((feedTag) => feedTag.tagId)).toEqual([1]);
  });

  it("traverses the autocomplete associations, which phase 9's feed form joins", async () => {
    const feed = await db.query.feeds.findFirst({
      with: { redditSubreddit: true, youtubeChannel: true },
    });

    expect(feed?.redditSubreddit?.displayName).toBe("programming");
    expect(feed?.youtubeChannel?.title).toBe("Chan");
  });

  it("traverses tags -> owner, feedTags", async () => {
    const tag = await db.query.tags.findFirst({ with: { owner: true, feedTags: true } });

    expect(tag?.owner.id).toBe("u1");
    expect(tag?.feedTags.map((feedTag) => feedTag.feedId)).toEqual([1]);
  });

  it("traverses feed_tags -> feed, tag", async () => {
    const feedTag = await db.query.feedTags.findFirst({ with: { feed: true, tag: true } });

    expect(feedTag?.feed.name).toBe("Feed");
    expect(feedTag?.tag.name).toBe("News");
  });

  it("traverses articles -> feed, blocks", async () => {
    const article = await db.query.articles.findFirst({ with: { feed: true, blocks: true } });

    expect(article?.feed.name).toBe("Feed");
    expect(article?.blocks.map((block) => block.kind)).toEqual(["list", "list_item"]);
  });

  it("traverses article_blocks -> article, runs, and the self-referential block tree", async () => {
    const root = await db.query.articleBlocks.findFirst({
      where: (block, { isNull }) => isNull(block.parentId),
      with: { article: true, children: { with: { runs: true } }, parent: true },
    });

    expect(root?.article.identifier).toBe("i1");
    expect(root?.parent).toBeNull();
    expect(root?.children.map((child) => child.kind)).toEqual(["list_item"]);
    expect(root?.children[0]?.runs.map((run) => run.text)).toEqual(["hello"]);

    const child = await db.query.articleBlocks.findFirst({
      where: (block, { isNotNull }) => isNotNull(block.parentId),
      with: { parent: true },
    });

    expect(child?.parent?.kind).toBe("list");
  });

  it("traverses article_inline_runs -> block", async () => {
    const run = await db.query.articleInlineRuns.findFirst({ with: { block: true } });

    expect(run?.block.kind).toBe("list_item");
  });
});
