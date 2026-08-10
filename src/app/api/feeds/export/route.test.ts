import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";
import { decodeOpml } from "@/lib/feeds/opml";

const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders),
);

const REDIRECT = /^NEXT_REDIRECT/;
const PASSWORD = "correct horse battery staple";

describe("GET /api/feeds/export", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  function get(query = ""): Promise<Response> {
    return GET(new Request(`http://localhost/api/feeds/export${query}`));
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-feeds-export-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    ({ GET } = await import("./route"));
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

  async function seedUser(email: string): Promise<{ id: string; cookie: string }> {
    const user = await createUserWithPassword({
      email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    raw(client.getDb()).exec(`INSERT INTO user_settings (user_id) VALUES ('${user.id}')`);
    return { id: user.id, cookie: await signInCookie(auth, { email, password: PASSWORD }) };
  }

  function insertFeed(userId: string, name: string): { id: number } {
    return client
      .getDb()
      .insert(schema.feeds)
      .values({
        name,
        aggregator: "full_website",
        identifier: `https://example.com/${name}`,
        userId,
      })
      .returning({ id: schema.feeds.id })
      .get();
  }

  it("exports every feed the caller owns", async () => {
    const owner = await seedUser("owner@example.com");
    insertFeed(owner.id, "FeedA");
    insertFeed(owner.id, "FeedB");
    requestAs(owner.cookie);

    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-opml+xml; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="yana-feeds.opml"',
    );

    const entries = decodeOpml(await response.text());
    expect(entries.map((e) => e.name).sort()).toEqual(["FeedA", "FeedB"]);
  });

  it("exports only the requested ids, still scoped to the caller", async () => {
    const owner = await seedUser("owner@example.com");
    const other = await seedUser("other@example.com");
    const keep = insertFeed(owner.id, "KeepMe");
    insertFeed(owner.id, "LeaveMeOut");
    const foreign = insertFeed(other.id, "NotYours");
    requestAs(owner.cookie);

    const response = await get(`?ids=${keep.id},${foreign.id}`);
    const entries = decodeOpml(await response.text());

    expect(entries.map((e) => e.name)).toEqual(["KeepMe"]);
  });

  it("refuses an unauthenticated request", async () => {
    await expect(get()).rejects.toMatchObject({ digest: expect.stringMatching(REDIRECT) });
  });
});
