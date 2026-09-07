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

  /**
   * `aiMaxPromptLength` was the last Yana-imposed AI limit, and this route was
   * its only enforcer -- a 400 `prompt_too_long` past the configured length.
   * It is gone with the request caps, so the only bounds a caller meets are
   * the provider's own; a prompt far past the retired 500-character default is
   * simply answered.
   */
  it("answers a prompt far longer than the retired length cap", async () => {
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
      vi.fn().mockImplementation(
        async () =>
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

    const response = await promptRequest(token, { prompt: "x".repeat(5_000) });
    expect(response.status).toBe(200);

    vi.unstubAllGlobals();
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

  /**
   * The existing "returns the provider's completion" case above only ever
   * exercised `anthropic` -- one of the original three. The design spec's
   * requirement is that this endpoint "must work with the full expanded
   * provider list from day one," so this repeats it against `deepseek`, one
   * of the three providers this same plan added, to prove the endpoint
   * actually reaches a new provider's branch in `AIClient` end to end rather
   * than only the providers that predate this plan.
   */
  it("returns the provider's completion for a newly-added provider (deepseek)", async () => {
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
          deepseekEnabled: true,
          deepseekApiKey: "sk-deepseek-test",
          deepseekModel: "deepseek-v4-flash",
          activeAiProvider: "deepseek",
        })
        .where(eq(schema.userSettings.userId, owner.id))
        .run();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "Hello from DeepSeek." } }] }),
          {
            status: 200,
          },
        ),
      ),
    );

    const response = await promptRequest(token, { prompt: "Hello there" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      response: "Hello from DeepSeek.",
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    vi.unstubAllGlobals();
  });

  it("502s with provider_unauthorized when the stored credentials are rejected", async () => {
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
          anthropicApiKey: "sk-ant-revoked",
          anthropicModel: "claude-haiku-4-5",
          activeAiProvider: "anthropic",
        })
        .where(eq(schema.userSettings.userId, owner.id))
        .run();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 401 })),
    );

    const response = await promptRequest(token, { prompt: "hello" });

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("provider_unauthorized");
    vi.unstubAllGlobals();
  });

  it("never 429s: repeated prompts all reach the provider", async () => {
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
    // A fresh Response per call, not one shared instance: a body can only be
    // read once, so `mockResolvedValue` with a single Response 502s from the
    // second call onward. The old two-call test never noticed, because its
    // second call was short-circuited by the cap and never read a body.
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    // This used to assert a 429 with `daily_limit_exceeded` on the second call,
    // against a daily cap of 1. The per-user request caps were removed, so this
    // route has no 429 left to answer at all -- ten calls in a row is what
    // proves it, since any cap small enough to matter would have fired.
    for (let i = 0; i < 10; i++) {
      const response = await promptRequest(token, { prompt: `p${i}` });
      expect(response.status).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(10);

    vi.unstubAllGlobals();
  });
});
