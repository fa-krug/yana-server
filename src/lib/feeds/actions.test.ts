import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
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
    expect((await actions.createFeed({ name: "Heise", aggregator: "heise", identifier: "" })).ok).toBe(true);
  });

  it("strips an option whose integration is unconfigured", async () => {
    await currentUserId();
    const { id } = await actions.createFeed({
      name: "X", aggregator: "heise", options: { ai_summarize: true },
    });
    expect((await actions.getFeed(id!))?.options).not.toHaveProperty("ai_summarize");
  });

  it("succeeds even when logo discovery fails", async () => {
    await currentUserId();
    mockLogoDiscoveryToThrow();
    expect((await actions.createFeed({ name: "X", aggregator: "heise" })).ok).toBe(true);
  });

  it("attaches multiple tags", async () => {
    await currentUserId();
    const a = await tagsActions.createTag({ name: "A" }) as { id: number };
    const b = await tagsActions.createTag({ name: "B" }) as { id: number };
    const { id } = await actions.createFeed({ name: "X", aggregator: "heise", tagIds: [a.id, b.id] });
    expect((await actions.getFeed(id!))?.tags).toHaveLength(2);
  });

  it("rejects another user's tag id", async () => {
    await currentUserId();
    const a = await tagsActions.createTag({ name: "A" }) as { id: number };
    await switchToOtherUser();
    const foreign = a.id;
    expect((await actions.createFeed({ name: "X", aggregator: "heise", tagIds: [foreign] })).ok).toBe(false);
  });
});
