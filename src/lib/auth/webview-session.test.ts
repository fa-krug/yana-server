import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

describe("mintWebviewSessionToken", () => {
  let dbPath: string;
  let mintWebviewSessionToken: typeof import("./webview-session").mintWebviewSessionToken;
  let createUserWithPassword: typeof import("./server").createUserWithPassword;
  let createDeviceSession: typeof import("./server").createDeviceSession;
  let auth: typeof import("./server").auth;

  beforeEach(async () => {
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-webview-session-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession, auth } = await import("./server"));
    ({ mintWebviewSessionToken } = await import("./webview-session"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  it("mints a token that verifyOneTimeToken exchanges for the same session", async () => {
    const owner = await createUserWithPassword({
      email: "device-owner-2@example.com",
      password: "correct horse battery staple",
      name: "Device Owner",
    });
    const { token: sessionToken } = await createDeviceSession(owner.id, "Test Device");

    const { token, expiresAt } = await mintWebviewSessionToken(sessionToken);

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const verified = await auth.api.verifyOneTimeToken({ body: { token } });
    expect(verified.user.id).toBe(owner.id);
    expect(verified.session.token).toBe(sessionToken);
  });

  it("mints a token that cannot be verified twice", async () => {
    const owner = await createUserWithPassword({
      email: "device-owner-3@example.com",
      password: "correct horse battery staple",
      name: "Device Owner",
    });
    const { token: sessionToken } = await createDeviceSession(owner.id, "Test Device");
    const { token } = await mintWebviewSessionToken(sessionToken);

    await auth.api.verifyOneTimeToken({ body: { token } });

    await expect(auth.api.verifyOneTimeToken({ body: { token } })).rejects.toThrow();
  });
});
