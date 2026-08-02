import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { articleImages } from "@/lib/db/schema/articles";
import { applyMigrationsAt } from "@/lib/db/test-support";

const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders),
);

const REDIRECT = /^NEXT_REDIRECT/;

describe("GET /media/images/[hash]", () => {
  let dbPath: string;
  let mediaPath: string;
  let GET: typeof import("./route").GET;
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");

  const USER_CREDENTIALS = {
    email: "user@example.com",
    password: "correct horse battery staple",
  };
  const VALID_HASH = "a".repeat(64);
  const SAMPLE_BYTES = Buffer.from("fake-png-image-bytes");

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  function get(hash: string): Promise<Response> {
    return GET(new Request(`http://localhost/media/images/${hash}`), {
      params: Promise.resolve({ hash }),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-image-route-${stamp}.db`);
    mediaPath = fs.mkdtempSync(path.join(os.tmpdir(), `yana-image-media-${stamp}-`));
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.MEDIA_PATH = mediaPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    ({ GET } = await import("./route"));
    client = await import("@/lib/db/client");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.MEDIA_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
    fs.rmSync(mediaPath, { recursive: true, force: true });
  });

  async function setupUserAndImage(opts?: { fileExists?: boolean }): Promise<string> {
    const user = await createUserWithPassword({
      ...USER_CREDENTIALS,
      firstName: "A",
      lastName: "B",
    });
    const cookie = await signInCookie(auth, USER_CREDENTIALS);

    const relativeFile = "images/sample.png";
    await client.getDb().insert(articleImages).values({
      contentHash: VALID_HASH,
      file: relativeFile,
      contentType: "image/png",
      byteSize: SAMPLE_BYTES.byteLength,
    });

    if (opts?.fileExists !== false) {
      const fullPath = path.join(mediaPath, relativeFile);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, SAMPLE_BYTES);
    }

    return cookie;
  }

  it("serves image for a valid hash when authenticated", async () => {
    const cookie = await setupUserAndImage();
    requestAs(cookie);

    const response = await get(VALID_HASH);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(Buffer.from(await response.arrayBuffer()).equals(SAMPLE_BYTES)).toBe(true);
  });

  it("refuses an unauthenticated request", async () => {
    await setupUserAndImage();
    requestHeaders.current = new Headers();

    await expect(get(VALID_HASH)).rejects.toMatchObject({
      digest: expect.stringMatching(REDIRECT),
    });
  });

  it("returns 404 for invalid hash format before DB/filesystem access", async () => {
    const cookie = await setupUserAndImage();
    requestAs(cookie);

    for (const invalidHash of [
      "too-short",
      "g".repeat(64), // not hex
      "../../etc/passwd",
      "a".repeat(63),
      "a".repeat(65),
      "",
    ]) {
      const response = await get(invalidHash);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
  });

  it("returns 404 when hash is not in database", async () => {
    const cookie = await setupUserAndImage();
    requestAs(cookie);

    const missingHash = "b".repeat(64);
    const response = await get(missingHash);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("returns 404 when file on disk does not exist", async () => {
    const cookie = await setupUserAndImage({ fileExists: false });
    requestAs(cookie);

    const response = await get(VALID_HASH);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});
