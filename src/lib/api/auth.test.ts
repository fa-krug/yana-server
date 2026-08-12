import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

describe("requireApiUser", () => {
  let dbPath: string;
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let testSupport: typeof import("@/lib/auth/test-support");
  let apiAuth: typeof import("./auth");

  beforeEach(async () => {
    // Every dynamically-imported module below (this file's own `./auth`
    // included) reaches `@/lib/db/client`, whose `DB_PATH` constant is
    // computed once, at that module's first evaluation, from
    // `process.env.DATABASE_PATH`. Without resetting the module registry
    // first, a later test in this file would still be holding the *first*
    // test's cached module -- and its `DB_PATH` frozen at whatever the
    // environment variable held at that first import, not this test's fresh
    // temp file. `src/lib/auth/server.test.ts` does the same reset for the
    // same reason.
    vi.resetModules();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-api-auth-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    testSupport = await import("@/lib/auth/test-support");
    apiAuth = await import("./auth");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    fs.rmSync(dbPath, { force: true });
  });

  it("resolves a valid device session token to its user", async () => {
    const user = await createUserWithPassword({
      email: "a@example.com",
      password: "correct horse battery staple",
    });
    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession(user.id, false, {
      deviceName: "Test iPhone",
    });

    const request = new Request("https://example.com/api/v1/feeds", {
      headers: { authorization: `Bearer ${session.token}` },
    });

    const resolved = await apiAuth.requireApiUser(request);
    expect(resolved.id).toBe(user.id);
  });

  it("falls back to the ordinary cookie session when there is no Authorization header", async () => {
    const user = await createUserWithPassword({
      email: "cookie@example.com",
      password: "correct horse battery staple",
    });
    const cookie = await testSupport.signInCookie(auth, {
      email: "cookie@example.com",
      password: "correct horse battery staple",
    });

    const request = new Request("https://example.com/api/v1/feeds", {
      headers: { cookie },
    });

    const resolved = await apiAuth.requireApiUser(request);
    expect(resolved.id).toBe(user.id);
  });

  it("prefers the Bearer token over a cookie when both are present", async () => {
    const bearerUser = await createUserWithPassword({
      email: "bearer@example.com",
      password: "correct horse battery staple",
    });
    const cookieUser = await createUserWithPassword({
      email: "cookie2@example.com",
      password: "correct horse battery staple",
    });
    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession(bearerUser.id, false, {
      deviceName: "Test iPhone",
    });
    const cookie = await testSupport.signInCookie(auth, {
      email: "cookie2@example.com",
      password: "correct horse battery staple",
    });

    const request = new Request("https://example.com/api/v1/feeds", {
      headers: { authorization: `Bearer ${session.token}`, cookie },
    });

    const resolved = await apiAuth.requireApiUser(request);
    expect(resolved.id).toBe(bearerUser.id);
    expect(resolved.id).not.toBe(cookieUser.id);
  });

  it("rejects a missing or garbage token", async () => {
    const request = new Request("https://example.com/api/v1/feeds", {
      headers: { authorization: "Bearer not-a-real-token" },
    });

    await expect(apiAuth.requireApiUser(request)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects an Authorization header with no token after 'Bearer '", async () => {
    const request = new Request("https://example.com/api/v1/feeds", {
      headers: { authorization: "Bearer " },
    });

    await expect(apiAuth.requireApiUser(request)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects an Authorization scheme other than Bearer, without a cookie fallback", async () => {
    const request = new Request("https://example.com/api/v1/feeds", {
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });

    await expect(apiAuth.requireApiUser(request)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects with no Authorization header and no cookie", async () => {
    const request = new Request("https://example.com/api/v1/feeds");
    await expect(apiAuth.requireApiUser(request)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects an expired device session token", async () => {
    const user = await createUserWithPassword({
      email: "expired@example.com",
      password: "correct horse battery staple",
    });
    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession(user.id, false, {
      deviceName: "Test iPhone",
    });

    // Backdate the session's expiry directly -- there is no public API to mint
    // an already-expired one, and this is the one thing that distinguishes
    // "expired" from "malformed" in requireApiUser's Bearer branch.
    const client = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    client
      .getDb()
      .update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.sessions.id, session.id))
      .run();

    const request = new Request("https://example.com/api/v1/feeds", {
      headers: { authorization: `Bearer ${session.token}` },
    });

    await expect(apiAuth.requireApiUser(request)).rejects.toMatchObject({ status: 401 });
  });

  it("apiErrorResponse serializes an ApiError as a JSON 401", async () => {
    const error = new apiAuth.ApiError(401, "unauthorized", "Sign in required.");
    const response = apiAuth.apiErrorResponse(error);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "unauthorized", message: "Sign in required." } });
  });
});

describe("requireApiBearerSession", () => {
  let dbPath: string;
  let requireApiBearerSession: typeof import("./auth").requireApiBearerSession;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;

  beforeEach(async () => {
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-api-auth-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    ({ requireApiBearerSession } = await import("./auth"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  it("rejects a request with no Authorization header", async () => {
    await expect(
      requireApiBearerSession(new Request("https://example.com/api/v1/x")),
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("rejects a non-bearer scheme", async () => {
    await expect(
      requireApiBearerSession(
        new Request("https://example.com/api/v1/x", { headers: { authorization: "Basic abc" } }),
      ),
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("returns the user and the raw session token for a valid bearer", async () => {
    const owner = await createUserWithPassword({
      email: "device-owner@example.com",
      password: "correct horse battery staple",
      name: "Device Owner",
    });
    const { token } = await createDeviceSession(owner.id, "Test Device");

    const result = await requireApiBearerSession(
      new Request("https://example.com/api/v1/x", { headers: { authorization: `Bearer ${token}` } }),
    );

    expect(result.user.id).toBe(owner.id);
    expect(result.token).toBe(token);
  });
});
