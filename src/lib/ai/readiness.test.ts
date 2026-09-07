import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

describe("aiReadinessFor", () => {
  let dbPath: string;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let readiness: typeof import("./readiness");

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-ai-readiness-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    applyMigrationsAt(dbPath);

    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    readiness = await import("./readiness");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  function seedUserSettings(
    userId: string,
    values: Partial<typeof schema.userSettings.$inferInsert>,
  ): void {
    client.writeTransaction((tx) => {
      tx.insert(schema.users)
        .values({ id: userId, email: `${userId}@example.com` })
        .run();
      tx.insert(schema.userSettings)
        .values({ userId, ...values })
        .run();
    });
  }

  function readSettings(userId: string) {
    return client
      .getDb()
      .select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId))
      .get()!;
  }

  it('is "notNeeded" when the feed asks for no AI processing', () => {
    seedUserSettings("u-none", { activeAiProvider: "" });
    const settings = readSettings("u-none");

    expect(readiness.aiReadinessFor({}, settings)).toBe("notNeeded");
    expect(readiness.aiReadinessFor(null, settings)).toBe("notNeeded");
    expect(readiness.aiReadinessFor({ ai_translate: false }, settings)).toBe("notNeeded");
  });

  it('is "noProvider" when AI is wanted and no active provider is configured', () => {
    seedUserSettings("u-noprov", { activeAiProvider: "" });
    const settings = readSettings("u-noprov");

    expect(readiness.aiReadinessFor({ ai_translate: true }, settings)).toBe("noProvider");
  });

  it('is "noProvider" when the preference names a provider whose own flag is false', () => {
    // The exact trap `activeProvider()` (`./queries`) exists to catch: a
    // preference the write side never cleared, pointing at a provider whose
    // probe never actually verified it (see `AiStatus.active`'s doc comment).
    seedUserSettings("u-unverified", {
      activeAiProvider: "openai",
      openaiEnabled: false,
    });
    const settings = readSettings("u-unverified");

    expect(readiness.aiReadinessFor({ ai_summarize: true }, settings)).toBe("noProvider");
  });

  it('is "noProvider" when there is no userSettings row at all', () => {
    expect(readiness.aiReadinessFor({ ai_translate: true }, null)).toBe("noProvider");
    expect(readiness.aiReadinessFor({ ai_translate: true }, undefined)).toBe("noProvider");
  });

  it('is "ok" when AI is wanted and the active provider is verified enabled', () => {
    seedUserSettings("u-ok", {
      activeAiProvider: "openai",
      openaiEnabled: true,
    });
    const settings = readSettings("u-ok");

    expect(readiness.aiReadinessFor({ ai_improve_writing: true }, settings)).toBe("ok");
  });

  it("treats a custom prompt with only whitespace text as not wanting AI, matching wantsAi()", () => {
    seedUserSettings("u-blank-prompt", { activeAiProvider: "" });
    const settings = readSettings("u-blank-prompt");

    expect(
      readiness.aiReadinessFor({ ai_custom_prompt: true, ai_custom_prompt_text: "   " }, settings),
    ).toBe("notNeeded");
  });
});
