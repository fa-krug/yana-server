import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/server", () => import("@/test/next-server"));

describe("GET /api/v1/tags", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  beforeEach(async () => {
    // A fresh module registry per test: `getDb()` is a lazy module-level
    // singleton (see `src/lib/db/client.ts`), so without this the second
    // test in this file would silently keep querying the first test's
    // already-closed temp database rather than the one just created below.
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-tags-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    ({ GET } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  it("401s with no Authorization header", async () => {
    const response = await GET(new Request("https://example.com/api/v1/tags"));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("401s with an invalid bearer token", async () => {
    const response = await GET(
      new Request("https://example.com/api/v1/tags", {
        headers: { authorization: "Bearer not-a-real-token" },
      }),
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns an empty list with no tags", async () => {
    const owner = await createUserWithPassword({
      email: "o2@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await GET(
      new Request("https://example.com/api/v1/tags", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tags).toEqual([]);
  });

  it("returns only this user's tags", async () => {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    const other = await createUserWithPassword({
      email: "o2@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    client.writeTransaction((tx) => {
      tx.insert(schema.tags).values({ name: "Mine", userId: owner.id }).run();
      tx.insert(schema.tags).values({ name: "Theirs", userId: other.id }).run();
    });

    const response = await GET(
      new Request("https://example.com/api/v1/tags", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tags).toHaveLength(1);
    expect(body.tags[0].name).toBe("Mine");
  });

  it("returns tags with id, name, and color serialized", async () => {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    client.writeTransaction((tx) => {
      tx.insert(schema.tags).values({ name: "News", userId: owner.id, color: "#FF0000" }).run();
    });

    const response = await GET(
      new Request("https://example.com/api/v1/tags", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tags).toHaveLength(1);
    expect(body.tags[0]).toEqual({
      id: expect.any(Number),
      name: "News",
      color: "#FF0000",
    });
  });

  it("await connection() is the first statement, before requireApiUser()", async () => {
    // A garbage bearer token would normally 401 -- but if requireApiUser()
    // ran before connection(), a route that dropped the connection() call
    // could not be told apart from one that has it just by hitting this
    // endpoint. This test instead pins the *source order* directly, since
    // that is the actual invariant the self-review asks for and no black-box
    // request can observe it.
    const routeSource = fs.readFileSync(path.join(__dirname, "route.ts"), "utf8");
    const connectionIndex = routeSource.indexOf("connection()");
    const requireApiUserIndex = routeSource.indexOf("requireApiUser(");
    expect(connectionIndex).toBeGreaterThan(-1);
    expect(requireApiUserIndex).toBeGreaterThan(-1);
    expect(connectionIndex).toBeLessThan(requireApiUserIndex);
  });
});
