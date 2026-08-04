import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

describe("POST /api/v1/ai/prompt", () => {
  let dbPath: string;
  let POST: typeof import("./route").POST;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  beforeEach(async () => {
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-ai-prompt-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    ({ POST } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  function promptRequest(token: string | undefined, body: unknown) {
    return POST(
      new Request("https://example.com/api/v1/ai/prompt", {
        method: "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  }

  async function ownerToken(): Promise<string> {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    // `createUserWithPassword()` only writes `users` and the credential
    // account -- the `user_settings` row is provisioned separately in
    // production (see `src/lib/users/actions.ts`'s `createUser()` and
    // `src/lib/auth/bootstrap.ts`'s default-admin repair), so a test that
    // creates a user directly must provision it too. A bare `{ userId }` is
    // enough: every other column has a schema default.
    client.writeTransaction((tx) => {
      tx.insert(schema.userSettings).values({ userId: owner.id }).run();
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    return token;
  }

  it("401s with no Authorization header", async () => {
    const response = await promptRequest(undefined, { prompt: "hi" });
    expect(response.status).toBe(401);
  });

  it("400s on an empty prompt", async () => {
    const token = await ownerToken();
    const response = await promptRequest(token, { prompt: "   " });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_prompt");
  });

  it("400s on a prompt longer than the configured limit", async () => {
    const token = await ownerToken();
    const owner = client
      .getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "o@example.com"))
      .get()!;
    client.writeTransaction((tx) => {
      tx.update(schema.userSettings)
        .set({ aiMaxPromptLength: 5 })
        .where(eq(schema.userSettings.userId, owner.id))
        .run();
    });

    const response = await promptRequest(token, { prompt: "this is way too long" });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("prompt_too_long");
  });

  it("409s when no AI provider is active", async () => {
    const token = await ownerToken();
    const response = await promptRequest(token, { prompt: "hello" });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("no_active_provider");
  });

  it("returns the provider's completion when a provider is active and enabled", async () => {
    const token = await ownerToken();
    const owner = client
      .getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "o@example.com"))
      .get()!;
    client.writeTransaction((tx) => {
      tx.update(schema.userSettings)
        .set({
          anthropicEnabled: true,
          anthropicApiKey: "sk-ant-test",
          anthropicModel: "claude-haiku-4-5",
          activeAiProvider: "anthropic",
        })
        .where(eq(schema.userSettings.userId, owner.id))
        .run();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "General Kenobi." }],
          }),
          { status: 200 },
        ),
      ),
    );

    const response = await promptRequest(token, { prompt: "Hello there" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      response: "General Kenobi.",
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    vi.unstubAllGlobals();
  });

  it("429s once the daily request limit is reached", async () => {
    const token = await ownerToken();
    const owner = client
      .getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "o@example.com"))
      .get()!;
    client.writeTransaction((tx) => {
      tx.update(schema.userSettings)
        .set({
          anthropicEnabled: true,
          anthropicApiKey: "sk-ant-test",
          anthropicModel: "claude-haiku-4-5",
          activeAiProvider: "anthropic",
          aiDefaultDailyLimit: 1,
        })
        .where(eq(schema.userSettings.userId, owner.id))
        .run();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
          }),
          { status: 200 },
        ),
      ),
    );

    await promptRequest(token, { prompt: "first" });
    const response = await promptRequest(token, { prompt: "second" });

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.code).toBe("daily_limit_exceeded");
    vi.unstubAllGlobals();
  });
});
