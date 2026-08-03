import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const PASSWORD = "correct horse battery staple";

describe("searchFeedIdentifier", () => {
  let dbPath: string;
  let search: typeof import("./search");
  let client: typeof import("@/lib/db/client");
  let raw: (db: unknown) => import("better-sqlite3").Database;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-search-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    const { auth, createUserWithPassword } = await import("@/lib/auth/server");
    client = await import("@/lib/db/client");
    raw = (db) => (db as { $client: import("better-sqlite3").Database }).$client;

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

    search = await import("./search");
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

  it("returns no results without calling the network when the query is under 2 characters", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const result = await search.searchFeedIdentifier("youtube", "a");
    expect(result).toEqual({ ok: true, results: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports unavailable when youtube is not configured", async () => {
    const result = await search.searchFeedIdentifier("youtube", "linus");
    expect(result).toEqual({ ok: false, errorKey: "identifierSearch.unavailable" });
  });

  it("reports unavailable when reddit is not configured", async () => {
    const result = await search.searchFeedIdentifier("reddit", "programming");
    expect(result).toEqual({ ok: false, errorKey: "identifierSearch.unavailable" });
  });

  it("rejects an aggregator with no search capability", async () => {
    const result = await search.searchFeedIdentifier("heise", "anything");
    expect(result).toEqual({ ok: false, errorKey: "identifierSearch.unavailable" });
  });

  it("searches youtube channels and maps id/title/handle when configured", async () => {
    raw(client.getDb()).exec(
      `UPDATE user_settings SET youtube_enabled = 1, youtube_api_key = 'test-key'`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string | URL) => {
        const href = url.toString();
        if (href.includes("/search")) {
          return Promise.resolve(
            new Response(JSON.stringify({ items: [{ id: { channelId: "UC123" } }] })),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{ id: "UC123", snippet: { title: "Linus Tech Tips", customUrl: "ltt" } }],
            }),
          ),
        );
      }),
    );

    const result = await search.searchFeedIdentifier("youtube", "linus");
    expect(result).toEqual({
      ok: true,
      results: [{ value: "UC123", label: "Linus Tech Tips (@ltt)" }],
    });
  });

  it("searches subreddits and maps display_name/title/subscribers when configured", async () => {
    raw(client.getDb()).exec(
      `UPDATE user_settings SET reddit_enabled = 1, reddit_client_id = 'id', reddit_client_secret = 'secret', reddit_user_agent = 'Yana/1.0 (test)'`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string | URL) => {
        const href = url.toString();
        if (href.includes("access_token")) {
          return Promise.resolve(new Response(JSON.stringify({ access_token: "tok" })));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                children: [
                  {
                    data: {
                      display_name: "programming",
                      title: "Programming",
                      subscribers: 5000000,
                    },
                  },
                ],
              },
            }),
          ),
        );
      }),
    );

    const result = await search.searchFeedIdentifier("reddit", "programming");
    expect(result).toEqual({
      ok: true,
      results: [{ value: "programming", label: "r/programming: Programming (5,000,000 subs)" }],
    });
  });

  it("reports unavailable rather than throwing on a transport failure", async () => {
    raw(client.getDb()).exec(
      `UPDATE user_settings SET youtube_enabled = 1, youtube_api_key = 'test-key'`,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }),
        ),
    );

    const result = await search.searchFeedIdentifier("youtube", "linus");
    expect(result).toEqual({ ok: false, errorKey: "identifierSearch.unavailable" });
  });
});
