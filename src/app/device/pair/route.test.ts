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

describe("GET /device/pair", () => {
  let dbPath: string;
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let signInCookie: typeof import("@/lib/auth/test-support").signInCookie;
  let GET: typeof import("./route").GET;
  let client: typeof import("@/lib/db/client");

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
    ({ GET } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  it("mints a device session and redirects to the custom scheme with its token", async () => {
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

    const request = new Request(
      "https://example.com/device/pair?scheme=yana&deviceName=Test%20iPhone",
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("yana://auth-callback?token=")).toBe(true);

    const token = new URL(location.replace("yana://", "https://")).searchParams.get("token");
    const { sessions } = await import("@/lib/db/schema");
    const row = client.getDb().select().from(sessions).where(eq(sessions.token, token!)).get();
    expect(row?.deviceName).toBe("Test iPhone");
    expect(row?.userId).toBe(user.id);

    // The minted device session must be a genuinely separate row from the
    // browser session `signInCookie()` just created above, not a copy of it.
    const browserSessionCount = client
      .getDb()
      .select()
      .from(sessions)
      .where(eq(sessions.userId, user.id))
      .all().length;
    expect(browserSessionCount).toBe(2);
  });

  it("redirects to /login when there is no session, and mints no session row", async () => {
    requestHeaders.current = new Headers();
    const request = new Request("https://example.com/device/pair?scheme=yana&deviceName=X");

    const { sessions } = await import("@/lib/db/schema");
    const before = client.getDb().select().from(sessions).all().length;

    await expect(GET(request)).rejects.toThrow(); // requireUser()'s redirect surfaces as a thrown Next redirect in this harness

    const after = client.getDb().select().from(sessions).all().length;
    expect(after).toBe(before);
  });
});
