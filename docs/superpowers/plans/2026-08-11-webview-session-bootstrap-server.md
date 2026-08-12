# Webview Session Bootstrap (Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a paired native device (yana-ios) bootstrap a real browser session for the server's own web UI, without ever handling the raw session cookie value client-side and without relying on `ASWebAuthenticationSession`'s cookie jar being visible to a `WKWebView` (which App Sandbox breaks on Mac Catalyst).

**Architecture:** The device's existing Bearer token authenticates a call to a new endpoint, `POST /api/v1/auth/webview-session-token`, which mints a short-lived (60s), single-use token bound to that *same* device session (not a new one). The native app loads a plain `GET /webview-session?token=...&next=...` URL into its `WKWebView`; that route consumes the token via Better Auth's installed `oneTimeToken` plugin (which sets the real session cookie itself, using its own vetted signing/attribute logic) and redirects into the target page. An invalid/expired/consumed token degrades to a normal `/login` redirect.

**Tech Stack:** Next.js 16 (App Router, Route Handlers), better-auth 1.6.25 (`oneTimeToken` plugin, reusing its built-in `verifications` table — no new migration), Drizzle ORM / SQLite, Vitest.

## Global Constraints

- Every new API route follows the existing `await connection()` (first statement) → `try { requireApiUser/requireApiBearerSession } catch (ApiError) → apiErrorResponse` convention already used by every `/api/v1/**` route (see `src/app/api/v1/feeds/route.ts`).
- Never expose a plugin endpoint over raw HTTP unless it is meant to be called directly — close new plugin paths via `disabledPaths` and reach them via `auth.api.*` from server code, exactly like `ADMIN_PLUGIN_PATHS` already does.
- Never hand-construct or hand-sign a better-auth session cookie. Only `setSessionCookie()` (better-auth's own internal call, reached indirectly via `auth.api.verifyOneTimeToken({ asResponse: true })`) may write that cookie.
- `Response.redirect(url, status)` returns a `Response` with **immutable headers** — you cannot `.append()` a `Set-Cookie` onto it afterward. Build redirect responses with `new Response(null, { status, headers })` instead, whenever a cookie must ride along.
- `next` (the post-login redirect target) must be validated as an in-app relative path (starts with `/`, not `//`) before use, to prevent an open redirect.
- No new database table or migration is needed — this reuses better-auth's own `verifications` table via the `oneTimeToken` plugin's existing storage convention.

---

### Task 1: Install the `oneTimeToken` plugin and close its HTTP surface

**Files:**
- Modify: `src/lib/auth/server.ts` (plugins array around line 230-283, `disabledPaths` around line 91-101/191)
- Modify: `src/lib/auth/server.test.ts` (mirrors the existing `DECLARED_ADMIN_PATHS`/`ADMIN_PLUGIN_PATHS` pinning test)

**Interfaces:**
- Produces: `ONE_TIME_TOKEN_PLUGIN_PATHS: string[]` exported from `src/lib/auth/server.ts`, consumed by Task 1's own test only.
- Produces: the `auth` object now has a working `auth.api.verifyOneTimeToken({ body: { token }, asResponse: true })` and `internalAdapter.createVerificationValue(...)` continues to work as before — both consumed by Task 3 and Task 5.

- [ ] **Step 1: Add the plugin import and `ONE_TIME_TOKEN_PLUGIN_PATHS` constant**

In `src/lib/auth/server.ts`, add the import next to the other plugin imports near the top:

```ts
import { oneTimeToken } from "better-auth/plugins";
```

(`admin` is already imported from `"better-auth/plugins"` on an existing line — add `oneTimeToken` to that same import statement rather than a new one.)

Add this constant near `ADMIN_PLUGIN_PATHS` (same file, same style — copied from the library's own declared paths, not memory):

```ts
/**
 * Every `/one-time-token/*` path the installed `oneTimeToken()` plugin
 * declares. Closed via `disabledPaths` below for the same reason
 * `ADMIN_PLUGIN_PATHS` is: this app never calls either endpoint over HTTP.
 * `generate` is unusable over HTTP here anyway (see the module doc on
 * `mintWebviewSessionToken` in `src/lib/auth/webview-session.ts` for why:
 * it resolves its caller via `sessionMiddleware`, cookie-only, and this app
 * has no `bearer()` plugin installed). `verify` is called exclusively via
 * `auth.api.verifyOneTimeToken()` from `src/app/webview-session/route.ts`.
 * Pinned against the installed library by `server.test.ts`.
 */
export const ONE_TIME_TOKEN_PLUGIN_PATHS = ["/one-time-token/generate", "/one-time-token/verify"];
```

- [ ] **Step 2: Register the plugin and extend `disabledPaths`**

In the `plugins` array, add `oneTimeToken(...)` after `admin(...)` and before `nextCookies()` (order matters — `nextCookies()` must stay last, per the existing comment on that line):

```ts
    oneTimeToken({
      expiresIn: 1, // minutes; the shortest granularity the plugin supports
      disableClientRequest: true, // belt-and-suspenders alongside disabledPaths below
    }),
    nextCookies(),
```

Update the `disabledPaths` line to:

```ts
  disabledPaths: ["/update-user", ...ADMIN_PLUGIN_PATHS, ...ONE_TIME_TOKEN_PLUGIN_PATHS],
```

- [ ] **Step 3: Write the pinning test**

In `src/lib/auth/server.test.ts`, add a `DECLARED_ONE_TIME_TOKEN_PATHS` constant near `DECLARED_ADMIN_PATHS` (same file-scraping approach, different source file and path prefix):

```ts
const DECLARED_ONE_TIME_TOKEN_PATHS: string[] = [
  ...new Set(
    [
      ...fs
        .readFileSync(
          path.join(
            path.resolve(import.meta.dirname, "../../.."),
            "node_modules/better-auth/dist/plugins/one-time-token/index.mjs",
          ),
          "utf8",
        )
        .matchAll(/createAuthEndpoint\(\s*"(\/one-time-token\/[a-z-]+)"/g),
    ].map((match) => match[1]),
  ),
].toSorted();
```

Add this test in the same `describe` block as the existing admin-path tests:

```ts
  it.each(DECLARED_ONE_TIME_TOKEN_PATHS)("refuses to route %s", async (ottPath) => {
    const request = new Request(`http://localhost:3000/api/auth${ottPath}`, {
      method: ottPath === "/one-time-token/generate" ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: ottPath === "/one-time-token/generate" ? undefined : "{}",
    });
    const response =
      ottPath === "/one-time-token/generate" ? await route.GET(request) : await route.POST(request);

    expect(response.status).toBe(404);
  });

  it("names every one-time-token endpoint the installed plugin declares", async () => {
    const { ONE_TIME_TOKEN_PLUGIN_PATHS } = await import("./server");

    expect(ONE_TIME_TOKEN_PLUGIN_PATHS.toSorted()).toEqual(DECLARED_ONE_TIME_TOKEN_PATHS);
  });
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/auth/server.test.ts`
Expected: all tests pass, including the two new ones (both `it.each` cases 404, and the path-list equality check).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/server.ts src/lib/auth/server.test.ts
git commit -m "feat: install one-time-token plugin, closed to direct HTTP"
```

---

### Task 2: Add `requireApiBearerSession` to the API auth helper

**Files:**
- Modify: `src/lib/api/auth.ts`
- Test: `src/lib/api/auth.test.ts` (create if it does not already exist — check first with `find src/lib/api -iname "auth.test.ts"`; if it exists, add tests to it instead of creating a new file, matching its existing setup/teardown pattern)

**Interfaces:**
- Consumes: nothing new — reuses the existing private `userForBearerToken(token: string): User | null` already in this file.
- Produces: `export async function requireApiBearerSession(request: Request): Promise<{ user: User; token: string }>` — consumed by Task 4's route.

- [ ] **Step 1: Write the failing test**

If `src/lib/api/auth.test.ts` does not exist, create it following the same real-database, no-mocks convention as `src/app/api/v1/feeds/route.test.ts` (temp SQLite file via `applyMigrationsAt`, `vi.resetModules()`, dynamic import after setting `process.env.DATABASE_PATH`/`BETTER_AUTH_SECRET`). Add:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/api/auth.test.ts`
Expected: FAIL — `requireApiBearerSession is not exported from "./auth"` (or a TypeScript error to the same effect).

- [ ] **Step 3: Implement `requireApiBearerSession`**

In `src/lib/api/auth.ts`, add this function after `requireApiUser` (it reuses the same private `userForBearerToken` already defined above in the file):

```ts
/**
 * Like `requireApiUser`, but only accepts a Bearer device session -- never
 * falls back to a browser cookie -- and returns the raw session token
 * alongside the user. For endpoints that need the token itself, not just the
 * identity it resolves to: minting a webview-session bootstrap token
 * (`src/lib/auth/webview-session.ts`) has to bind the resulting one-time
 * token to this *exact* session, not a freshly created one, so the WKWebView
 * ends up sharing literally the same session a revoked/unpaired device loses
 * access to as well.
 */
export async function requireApiBearerSession(request: Request): Promise<{ user: User; token: string }> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.toLowerCase().startsWith("bearer ")) {
    throw new ApiError(401, "unauthorized", "Bearer token required.");
  }
  const token = authHeader.slice("bearer ".length).trim();
  const user = token ? userForBearerToken(token) : null;
  if (!user) throw new ApiError(401, "unauthorized", "Invalid or expired token.");
  return { user, token };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/api/auth.test.ts`
Expected: PASS, all three tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/auth.ts src/lib/api/auth.test.ts
git commit -m "feat: add requireApiBearerSession for bearer-bound token minting"
```

---

### Task 3: Add `mintWebviewSessionToken`

**Files:**
- Create: `src/lib/auth/webview-session.ts`
- Test: `src/lib/auth/webview-session.test.ts`

**Interfaces:**
- Consumes: `auth.$context` from `./server` (same pattern `createDeviceSession` already uses).
- Produces: `export async function mintWebviewSessionToken(sessionToken: string): Promise<{ token: string; expiresAt: Date }>` — consumed by Task 4's route.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/auth/webview-session.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/auth/webview-session.test.ts`
Expected: FAIL — cannot find module `./webview-session`.

- [ ] **Step 3: Implement `mintWebviewSessionToken`**

```ts
// src/lib/auth/webview-session.ts
import { randomBytes } from "node:crypto";

import { auth } from "./server";

const ONE_TIME_TOKEN_IDENTIFIER_PREFIX = "one-time-token:";
const WEBVIEW_TOKEN_TTL_MS = 60_000;

/**
 * Mints a one-time bootstrap token that `GET /webview-session` (the wrapper
 * route `ManagementWebView` on the native client loads) exchanges for the
 * *same* session `sessionToken` already authenticates as a device Bearer
 * token -- not a freshly created one. Writes directly into the storage
 * convention the installed `oneTimeToken()` plugin's own
 * `/one-time-token/verify` endpoint reads
 * (`verifications.identifier = "one-time-token:<token>"`,
 * `verifications.value = <session token>`, see
 * `node_modules/better-auth/dist/plugins/one-time-token/index.mjs`), so that
 * plugin's own verify handler -- which sets the real session cookie via
 * `setSessionCookie()` -- does the actual login unmodified.
 *
 * Written by hand rather than calling `auth.api.generateOneTimeToken()`
 * because that endpoint resolves its caller via `sessionMiddleware`
 * (cookie-only), and this app has no `bearer()` plugin installed -- it would
 * never see a device's `Authorization: Bearer` header, only a browser
 * session cookie. `ONE_TIME_TOKEN_PLUGIN_PATHS` in `./server` closes that
 * endpoint over HTTP for exactly this reason, so this function is the only
 * mint path that exists.
 */
export async function mintWebviewSessionToken(
  sessionToken: string,
): Promise<{ token: string; expiresAt: Date }> {
  const ctx = await auth.$context;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + WEBVIEW_TOKEN_TTL_MS);
  await ctx.internalAdapter.createVerificationValue({
    value: sessionToken,
    identifier: `${ONE_TIME_TOKEN_IDENTIFIER_PREFIX}${token}`,
    expiresAt,
  });
  return { token, expiresAt };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/auth/webview-session.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/webview-session.ts src/lib/auth/webview-session.test.ts
git commit -m "feat: mint one-time webview-session bootstrap tokens"
```

---

### Task 4: `POST /api/v1/auth/webview-session-token`

**Files:**
- Create: `src/app/api/v1/auth/webview-session-token/route.ts`
- Test: `src/app/api/v1/auth/webview-session-token/route.test.ts`

**Interfaces:**
- Consumes: `requireApiBearerSession` (Task 2), `mintWebviewSessionToken` (Task 3).
- Produces: `POST /api/v1/auth/webview-session-token` → `200 { "token": string, "expiresAt": string (ISO 8601) }` or the standard `{ error: { code, message } }` envelope. Consumed by the yana-ios client plan's `ManagementWebView`.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/v1/auth/webview-session-token/route.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/v1/auth/webview-session-token/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Implement the route**

```ts
// src/app/api/v1/auth/webview-session-token/route.ts
import { connection } from "next/server";

import { ApiError, apiErrorResponse, requireApiBearerSession } from "@/lib/api/auth";
import { mintWebviewSessionToken } from "@/lib/auth/webview-session";

/**
 * Mints a short-lived, single-use token the native client immediately loads
 * into `GET /webview-session` inside its `WKWebView`, to bootstrap a real
 * browser session for the server's own web UI without ever handling the
 * session cookie's value itself. See
 * `docs/superpowers/plans/2026-08-11-webview-session-bootstrap-server.md`.
 */
export async function POST(request: Request): Promise<Response> {
  await connection();

  try {
    const { token: sessionToken } = await requireApiBearerSession(request);
    const { token, expiresAt } = await mintWebviewSessionToken(sessionToken);
    return Response.json({ token, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/v1/auth/webview-session-token/route.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/v1/auth/webview-session-token
git commit -m "feat: add POST /api/v1/auth/webview-session-token"
```

---

### Task 5: `GET /webview-session` (the cookie-setting wrapper route)

**Files:**
- Create: `src/app/webview-session/route.ts`
- Test: `src/app/webview-session/route.test.ts`

**Interfaces:**
- Consumes: `auth.api.verifyOneTimeToken` (from the plugin installed in Task 1), `mintWebviewSessionToken` (Task 3, used only in the test to seed a valid token).
- Produces: `GET /webview-session?token=...&next=...` → `302` to `next` with `Set-Cookie` on success; `302` to `/login?next=...` on any failure. This is the exact URL the yana-ios client plan's `ManagementWebView.webviewSessionURL(serverBaseURL:token:next:)` builds.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/webview-session/route.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/webview-session/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Implement the route**

```ts
// src/app/webview-session/route.ts
import { auth } from "@/lib/auth/server";

const DEFAULT_NEXT_PATH = "/feeds";

/**
 * `ManagementWebView`'s landing point on the native client: exchanges the
 * short-lived, single-use bootstrap token minted by
 * `POST /api/v1/auth/webview-session-token` for the *same* device session
 * already authenticating that Bearer call, by delegating to the installed
 * `oneTimeToken()` plugin's own verify endpoint -- which sets the session
 * cookie itself via its internal `setSessionCookie()` call. See
 * `src/lib/auth/webview-session.ts`'s module doc for why the mint side is
 * hand-written but the verify side reuses the plugin unmodified.
 *
 * `next` is restricted to an in-app relative path -- never followed as an
 * absolute or protocol-relative URL -- so a crafted `next` cannot turn this
 * into an open redirect. Falls back to `/login?next=...` on any
 * missing/invalid/expired/already-used token, exactly like a plain visitor
 * who isn't signed in yet, so a stale bootstrap token degrades to a normal
 * login screen instead of an opaque error.
 *
 * Built with `new Response(null, { status, headers })` rather than
 * `Response.redirect()` -- the latter returns a `Response` with **immutable
 * headers**, so a `Set-Cookie` cannot be appended onto it afterward.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const next = sanitizeNextPath(url.searchParams.get("next"));

  if (!token) {
    return redirectToLogin(url, next);
  }

  let verifyResponse: Response;
  try {
    verifyResponse = await auth.api.verifyOneTimeToken({ body: { token }, asResponse: true });
  } catch {
    return redirectToLogin(url, next);
  }
  if (!verifyResponse.ok) {
    return redirectToLogin(url, next);
  }

  const headers = new Headers({ location: new URL(next, url).toString() });
  for (const cookie of verifyResponse.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

function redirectToLogin(url: URL, next: string): Response {
  const location = new URL(`/login?next=${encodeURIComponent(next)}`, url);
  return new Response(null, { status: 302, headers: { location: location.toString() } });
}

function sanitizeNextPath(rawNext: string | null): string {
  if (!rawNext) return DEFAULT_NEXT_PATH;
  if (!rawNext.startsWith("/") || rawNext.startsWith("//")) return DEFAULT_NEXT_PATH;
  return rawNext;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/webview-session/route.test.ts`
Expected: PASS, all six tests.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — no regressions in `src/lib/auth/server.test.ts` or elsewhere.

- [ ] **Step 6: Commit**

```bash
git add src/app/webview-session
git commit -m "feat: add GET /webview-session cookie-bootstrap route"
```

---

## Self-Review Notes

- **Spec coverage:** mint endpoint (Task 4), consume/cookie-set endpoint (Task 5), plugin installation + lockdown (Task 1), the bearer-bound token helper the mint route needs (Task 2), and the mint logic itself (Task 3) — all five pieces of the client-facing contract from the research phase are covered. No new migration/table task is needed; that was the point of reusing the `oneTimeToken` plugin's own `verifications`-backed storage.
- **Known edge case, deliberately not over-engineered:** if a device's 30-day session expires in the ~60-second window between minting and verifying a bootstrap token, `verifyOneTimeToken`'s handler sets the cookie and *then* throws `"Session expired"` (a quirk of the plugin's own ordering). Task 5's `.ok` check treats that as a failure and redirects to `/login` regardless, which is the correct outward behavior; a stray cookie for an already-expired session is harmless. Not worth a bespoke workaround for a race this narrow.
- **Type/name consistency check:** `mintWebviewSessionToken(sessionToken: string)` (Task 3) is called with the `token` field of `requireApiBearerSession`'s return value (Task 2) in Task 4's route — names agree. The response field names (`token`, `expiresAt`) match what the yana-ios client plan's `WebviewSessionToken` Decodable model expects.
