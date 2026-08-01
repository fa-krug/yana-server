import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";

import { AI_PROVIDERS, OPENAI_DEFAULT_API_URL, providerByKey } from "./providers";

/**
 * Real-database tests for the `/ai` read path.
 *
 * Two properties carry the weight, and neither is visible in a type:
 *
 * 1. **No raw secret can leave the server.** The projection type is the security
 *    boundary -- a client component's props are the page's RSC payload, which is
 *    plain text in a browser's network tab -- so the assertion is made against
 *    the serialized result, not against the fields the type happens to declare.
 * 2. **A stored model id that the registry no longer offers falls back.** Base
 *    UI's `<Select.Value>` resolves its label from `items` alone, so an unlisted
 *    value makes the collapsed trigger print the raw id while the open popup
 *    looks perfect.
 */
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders),
);

const OPENAI_KEY = "sk-proj-AAAABBBBCCCCDDDDopenai";
const ANTHROPIC_KEY = "sk-ant-api03-AAAABBBBanthropic";
const GEMINI_KEY = "AIzaSyAAAABBBBCCCCDDDDgemini";

describe("getAiStatus", () => {
  let dbPath: string;
  let userId: string;
  let queries: typeof import("./queries");
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function seed(values: Partial<typeof schema.userSettings.$inferInsert>): void {
    client.writeTransaction((tx) =>
      tx
        .update(schema.userSettings)
        .set(values)
        .where(eq(schema.userSettings.userId, userId))
        .run(),
    );
  }

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-ai-queries-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    const bootstrap = await import("@/lib/auth/bootstrap");
    await bootstrap.ensureAdminExists();

    const { auth } = await import("@/lib/auth/server");
    requestHeaders.current = new Headers({
      cookie: await signInCookie(auth, { email: "admin@admin.com", password: "admin" }),
    });

    queries = await import("./queries");
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");

    const connection = new Database(dbPath);
    try {
      userId = (
        connection.prepare("SELECT id FROM users WHERE email = ?").get("admin@admin.com") as {
          id: string;
        }
      ).id;
    } finally {
      connection.close();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("masks every stored key, and puts no raw secret anywhere in the payload", async () => {
    seed({
      openaiApiKey: OPENAI_KEY,
      anthropicApiKey: ANTHROPIC_KEY,
      geminiApiKey: GEMINI_KEY,
    });

    const status = await queries.getAiStatus();

    expect(status.providers.openai.apiKeyMasked).toBe("••••••••enai");
    expect(status.providers.anthropic.apiKeyMasked).toBe("••••••••opic");
    expect(status.providers.gemini.apiKeyMasked).toBe("••••••••mini");
    // Asserted against the serialized payload rather than the declared fields:
    // this is the RSC payload the browser really receives, and a field added
    // later would be caught here even if nobody thought to assert on it.
    const payload = JSON.stringify(status);
    for (const secret of [OPENAI_KEY, ANTHROPIC_KEY, GEMINI_KEY]) {
      expect(payload).not.toContain(secret);
    }
  });

  it("reports an unset key as an empty mask rather than bullets", async () => {
    const status = await queries.getAiStatus();

    for (const provider of AI_PROVIDERS) {
      expect(status.providers[provider.key].apiKeyMasked).toBe("");
      expect(status.providers[provider.key].enabled).toBe(false);
    }
  });

  it("keeps each provider's columns apart", async () => {
    // Three near-identical column triples are exactly where a copy-paste slip
    // hides: every one of them is a `string`, so showing Gemini's key under
    // Anthropic's heading is not a type error. `AI_COLUMNS` is the single
    // mapping; this proves it lands where it claims.
    seed({
      openaiApiKey: OPENAI_KEY,
      openaiEnabled: true,
      anthropicApiKey: ANTHROPIC_KEY,
      geminiApiKey: GEMINI_KEY,
      geminiEnabled: true,
    });

    const status = await queries.getAiStatus();

    expect(status.providers.openai.enabled).toBe(true);
    expect(status.providers.anthropic.enabled).toBe(false);
    expect(status.providers.gemini.enabled).toBe(true);
    expect(status.providers.openai.apiKeyMasked).not.toBe(status.providers.anthropic.apiKeyMasked);
  });

  it("shows a base URL only for the provider that has one", async () => {
    seed({ openaiApiUrl: "https://gateway.example.com/v1" });

    const status = await queries.getAiStatus();

    expect(status.providers.openai.apiUrl).toBe("https://gateway.example.com/v1");
    // `hasCustomUrl` is false for these two and they have no column at all.
    expect(status.providers.anthropic.apiUrl).toBe("");
    expect(status.providers.gemini.apiUrl).toBe("");
  });

  it("falls back to the default model when the stored one is no longer offered", async () => {
    // The phase-2 ids, which migration `0003` replaced as *defaults* but which
    // an older row still holds. Unlisted, they make the collapsed `<Select>`
    // trigger print the raw id.
    seed({
      openaiModel: "gpt-4o-mini",
      anthropicModel: "claude-3-5-sonnet-20240620",
      geminiModel: "gemini-1.5-flash",
    });

    const status = await queries.getAiStatus();

    for (const provider of AI_PROVIDERS) {
      expect(status.providers[provider.key].model).toBe(provider.defaultModel);
    }
  });

  it("leaves a stored model alone when the registry still offers it", async () => {
    const chosen = providerByKey("openai")?.models[2]?.value;
    expect(chosen).toBeTypeOf("string");
    seed({ openaiModel: chosen });

    expect((await queries.getAiStatus()).providers.openai.model).toBe(chosen);
  });

  describe("the active provider", () => {
    it("is empty on a fresh row", async () => {
      expect((await queries.getAiStatus()).active).toBe("");
    });

    it("is reported when the provider it names is switched on", async () => {
      seed({ activeAiProvider: "gemini", geminiEnabled: true });

      expect((await queries.getAiStatus()).active).toBe("gemini");
    });

    /**
     * **A dangling preference is reported as no provider at all.**
     *
     * The write side clears this column whenever it switches a flag off, but
     * that is a second statement rather than part of the flag write -- and the
     * column is also reachable by a hand-edited database or a later phase that
     * flips a flag without going through these actions. Deriving on read makes
     * the state unobservable rather than merely unlikely, which is the same
     * argument `safeAvatarSrc()` rests on: check the value you are about to use.
     */
    it("is empty when the provider it names is not verified", async () => {
      seed({ activeAiProvider: "openai", openaiApiKey: OPENAI_KEY, openaiEnabled: false });

      expect((await queries.getAiStatus()).active).toBe("");
    });

    it("is empty when the column names a provider Yana does not support", async () => {
      seed({ activeAiProvider: "mistral" });

      expect((await queries.getAiStatus()).active).toBe("");
    });
  });

  it("drops the `ai` prefix from every advanced value", async () => {
    seed({
      aiTemperature: 1.25,
      aiMaxTokens: 4096,
      aiDefaultDailyLimit: 50,
      aiDefaultMonthlyLimit: 500,
      aiMaxPromptLength: 1200,
      aiRequestTimeout: 90,
      aiMaxRetries: 5,
      aiRetryDelay: 4,
      aiRequestDelay: 6,
    });

    expect((await queries.getAiStatus()).advanced).toEqual({
      temperature: 1.25,
      maxTokens: 4096,
      dailyLimit: 50,
      monthlyLimit: 500,
      maxPromptLength: 1200,
      requestTimeout: 90,
      maxRetries: 5,
      retryDelay: 4,
      requestDelay: 6,
    });
  });

  it("starts a fresh account on the registry's own defaults", async () => {
    // The read path's fallback would hide a stale column default, so this asks
    // what an untouched row actually renders as.
    const status = await queries.getAiStatus();

    expect(status.providers.openai.apiUrl).toBe(OPENAI_DEFAULT_API_URL);
    for (const provider of AI_PROVIDERS) {
      expect(status.providers[provider.key].model).toBe(provider.defaultModel);
    }
  });
});
