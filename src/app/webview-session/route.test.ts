import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

describe("GET /webview-session", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;
  let mintWebviewSessionToken: typeof import("@/lib/auth/webview-session").mintWebviewSessionToken;

  beforeEach(async () => {
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-webview-session-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    ({ mintWebviewSessionToken } = await import("@/lib/auth/webview-session"));
    ({ GET } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  it("sets the session cookie and redirects to next on a valid token", async () => {
    const owner = await createUserWithPassword({
      email: "wv-owner@example.com",
      password: "correct horse battery staple",
      name: "WV Owner",
    });
    const { token: sessionToken } = await createDeviceSession(owner.id, "Test Device");
    const { token } = await mintWebviewSessionToken(sessionToken);

    const response = await GET(
      new Request(`https://example.com/webview-session?token=${token}&next=/feeds`),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/feeds");
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  it("redirects to /login on an invalid token", async () => {
    const response = await GET(
      new Request("https://example.com/webview-session?token=not-a-real-token&next=/feeds"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/login?next=%2Ffeeds");
    expect(response.headers.getSetCookie().length).toBe(0);
  });

  it("redirects to /login when the token is missing", async () => {
    const response = await GET(new Request("https://example.com/webview-session"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/login?next=%2Ffeeds");
  });

  it("cannot be used to redirect off-site via an absolute next", async () => {
    const owner = await createUserWithPassword({
      email: "wv-owner-2@example.com",
      password: "correct horse battery staple",
      name: "WV Owner",
    });
    const { token: sessionToken } = await createDeviceSession(owner.id, "Test Device");
    const { token } = await mintWebviewSessionToken(sessionToken);

    const response = await GET(
      new Request(
        `https://example.com/webview-session?token=${token}&next=${encodeURIComponent("https://evil.example.com")}`,
      ),
    );

    expect(response.headers.get("location")).toBe("https://example.com/feeds");
  });

  it("cannot be used to redirect off-site via a protocol-relative next", async () => {
    const owner = await createUserWithPassword({
      email: "wv-owner-3@example.com",
      password: "correct horse battery staple",
      name: "WV Owner",
    });
    const { token: sessionToken } = await createDeviceSession(owner.id, "Test Device");
    const { token } = await mintWebviewSessionToken(sessionToken);

    const response = await GET(
      new Request(
        `https://example.com/webview-session?token=${token}&next=${encodeURIComponent("//evil.example.com")}`,
      ),
    );

    expect(response.headers.get("location")).toBe("https://example.com/feeds");
  });
});
