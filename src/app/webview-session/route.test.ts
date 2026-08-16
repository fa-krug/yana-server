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
    expect(response.headers.get("location")).toBe("/feeds");
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  // Regression: behind a reverse proxy the standalone server sees its own
  // listening address as `request.url` (`http://0.0.0.0:3000/...`), so an
  // absolute `Location` built from it sent `ManagementWebView` to
  // `http://0.0.0.0:3000/feeds` -- which WebKit refuses outright
  // (WebKitErrorDomain 103, "restricted network access not allowed").
  it("never derives the redirect origin from the request URL", async () => {
    const owner = await createUserWithPassword({
      email: "wv-owner-8@example.com",
      password: "correct horse battery staple",
      name: "WV Owner",
    });
    const { token: sessionToken } = await createDeviceSession(owner.id, "Test Device");
    const { token } = await mintWebviewSessionToken(sessionToken);

    const ok = await GET(
      new Request(`http://0.0.0.0:3000/webview-session?token=${token}&next=/feeds`),
    );
    expect(ok.headers.get("location")).toBe("/feeds");

    const failed = await GET(
      new Request("http://0.0.0.0:3000/webview-session?token=nope&next=/feeds"),
    );
    expect(failed.headers.get("location")).toBe("/login?next=%2Ffeeds");
  });

  it("redirects to /login on an invalid token", async () => {
    const response = await GET(
      new Request("https://example.com/webview-session?token=not-a-real-token&next=/feeds"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?next=%2Ffeeds");
    expect(response.headers.getSetCookie().length).toBe(0);
  });

  it("redirects to /login when the token is missing", async () => {
    const response = await GET(new Request("https://example.com/webview-session"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?next=%2F");
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

    expect(response.headers.get("location")).toBe("/");
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

    expect(response.headers.get("location")).toBe("/");
  });

  it("cannot be used to redirect off-site via a backslash that the URL parser normalizes to a slash", async () => {
    const owner = await createUserWithPassword({
      email: "wv-owner-4@example.com",
      password: "correct horse battery staple",
      name: "WV Owner",
    });
    const { token: sessionToken } = await createDeviceSession(owner.id, "Test Device");
    const { token } = await mintWebviewSessionToken(sessionToken);

    const response = await GET(
      new Request(
        `https://example.com/webview-session?token=${token}&next=${encodeURIComponent("/\\evil.example.com")}`,
      ),
    );

    expect(response.headers.get("location")).toBe("/");
  });

  it("cannot be used to redirect off-site via an embedded tab that the URL parser strips", async () => {
    const owner = await createUserWithPassword({
      email: "wv-owner-5@example.com",
      password: "correct horse battery staple",
      name: "WV Owner",
    });
    const { token: sessionToken } = await createDeviceSession(owner.id, "Test Device");
    const { token } = await mintWebviewSessionToken(sessionToken);

    const response = await GET(
      new Request(
        `https://example.com/webview-session?token=${token}&next=${encodeURIComponent("/\t/evil.example.com")}`,
      ),
    );

    expect(response.headers.get("location")).toBe("/");
  });

  it("cannot be used to redirect off-site via a same-origin absolute next whose pathname is a network-path reference", async () => {
    const owner = await createUserWithPassword({
      email: "wv-owner-6@example.com",
      password: "correct horse battery staple",
      name: "WV Owner",
    });
    const { token: sessionToken } = await createDeviceSession(owner.id, "Test Device");
    const { token } = await mintWebviewSessionToken(sessionToken);

    const response = await GET(
      new Request(
        `https://example.com/webview-session?token=${token}&next=${encodeURIComponent("https://example.com//evil.example.com")}`,
      ),
    );

    const location = response.headers.get("location");
    // `Location` is a relative reference, so the browser resolves it against
    // the page's own origin -- which must stay `example.com`. The embedded
    // "evil.example.com" segment, if present at all, must land inside the
    // same-origin path, never let the browser navigate to a different host.
    // (A leading "//" here would re-parse as a network-path reference and
    // escape the origin, which is precisely what `safeNextPath()` refuses.)
    expect(location!.startsWith("//")).toBe(false);
    expect(new URL(location!, "https://example.com").origin).toBe("https://example.com");
  });

  it("refuses /login as a next target, falling back to the dashboard", async () => {
    const owner = await createUserWithPassword({
      email: "wv-owner-7@example.com",
      password: "correct horse battery staple",
      name: "WV Owner",
    });
    const { token: sessionToken } = await createDeviceSession(owner.id, "Test Device");
    const { token } = await mintWebviewSessionToken(sessionToken);

    const response = await GET(
      new Request(`https://example.com/webview-session?token=${token}&next=/login`),
    );

    expect(response.headers.get("location")).toBe("/");
  });

  // Regression: this route used to override `safeNextPath()`'s own default
  // (`/`) with `/feeds`, which is indistinguishable from an explicit
  // `next=/` by the time the guard has resolved it -- so the native client's
  // `ManagementWebView`, which asks for the site root, always landed on the
  // feed list instead of the dashboard.
  it("honours an explicit next=/ instead of rewriting it to the feed list", async () => {
    const owner = await createUserWithPassword({
      email: "wv-owner-9@example.com",
      password: "correct horse battery staple",
      name: "WV Owner",
    });
    const { token: sessionToken } = await createDeviceSession(owner.id, "Test Device");
    const { token } = await mintWebviewSessionToken(sessionToken);

    const response = await GET(
      new Request(`https://example.com/webview-session?token=${token}&next=%2F`),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
  });
});
