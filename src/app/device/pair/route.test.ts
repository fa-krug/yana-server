import { eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

const { requestHeaders, cookieJar } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  cookieJar: new Map<string, string>(),
}));

vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders, cookieJar),
);
vi.mock("next/server", () => import("@/test/next-server"));

describe("GET /device/pair", () => {
  let dbPath: string;
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let signInCookie: typeof import("@/lib/auth/test-support").signInCookie;
  let GET: typeof import("./route").GET;
  let startGET: typeof import("./start/route").GET;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  beforeEach(async () => {
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-device-pair-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";
    requestHeaders.current = new Headers();
    cookieJar.clear();

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    ({ signInCookie } = await import("@/lib/auth/test-support"));
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    ({ GET } = await import("./route"));
    ({ GET: startGET } = await import("./start/route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  /** Sign in a fresh user and attach the resulting cookie to the next request. */
  async function signIn(): Promise<import("@/lib/db/schema").User> {
    const user = await createUserWithPassword({
      email: "a@example.com",
      password: "correct horse battery staple",
    });
    (client.getDb() as unknown as { $client: import("better-sqlite3").Database }).$client.exec(
      `INSERT INTO user_settings (user_id) VALUES ('${user.id}')`,
    );
    const cookie = await signInCookie(auth, {
      email: "a@example.com",
      password: "correct horse battery staple",
    });
    requestHeaders.current = new Headers({ cookie });
    return user;
  }

  /** Mint a real, valid state via the actual /device/pair/start route. */
  async function mintState(): Promise<string> {
    const response = await startGET();
    const body = (await response.json()) as { state: string };
    return body.state;
  }

  /** Insert a state row directly, for the expired/used failure cases. */
  function insertState(overrides: { expiresAt: Date; usedAt: Date | null }): string {
    const state = `test-state-${Math.random().toString(36).slice(2)}`;
    client.writeTransaction((tx) => {
      tx.insert(schema.devicePairingStates)
        .values({ state, expiresAt: overrides.expiresAt, usedAt: overrides.usedAt })
        .run();
    });
    return state;
  }

  function sessionCount(userId?: string): number {
    const query = client.getDb().select().from(schema.sessions);
    const rows = userId ? query.where(eq(schema.sessions.userId, userId)).all() : query.all();
    return rows.length;
  }

  it("mints a device session and redirects to the custom scheme with its token", async () => {
    const user = await signIn();
    const state = await mintState();

    const request = new Request(
      `https://example.com/device/pair?state=${state}&scheme=yana&deviceName=Test%20iPhone`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("yana://auth-callback?token=")).toBe(true);

    const token = new URL(location.replace("yana://", "https://")).searchParams.get("token");
    const row = client
      .getDb()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.token, token!))
      .get();
    expect(row?.deviceName).toBe("Test iPhone");
    expect(row?.userId).toBe(user.id);

    // The minted device session must be a genuinely separate row from the
    // browser session `signIn()` just created above, not a copy of it.
    expect(sessionCount(user.id)).toBe(2);
  });

  it("redirects to /login when there is no session, and mints no session row", async () => {
    requestHeaders.current = new Headers();
    const request = new Request("https://example.com/device/pair?scheme=yana&deviceName=X");

    const before = sessionCount();

    await expect(GET(request)).rejects.toThrow(); // requireUser()'s redirect surfaces as a thrown Next redirect in this harness

    expect(sessionCount()).toBe(before);
  });

  it("400s when the state param is missing, and mints no session row", async () => {
    await signIn();
    const before = sessionCount();

    const request = new Request("https://example.com/device/pair?scheme=yana&deviceName=X");
    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(sessionCount()).toBe(before);
  });

  it("400s when the state does not exist, and mints no session row", async () => {
    await signIn();
    const before = sessionCount();

    const request = new Request(
      "https://example.com/device/pair?state=never-issued&scheme=yana&deviceName=X",
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(sessionCount()).toBe(before);
  });

  it("400s when the state is expired, and mints no session row", async () => {
    await signIn();
    const state = insertState({ expiresAt: new Date(Date.now() - 60_000), usedAt: null });
    const before = sessionCount();

    const request = new Request(
      `https://example.com/device/pair?state=${state}&scheme=yana&deviceName=X`,
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(sessionCount()).toBe(before);
  });

  it("400s when the state is already used, and mints no session row", async () => {
    await signIn();
    const state = insertState({
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: new Date(),
    });
    const before = sessionCount();

    const request = new Request(
      `https://example.com/device/pair?state=${state}&scheme=yana&deviceName=X`,
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(sessionCount()).toBe(before);
  });

  it("consumes a state on first use; reusing it 400s and only one session is created", async () => {
    const user = await signIn();
    const state = await mintState();

    const first = await GET(
      new Request(`https://example.com/device/pair?state=${state}&scheme=yana&deviceName=X`),
    );
    expect(first.status).toBe(307);
    expect(sessionCount(user.id)).toBe(2); // browser session + device session

    const second = await GET(
      new Request(`https://example.com/device/pair?state=${state}&scheme=yana&deviceName=Y`),
    );
    expect(second.status).toBe(400);
    expect(sessionCount(user.id)).toBe(2); // unchanged -- no second device session
  });

  it("400s when scheme is outside the allow-list, even with a valid unused state", async () => {
    await signIn();
    const state = await mintState();
    const before = sessionCount();

    const request = new Request(
      `https://example.com/device/pair?state=${state}&scheme=https&deviceName=X`,
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(sessionCount()).toBe(before);
  });
});
