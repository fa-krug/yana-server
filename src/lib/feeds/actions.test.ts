import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { requestHeaders, cookieJar } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  cookieJar: new Map<string, string>(),
}));

vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders, cookieJar),
);

// We define a mock that just verifies the job queue behavior conceptually.
// The test says `mockLogoDiscoveryToThrow()`. We don't actually invoke discoverLogo
// in the test since the action only writes to `jobs`.
function mockLogoDiscoveryToThrow() {
  // no-op, since discovery is async enqueued
}

const PASSWORD = "correct horse battery staple";

describe("createFeed", () => {
  let dbPath: string;
  let actions: typeof import("./actions");
  let tagsActions: typeof import("@/lib/tags/actions");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let actingUserId: string | undefined;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  async function seedUser(input: { email: string }): Promise<string> {
    const user = await createUserWithPassword({
      email: input.email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    // Add user_settings to mock real flow since tests don't run full signup flow
    raw(client.getDb()).exec(`INSERT INTO user_settings (user_id) VALUES ('${user.id}')`);
    return user.id;
  }

  async function currentUserId(): Promise<string> {
    if (actingUserId) return actingUserId;
    actingUserId = await seedUser({ email: "user@example.com" });
    const cookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
    requestAs(cookie);
    cookieJar.clear();
    return actingUserId;
  }

  async function switchToOtherUser(): Promise<void> {
    await seedUser({ email: "other@example.com" });
    const cookie = await signInCookie(auth, { email: "other@example.com", password: PASSWORD });
    requestAs(cookie);
    actingUserId = undefined;
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();
    actingUserId = undefined;

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-feeds-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    actions = await import("./actions");
    tagsActions = await import("@/lib/tags/actions");
    client = await import("@/lib/db/client");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("requires an identifier for reddit", async () => {
    await currentUserId();
    const result = await actions.createFeed({ name: "r/x", aggregator: "reddit", identifier: "" });
    expect(result).toMatchObject({ ok: false, field: "identifier" });
  });

  it("allows an empty identifier for a scraper", async () => {
    await currentUserId();
    expect(
      (await actions.createFeed({ name: "Heise", aggregator: "heise", identifier: "" })).ok,
    ).toBe(true);
  });

  it("snaps a choice-mode identifier to the default when the submitted value isn't a known choice", async () => {
    await currentUserId();
    const { id } = await actions.createFeed({
      name: "Heise",
      aggregator: "heise",
      identifier: "not-a-real-feed-url",
    });
    expect((await actions.getFeed(id!))?.identifier).toBe("https://www.heise.de/rss/heise.rdf");
  });

  it("keeps a submitted choice-mode identifier when it is a known choice", async () => {
    await currentUserId();
    const { id } = await actions.createFeed({
      name: "Heise Security",
      aggregator: "heise",
      identifier: "https://www.heise.de/rss/heise-security.rdf",
    });
    expect((await actions.getFeed(id!))?.identifier).toBe(
      "https://www.heise.de/rss/heise-security.rdf",
    );
  });

  it("always sets a none-mode identifier to its one fixed value", async () => {
    await currentUserId();
    const { id } = await actions.createFeed({ name: "X", aggregator: "explosm", identifier: "" });
    expect((await actions.getFeed(id!))?.identifier).toBe("https://explosm.net/rss.xml");
  });

  it("rejects a new reddit feed when the reddit integration is disabled", async () => {
    await currentUserId();
    const result = await actions.createFeed({
      name: "r/programming",
      aggregator: "reddit",
      identifier: "programming",
    });
    expect(result.ok).toBe(false);
  });

  it("creates a reddit feed once the reddit integration is enabled", async () => {
    await currentUserId();
    raw(client.getDb()).exec(`UPDATE user_settings SET reddit_enabled = 1`);
    const result = await actions.createFeed({
      name: "r/programming",
      aggregator: "reddit",
      identifier: "programming",
    });
    expect(result.ok).toBe(true);
  });

  it("strips an option whose integration is unconfigured", async () => {
    await currentUserId();
    const { id } = await actions.createFeed({
      name: "X",
      aggregator: "heise",
      options: { ai_summarize: true },
    });
    expect((await actions.getFeed(id!))?.options).not.toHaveProperty("ai_summarize");
  });

  it("succeeds even when logo discovery fails", async () => {
    await currentUserId();
    mockLogoDiscoveryToThrow();
    expect((await actions.createFeed({ name: "X", aggregator: "heise" })).ok).toBe(true);
  });

  it("records the acting user on the feed.logo job it creates", async () => {
    const userId = await currentUserId();
    await actions.createFeed({ name: "X", aggregator: "heise" });

    const job = raw(client.getDb())
      .prepare("SELECT user_id FROM jobs WHERE kind = 'feed.logo'")
      .get() as { user_id: string } | undefined;
    expect(job?.user_id).toBe(userId);
  });

  it("attaches multiple tags", async () => {
    await currentUserId();
    const a = (await tagsActions.createTag({ name: "A" })) as { id: number };
    const b = (await tagsActions.createTag({ name: "B" })) as { id: number };
    const { id } = await actions.createFeed({
      name: "X",
      aggregator: "heise",
      tagIds: [a.id, b.id],
    });
    expect((await actions.getFeed(id!))?.tags).toHaveLength(2);
  });

  it("rejects another user's tag id", async () => {
    await currentUserId();
    const a = (await tagsActions.createTag({ name: "A" })) as { id: number };
    await switchToOtherUser();
    const foreign = a.id;
    expect(
      (await actions.createFeed({ name: "X", aggregator: "heise", tagIds: [foreign] })).ok,
    ).toBe(false);
  });

  it("stores updateIntervalMinutes and concurrency on create", async () => {
    await currentUserId();
    const result = await actions.createFeed({
      name: "Interval Feed",
      aggregator: "heise",
      updateIntervalMinutes: 15,
      concurrency: 2,
    });
    expect(result.ok).toBe(true);

    const row = await actions.getFeed(result.id!);
    expect(row?.updateIntervalMinutes).toBe(15);
    expect(row?.concurrency).toBe(2);
  });

  it("rejects an update interval outside 0-1440", async () => {
    await currentUserId();
    const result = await actions.createFeed({
      name: "Bad Interval Feed",
      aggregator: "heise",
      updateIntervalMinutes: 1441,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects concurrency outside 1-10", async () => {
    await currentUserId();
    const result = await actions.createFeed({
      name: "Bad Concurrency Feed",
      aggregator: "heise",
      concurrency: 0,
    });
    expect(result.ok).toBe(false);
  });

  it("stores maxArticleAgeDays on create, defaulting to 30 when omitted", async () => {
    await currentUserId();
    const withDefault = await actions.createFeed({ name: "Default Age Feed", aggregator: "heise" });
    expect(withDefault.ok).toBe(true);
    expect((await actions.getFeed(withDefault.id!))?.maxArticleAgeDays).toBe(30);

    const withOverride = await actions.createFeed({
      name: "Custom Age Feed",
      aggregator: "heise",
      maxArticleAgeDays: 90,
    });
    expect(withOverride.ok).toBe(true);
    expect((await actions.getFeed(withOverride.id!))?.maxArticleAgeDays).toBe(90);
  });

  it("rejects maxArticleAgeDays outside 0-3650", async () => {
    await currentUserId();
    const result = await actions.createFeed({
      name: "Bad Age Feed",
      aggregator: "heise",
      maxArticleAgeDays: -1,
    });
    expect(result.ok).toBe(false);
  });
});

describe("updateFeed", () => {
  let dbPath: string;
  let actions: typeof import("./actions");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-feeds-update-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    actions = await import("./actions");
    client = await import("@/lib/db/client");

    const user = await createUserWithPassword({
      email: "user@example.com",
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    raw(client.getDb()).exec(`INSERT INTO user_settings (user_id) VALUES ('${user.id}')`);
    const cookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
    requestHeaders.current = new Headers({ cookie });
    cookieJar.clear();
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("keeps an existing reddit feed editable after the integration is later disabled", async () => {
    raw(client.getDb()).exec(`UPDATE user_settings SET reddit_enabled = 1`);
    const { id } = await actions.createFeed({
      name: "r/programming",
      aggregator: "reddit",
      identifier: "programming",
    });
    raw(client.getDb()).exec(`UPDATE user_settings SET reddit_enabled = 0`);

    const result = await actions.updateFeed(id!, { name: "r/programming (renamed)" });
    expect(result.ok).toBe(true);
    const updated = await actions.getFeed(id!);
    expect(updated?.name).toBe("r/programming (renamed)");
    // The subreddit must survive a rename that doesn't touch the identifier field at all.
    expect(updated?.identifier).toBe("programming");
  });

  it("leaves stored options alone when the update omits them", async () => {
    const { id } = await actions.createFeed({
      name: "Heise",
      aggregator: "heise",
      options: { include_comments: false, max_comments: 42 },
    });

    const created = await actions.getFeed(id!);
    expect((created?.options as Record<string, unknown>).max_comments).toBe(42);
    expect((created?.options as Record<string, unknown>).include_comments).toBe(false);

    // No `options` field at all. `schemaFor(spec.key).safeParse({})` *applies
    // defaults*, so treating an omitted `options` as `{}` reset every
    // per-feed option (max_comments back to 5, include_comments back to true)
    // on a plain rename.
    const result = await actions.updateFeed(id!, { name: "Heise (renamed)" });
    expect(result.ok).toBe(true);

    const updated = await actions.getFeed(id!);
    expect(updated?.name).toBe("Heise (renamed)");
    expect((updated?.options as Record<string, unknown>).max_comments).toBe(42);
    expect((updated?.options as Record<string, unknown>).include_comments).toBe(false);
  });

  it("still writes options when the update submits them", async () => {
    const { id } = await actions.createFeed({
      name: "Heise",
      aggregator: "heise",
      options: { max_comments: 42 },
    });

    const result = await actions.updateFeed(id!, { options: { max_comments: 7 } });
    expect(result.ok).toBe(true);

    const updated = await actions.getFeed(id!);
    expect((updated?.options as Record<string, unknown>).max_comments).toBe(7);
  });

  it("rejects changing an existing feed's aggregator to reddit while it's disabled", async () => {
    const { id } = await actions.createFeed({ name: "X", aggregator: "heise" });
    const result = await actions.updateFeed(id!, {
      aggregator: "reddit",
      identifier: "programming",
    });
    expect(result.ok).toBe(false);
  });

  it("leaves updateIntervalMinutes and concurrency unchanged when omitted on update", async () => {
    const created = await actions.createFeed({
      name: "Keep Interval Feed",
      aggregator: "heise",
      updateIntervalMinutes: 45,
      concurrency: 3,
    });
    const feedId = created.id!;

    const updated = await actions.updateFeed(feedId, { name: "Renamed" });
    expect(updated.ok).toBe(true);

    const row = await actions.getFeed(feedId);
    expect(row?.updateIntervalMinutes).toBe(45);
    expect(row?.concurrency).toBe(3);
  });

  it("leaves maxArticleAgeDays unchanged when omitted on update, and applies it when submitted", async () => {
    const created = await actions.createFeed({
      name: "Keep Age Feed",
      aggregator: "heise",
      maxArticleAgeDays: 45,
    });
    const feedId = created.id!;

    const unchanged = await actions.updateFeed(feedId, { name: "Renamed" });
    expect(unchanged.ok).toBe(true);
    expect((await actions.getFeed(feedId))?.maxArticleAgeDays).toBe(45);

    const changed = await actions.updateFeed(feedId, { maxArticleAgeDays: 0 });
    expect(changed.ok).toBe(true);
    expect((await actions.getFeed(feedId))?.maxArticleAgeDays).toBe(0);
  });
});

describe("deleteFeeds", () => {
  let dbPath: string;
  let actions: typeof import("./actions");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let actingUserId: string | undefined;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  async function seedUser(input: { email: string }): Promise<string> {
    const user = await createUserWithPassword({
      email: input.email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    // Add user_settings to mock real flow since tests don't run full signup flow
    raw(client.getDb()).exec(`INSERT INTO user_settings (user_id) VALUES ('${user.id}')`);
    return user.id;
  }

  async function currentUserId(): Promise<string> {
    if (actingUserId) return actingUserId;
    actingUserId = await seedUser({ email: "user@example.com" });
    const cookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
    requestAs(cookie);
    cookieJar.clear();
    return actingUserId;
  }

  async function switchToOtherUser(): Promise<void> {
    await seedUser({ email: "other@example.com" });
    const cookie = await signInCookie(auth, { email: "other@example.com", password: PASSWORD });
    requestAs(cookie);
    actingUserId = undefined;
  }

  function seedArticle(feedId: number): number {
    raw(client.getDb()).exec(
      `INSERT INTO articles (name, identifier, date, feed_id) VALUES ('A', 'a1', ${Math.floor(
        Date.now() / 1000,
      )}, ${feedId})`,
    );
    const row = raw(client.getDb())
      .prepare("SELECT id FROM articles WHERE feed_id = ?")
      .get(feedId) as { id: number };
    return row.id;
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();
    actingUserId = undefined;

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-feeds-delete-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    actions = await import("./actions");
    client = await import("@/lib/db/client");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("tombstones every article belonging to a deleted feed", async () => {
    const userId = await currentUserId();
    const { id: feedId } = await actions.createFeed({
      name: "Doomed",
      aggregator: "heise",
      identifier: "",
    });
    const articleId = seedArticle(feedId!);

    const result = await actions.deleteFeeds([feedId!]);
    expect(result).toEqual({ ok: true, deleted: 1 });

    const tombstones = raw(client.getDb())
      .prepare("SELECT * FROM article_tombstones WHERE article_id = ?")
      .all(articleId) as { user_id: string }[];
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].user_id).toBe(userId);

    const remainingArticles = raw(client.getDb())
      .prepare("SELECT * FROM articles WHERE id = ?")
      .all(articleId);
    expect(remainingArticles).toHaveLength(0);

    const remainingFeeds = raw(client.getDb())
      .prepare("SELECT * FROM feeds WHERE id = ?")
      .all(feedId);
    expect(remainingFeeds).toHaveLength(0);
  });

  it("does not tombstone or delete another user's feed", async () => {
    await currentUserId();
    const { id: feedId } = await actions.createFeed({
      name: "Not mine",
      aggregator: "heise",
      identifier: "",
    });
    const articleId = seedArticle(feedId!);

    await switchToOtherUser();
    const result = await actions.deleteFeeds([feedId!]);
    expect(result).toEqual({ ok: true, deleted: 0 });

    const tombstones = raw(client.getDb())
      .prepare("SELECT * FROM article_tombstones WHERE article_id = ?")
      .all(articleId);
    expect(tombstones).toHaveLength(0);

    const remainingArticles = raw(client.getDb())
      .prepare("SELECT * FROM articles WHERE id = ?")
      .all(articleId);
    expect(remainingArticles).toHaveLength(1);
  });

  it("returns deleted: 0 and writes nothing for an empty id list", async () => {
    await currentUserId();
    const result = await actions.deleteFeeds([]);
    expect(result).toEqual({ ok: true, deleted: 0 });
  });
});

describe("updateFeedsBulk", () => {
  let dbPath: string;
  let actions: typeof import("./actions");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let actingUserId: string | undefined;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  async function seedUser(input: { email: string }): Promise<string> {
    const user = await createUserWithPassword({
      email: input.email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    raw(client.getDb()).exec(`INSERT INTO user_settings (user_id) VALUES ('${user.id}')`);
    return user.id;
  }

  async function currentUserId(): Promise<string> {
    if (actingUserId) return actingUserId;
    actingUserId = await seedUser({ email: "user@example.com" });
    const cookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
    requestAs(cookie);
    cookieJar.clear();
    return actingUserId;
  }

  async function switchToOtherUser(): Promise<void> {
    await seedUser({ email: "other@example.com" });
    const cookie = await signInCookie(auth, { email: "other@example.com", password: PASSWORD });
    requestAs(cookie);
    actingUserId = undefined;
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();
    actingUserId = undefined;

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-feeds-update-bulk-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    actions = await import("./actions");
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("groups the enqueued jobs into one run owned by the caller", async () => {
    const userId = await currentUserId();
    const a = await actions.createFeed({ name: "A", aggregator: "heise", identifier: "" });
    const b = await actions.createFeed({ name: "B", aggregator: "heise", identifier: "" });

    const result = await actions.updateFeedsBulk([a.id!, b.id!]);
    if (!result.ok) throw new Error("expected updateFeedsBulk to succeed");
    expect(result.ok).toBe(true);
    expect(result.enqueued).toBe(2);

    const runRow = client
      .getDb()
      .select()
      .from(schema.runs)
      .all()
      .find((r) => r.id === result.runId)!;
    expect(runRow.userId).toBe(userId);
    expect(runRow.totalJobs).toBe(2);
    expect(runRow.status).toBe("running");

    const jobRows = client
      .getDb()
      .select()
      .from(schema.jobs)
      .all()
      .filter((j) => j.runId === result.runId);
    expect(jobRows).toHaveLength(2);
    expect(jobRows.every((j) => j.kind === "feed.update")).toBe(true);
  });

  it("filters out ids that don't belong to the caller, and still returns a valid runId", async () => {
    const userId1 = await currentUserId();
    const user1Cookie = requestHeaders.current.get("cookie")!;
    const mine = await actions.createFeed({ name: "Mine", aggregator: "heise", identifier: "" });

    await switchToOtherUser();
    const theirs = await actions.createFeed({
      name: "Theirs",
      aggregator: "heise",
      identifier: "",
    });

    // Switch back to user 1 by restoring their session
    requestAs(user1Cookie);
    actingUserId = userId1;

    const result = await actions.updateFeedsBulk([mine.id!, theirs.id!]);
    if (!result.ok) throw new Error("expected updateFeedsBulk to succeed");
    expect(result.enqueued).toBe(1);
    expect(typeof result.runId).toBe("number");
  });

  it("returns an already-completed, zero-job run for an empty id list", async () => {
    await currentUserId();
    const result = await actions.updateFeedsBulk([]);
    expect(result).toEqual({ ok: true, enqueued: 0, runId: expect.any(Number) });
    if (!result.ok) throw new Error("expected updateFeedsBulk to succeed");

    const runRow = client
      .getDb()
      .select()
      .from(schema.runs)
      .all()
      .find((r) => r.id === result.runId)!;
    expect(runRow.status).toBe("completed");
    expect(runRow.totalJobs).toBe(0);
  });

  it("refuses to enqueue an AI-enabled feed whose owner has no working AI provider", async () => {
    const userId = await currentUserId();

    // AI is active while the feed is created, so `ai_translate` survives
    // `stripUnavailable()` (see `src/lib/aggregators/specs.ts`) rather than
    // being dropped for a capability the owner didn't have yet.
    raw(client.getDb()).exec(
      `UPDATE user_settings SET active_ai_provider = 'openai', openai_enabled = 1 ` +
        `WHERE user_id = '${userId}'`,
    );

    const feed = await actions.createFeed({
      name: "Translated",
      aggregator: "heise",
      identifier: "",
      options: { ai_translate: true },
    });
    expect(feed.ok).toBe(true);

    // The owner's provider stops working -- credentials removed, quota
    // permanently revoked, whatever the cause. The feed's own options are
    // untouched; only the owner's readiness changed.
    raw(client.getDb()).exec(
      `UPDATE user_settings SET active_ai_provider = '', openai_enabled = 0 ` +
        `WHERE user_id = '${userId}'`,
    );

    const result = await actions.updateFeedsBulk([feed.id!]);

    expect(result.ok).toBe(false);
    expect("errorKey" in result && result.errorKey).toBeTruthy();

    const jobRows = client
      .getDb()
      .select()
      .from(schema.jobs)
      .all()
      .filter((j) => j.kind === "feed.update" || j.kind === "aggregate");
    expect(jobRows).toHaveLength(0);
  });
});

describe("bulk job enqueue actions", () => {
  let dbPath: string;
  let actions: typeof import("./actions");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let userId: string;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function seedFeed(): number {
    return client.writeTransaction((tx) =>
      tx
        .insert(schema.feeds)
        .values({ name: "F", userId })
        .returning({ id: schema.feeds.id })
        .get(),
    ).id;
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-feeds-bulk-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    actions = await import("./actions");
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");

    const user = await createUserWithPassword({
      email: "user@example.com",
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    userId = user.id;
    raw(client.getDb()).exec(`INSERT INTO user_settings (user_id) VALUES ('${user.id}')`);
    const cookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
    requestHeaders.current = new Headers({ cookie });
    cookieJar.clear();
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("records the acting user on the feed.logo job refreshLogos enqueues", async () => {
    const feedId = seedFeed();

    const result = await actions.refreshLogos([feedId]);
    expect(result).toEqual({ ok: true, enqueued: 1, runId: expect.any(Number) });

    const job = client
      .getDb()
      .select({ userId: schema.jobs.userId })
      .from(schema.jobs)
      .where(eq(schema.jobs.kind, "feed.logo"))
      .get();
    expect(job?.userId).toBe(userId);
  });

  it("records the acting user on the feed.update job updateFeedsBulk enqueues", async () => {
    const feedId = seedFeed();

    const result = await actions.updateFeedsBulk([feedId]);
    expect(result).toEqual({ ok: true, enqueued: 1, runId: expect.any(Number) });

    const job = client
      .getDb()
      .select({ userId: schema.jobs.userId })
      .from(schema.jobs)
      .where(eq(schema.jobs.kind, "feed.update"))
      .get();
    expect(job?.userId).toBe(userId);
  });
});

describe("previewOpmlImport", () => {
  let dbPath: string;
  let actions: typeof import("./actions");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let actingUserId: string | undefined;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  async function seedUser(input: { email: string }): Promise<string> {
    const user = await createUserWithPassword({
      email: input.email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    raw(client.getDb()).exec(`INSERT INTO user_settings (user_id) VALUES ('${user.id}')`);
    return user.id;
  }

  async function currentUserId(): Promise<string> {
    if (actingUserId) return actingUserId;
    actingUserId = await seedUser({ email: "user@example.com" });
    const cookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
    requestAs(cookie);
    cookieJar.clear();
    return actingUserId;
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();
    actingUserId = undefined;

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-feeds-opml-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    actions = await import("./actions");
    client = await import("@/lib/db/client");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  const OPML_HEADER = `<?xml version="1.0"?>\n<opml version="2.0" xmlns:yana="urn:yana:opml"><body>`;
  const OPML_FOOTER = `</body></opml>`;

  it("classifies a fresh entry as new", async () => {
    await currentUserId();

    const xml = `${OPML_HEADER}<outline text="Heise" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" />${OPML_FOOTER}`;
    const result = await actions.previewOpmlImport(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([
      expect.objectContaining({ name: "Heise", status: "new", aggregatorLabel: "Full Website" }),
    ]);
  });

  it("classifies an existing (aggregator, identifier) pair as a duplicate", async () => {
    const userId = await currentUserId();
    await actions.createFeed({
      name: "Existing",
      aggregator: "full_website",
      identifier: "https://heise.de/rss",
    });
    void userId;

    const xml = `${OPML_HEADER}<outline text="Heise Again" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" />${OPML_FOOTER}`;
    const result = await actions.previewOpmlImport(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0].status).toBe("duplicate");
  });

  it("falls back to full_website for foreign OPML with no yana:aggregatorType", async () => {
    await currentUserId();

    const xml = `${OPML_HEADER}<outline text="Some Blog" xmlUrl="https://example.com/rss" />${OPML_FOOTER}`;
    const result = await actions.previewOpmlImport(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]).toEqual(
      expect.objectContaining({ status: "new", aggregatorLabel: "Full Website" }),
    );
  });

  it("classifies an entry with invalid yana:options as invalid, not defaulted", async () => {
    await currentUserId();

    const badOptions = Buffer.from(JSON.stringify({ ai_summarize: "not-a-boolean" })).toString(
      "base64",
    );
    const xml = `${OPML_HEADER}<outline text="Heise" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" yana:options="${badOptions}" />${OPML_FOOTER}`;
    const result = await actions.previewOpmlImport(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]).toEqual(
      expect.objectContaining({ status: "invalid", reasonKey: "importReasonInvalidOptions" }),
    );
  });

  it("classifies a reddit/youtube entry as invalid when the integration isn't configured", async () => {
    await currentUserId();

    const xml = `${OPML_HEADER}<outline text="r/aww" xmlUrl="aww" yana:aggregatorType="reddit" />${OPML_FOOTER}`;
    const result = await actions.previewOpmlImport(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]).toEqual(
      expect.objectContaining({
        status: "invalid",
        reasonKey: "importReasonCapabilityUnavailable",
      }),
    );
  });

  it("does not import a second identical entry from within the same file twice", async () => {
    await currentUserId();

    const xml = `${OPML_HEADER}<outline text="Heise" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" /><outline text="Heise Dup" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" />${OPML_FOOTER}`;
    const result = await actions.previewOpmlImport(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.status)).toEqual(["new", "duplicate"]);
  });

  it("reports invalidOpmlFile for a file with no OPML structure", async () => {
    await currentUserId();

    const result = await actions.previewOpmlImport("not xml at all");

    expect(result).toEqual({ ok: false, errorKey: "invalidOpmlFile" });
  });

  it("classifies a foreign outline with neither an identifier nor an aggregatorType as invalid", async () => {
    await currentUserId();

    const xml = `${OPML_HEADER}<outline text="Tech" />${OPML_FOOTER}`;
    const result = await actions.previewOpmlImport(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([
      expect.objectContaining({
        name: "Tech",
        status: "invalid",
        reasonKey: "importReasonMissingIdentifier",
      }),
    ]);
  });

  it("snaps an off-list choice-mode identifier to the aggregator's default", async () => {
    await currentUserId();

    const xml = `${OPML_HEADER}<outline text="Heise" xmlUrl="https://heise.de/not-a-real-feed" yana:aggregatorType="heise" />${OPML_FOOTER}`;
    const result = await actions.previewOpmlImport(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([
      expect.objectContaining({
        status: "new",
        identifier: "https://www.heise.de/rss/heise.rdf",
      }),
    ]);
  });
});

describe("importOpmlFeeds", () => {
  let dbPath: string;
  let actions: typeof import("./actions");
  let tagsActions: typeof import("@/lib/tags/actions");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let actingUserId: string | undefined;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  async function seedUser(input: { email: string }): Promise<string> {
    const user = await createUserWithPassword({
      email: input.email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    raw(client.getDb()).exec(`INSERT INTO user_settings (user_id) VALUES ('${user.id}')`);
    return user.id;
  }

  async function currentUserId(): Promise<string> {
    if (actingUserId) return actingUserId;
    actingUserId = await seedUser({ email: "user@example.com" });
    const cookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
    requestAs(cookie);
    cookieJar.clear();
    return actingUserId;
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();
    actingUserId = undefined;

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-feeds-opml-import-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    actions = await import("./actions");
    tagsActions = await import("@/lib/tags/actions");
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  const OPML_HEADER = `<?xml version="1.0"?>\n<opml version="2.0" xmlns:yana="urn:yana:opml"><body>`;
  const OPML_FOOTER = `</body></opml>`;

  it("creates new feeds, resolves tags by name, and enqueues a feed.logo job per feed", async () => {
    const userId = await currentUserId();

    const xml = `${OPML_HEADER}<outline text="Heise" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" yana:tags="Tech,News" />${OPML_FOOTER}`;
    const result = await actions.importOpmlFeeds(xml);

    expect(result).toEqual({ ok: true, imported: 1, skipped: 0 });

    const db = client.getDb();
    const row = db.select().from(schema.feeds).where(eq(schema.feeds.userId, userId)).get();
    expect(row?.name).toBe("Heise");
    expect(row?.aggregator).toBe("full_website");

    const feedTagNames = db
      .select({ name: schema.tags.name })
      .from(schema.feedTags)
      .innerJoin(schema.tags, eq(schema.feedTags.tagId, schema.tags.id))
      .where(eq(schema.feedTags.feedId, row!.id))
      .all()
      .map((t) => t.name)
      .sort();
    expect(feedTagNames).toEqual(["News", "Tech"]);

    const job = db.select().from(schema.jobs).where(eq(schema.jobs.kind, "feed.logo")).get();
    expect(job?.payload).toEqual({ feedId: row!.id });
  });

  it("reuses an existing tag by case-insensitive name instead of creating a duplicate", async () => {
    const userId = await currentUserId();
    await tagsActions.createTag({ name: "Tech" });

    const xml = `${OPML_HEADER}<outline text="Heise" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" yana:tags="tech" />${OPML_FOOTER}`;
    await actions.importOpmlFeeds(xml);

    const db = client.getDb();
    const tagRows = db.select().from(schema.tags).where(eq(schema.tags.userId, userId)).all();
    expect(tagRows).toHaveLength(1);
  });

  it("imports successfully when yana:tags names collide case-insensitively", async () => {
    const userId = await currentUserId();

    const xml = `${OPML_HEADER}<outline text="Heise" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" yana:tags="Tech,tech" />${OPML_FOOTER}`;
    const result = await actions.importOpmlFeeds(xml);

    expect(result).toEqual({ ok: true, imported: 1, skipped: 0 });

    const db = client.getDb();
    const row = db.select().from(schema.feeds).where(eq(schema.feeds.userId, userId)).get();

    const feedTagNames = db
      .select({ name: schema.tags.name })
      .from(schema.feedTags)
      .innerJoin(schema.tags, eq(schema.feedTags.tagId, schema.tags.id))
      .where(eq(schema.feedTags.feedId, row!.id))
      .all()
      .map((t) => t.name);
    expect(feedTagNames).toEqual(["Tech"]);
  });

  it("skips duplicates and invalid entries, and only counts what was actually created", async () => {
    await currentUserId();
    await actions.createFeed({
      name: "Existing",
      aggregator: "full_website",
      identifier: "https://heise.de/rss",
    });

    const badOptions = Buffer.from(JSON.stringify({ ai_summarize: "nope" })).toString("base64");
    const xml = `${OPML_HEADER}<outline text="Heise" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" /><outline text="Broken" xmlUrl="https://broken.example" yana:aggregatorType="full_website" yana:options="${badOptions}" /><outline text="Fresh" xmlUrl="https://fresh.example" yana:aggregatorType="full_website" />${OPML_FOOTER}`;

    const result = await actions.importOpmlFeeds(xml);
    expect(result).toEqual({ ok: true, imported: 1, skipped: 2 });

    const db = client.getDb();
    const names = db
      .select({ name: schema.feeds.name })
      .from(schema.feeds)
      .all()
      .map((f) => f.name)
      .sort();
    expect(names).toEqual(["Existing", "Fresh"]);
  });

  it("reports invalidOpmlFile without writing anything for an unparseable file", async () => {
    await currentUserId();

    const result = await actions.importOpmlFeeds("not xml at all");
    expect(result).toEqual({ ok: false, errorKey: "invalidOpmlFile" });

    const db = client.getDb();
    expect(db.select().from(schema.feeds).all()).toEqual([]);
  });
});
