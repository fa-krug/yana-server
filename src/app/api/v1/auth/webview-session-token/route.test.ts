import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/server", () => import("@/test/next-server"));

describe("POST /api/v1/auth/webview-session-token", () => {
  let dbPath: string;
  let POST: typeof import("./route").POST;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;

  beforeEach(async () => {
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-webview-token-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    ({ POST } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  it("401s with no Authorization header", async () => {
    const response = await POST(
      new Request("https://example.com/api/v1/auth/webview-session-token", { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });

  it("mints a token for a valid device session", async () => {
    const owner = await createUserWithPassword({
      email: "route-owner@example.com",
      password: "correct horse battery staple",
      name: "Route Owner",
    });
    const { token: sessionToken } = await createDeviceSession(owner.id, "Test Device");

    const response = await POST(
      new Request("https://example.com/api/v1/auth/webview-session-token", {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}` },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.token).toBe("string");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});
