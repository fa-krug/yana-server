import { eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/server", () => import("@/test/next-server"));

describe("GET /device/pair/start", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
  let client: typeof import("@/lib/db/client");

  beforeEach(async () => {
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-device-pair-start-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;

    client = await import("@/lib/db/client");
    ({ GET } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  it("mints a single-use state and persists it, unused and unexpired", async () => {
    const before = Date.now();
    const response = await GET();
    expect(response.status).toBe(200);

    const body = (await response.json()) as { state: string; expiresAt: string };
    expect(body.state).toMatch(/^[0-9a-f]{64}$/);

    const { devicePairingStates } = await import("@/lib/db/schema");
    const row = client
      .getDb()
      .select()
      .from(devicePairingStates)
      .where(eq(devicePairingStates.state, body.state))
      .get();

    expect(row).toBeDefined();
    expect(row?.usedAt).toBeNull();
    expect(row?.expiresAt.getTime()).toBeGreaterThan(before);
    // The integer `timestamp` column stores whole seconds, so it necessarily
    // truncates the response body's millisecond precision -- compare at
    // second granularity rather than expecting an exact string match.
    expect(Math.floor(row!.expiresAt.getTime() / 1000)).toBe(
      Math.floor(new Date(body.expiresAt).getTime() / 1000),
    );
  });
});
