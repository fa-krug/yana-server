import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";
import { KEEP_EXISTING } from "@/lib/secrets";

import en from "../../../messages/en.json";

import { OPENAI_DEFAULT_API_URL } from "./providers";
import type { AiResult, AiSaveResult } from "./result";

/**
 * Real-database tests for the AI actions, in the style of
 * `src/lib/integrations/actions.test.ts`: a temp SQLite file per test, migrated
 * through the same `applyMigrations()` the container runs at startup, with the
 * caller signed in for real. **No driver mocks** -- every assertion about what
 * was stored reads the row back over a separate connection.
 *
 * **The phase-7 plan's own test bodies are deliberately not reproduced.** They
 * called `saveAdvanced({ temperature: 2.5 })` with no request scope, which
 * reaches `currentUserId()` -> `requireUser()` and *throws* rather than
 * returning `{ ok: false }`; and each bound was probed with a partial object,
 * which fails on the eight missing fields and would stay green whatever the
 * bound did. Every bound below submits a **complete, valid payload with exactly
 * one field out of range**, so the assertion is about the bound it names.
 *
 * Three things are stubbed, and none of them is data:
 *
 * - `next/cache`'s `revalidatePath()`, which throws outside a request scope.
 * - `next/headers`, the request scope the session read needs. Built from
 *   `nextHeadersStub()`, which exports `cookies` as well as `headers` --
 *   mandatory, see CLAUDE.md's `nextCookies()` rule.
 * - **`fetch`**, so no test reaches a real provider. The per-provider
 *   classification of real response shapes is covered by `openai.test.ts`,
 *   `anthropic.test.ts` and `gemini.test.ts`; what is proved here is what the
 *   *actions* do with a verdict.
 */
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders),
);

/** A request a probe made, as the fake `fetch` saw it. */
type Recorded = { url: string; init: RequestInit | undefined };

const OPENAI_KEY = "sk-proj-REALLOOKINGOPENAIKEY0001";
const ANTHROPIC_KEY = "sk-ant-api03-REALLOOKINGKEY0001";
const GEMINI_KEY = "AIzaSyREALLOOKINGGEMINIKEY0001";

/** The registry's current defaults, which are also migration `0003`'s. */
const OPENAI_MODEL = "gpt-5.6-luna";
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const GEMINI_MODEL = "gemini-3.5-flash-lite";

/** A complete, in-range advanced payload -- the documented defaults. */
const VALID_ADVANCED = {
  temperature: 0.3,
  maxTokens: 2000,
  dailyLimit: 200,
  monthlyLimit: 2000,
  maxPromptLength: 500,
  requestTimeout: 120,
  maxRetries: 3,
  retryDelay: 2,
  requestDelay: 2,
};

describe("the AI actions", () => {
  let dbPath: string;
  let userId: string;
  let actions: typeof import("./actions");
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let requests: Recorded[];

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  /** Read the row back over a connection of its own -- never through the code under test. */
  function row(): Record<string, unknown> {
    const connection = new Database(dbPath);
    try {
      return connection
        .prepare("SELECT * FROM user_settings WHERE user_id = ?")
        .get(userId) as Record<string, unknown>;
    } finally {
      connection.close();
    }
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

  function stubFetch(handler: (recorded: Recorded) => Response): void {
    vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
      const recorded = { url: String(input), init };
      requests.push(recorded);
      return Promise.resolve(handler(recorded));
    });
  }

  /** The bearer token a recorded OpenAI request actually carried. */
  function bearerOf(recorded: Recorded): string {
    return (new Headers(recorded.init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
  }

  const openaiOk = () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 });
  const openaiRejected = () =>
    new Response(JSON.stringify({ error: { type: "invalid_request_error" } }), { status: 401 });
  const openaiRateLimited = () =>
    new Response(JSON.stringify({ error: { type: "rate_limit_exceeded" } }), { status: 429 });
  const anthropicOk = () =>
    new Response(JSON.stringify({ type: "message", content: [] }), { status: 200 });
  const anthropicRateLimited = () => new Response("{}", { status: 429 });
  const geminiOk = () => new Response(JSON.stringify({ candidates: [] }), { status: 200 });

  function networkFailure(): never {
    throw new TypeError("fetch failed");
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    requests = [];
    // Silenced, not removed: every probe failure is logged here on purpose (it
    // is the only place a `detail` is allowed to go). `console.error` is
    // deliberately left alone -- the two things this module logs as errors, a
    // failed write and a missing settings row, are exactly the two nobody would
    // otherwise notice.
    vi.spyOn(console, "warn").mockImplementation(() => {});

    dbPath = path.join(
      os.tmpdir(),
      `yana-ai-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
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

    actions = await import("./actions");
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  /**
   * Resolve a key an action emitted against the real `en.json`.
   *
   * `src/i18n/messages.test.ts` only compares the two catalogs to each other; it
   * cannot know that an action emits a key neither defines, which would render
   * the raw dotted path into a toast.
   */
  function aiMessage(key: string | undefined): unknown {
    if (!key) return undefined;
    return key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        en.ai,
      );
  }

  /** The English message a *failed* result points at, or `undefined` if it succeeded. */
  function failureMessage(result: AiSaveResult | AiResult): unknown {
    return result.ok ? undefined : aiMessage(result.errorKey);
  }

  /** {@link failureMessage}'s twin for the succeeded-with-a-caveat arm. */
  function noticeMessage(result: AiSaveResult): unknown {
    return result.ok ? aiMessage(result.noticeKey) : undefined;
  }

  describe("saveProvider", () => {
    it("stores the key and switches the provider on when the probe passes", async () => {
      stubFetch(openaiOk);

      const result = await actions.saveProvider("openai", {
        apiKey: OPENAI_KEY,
        model: OPENAI_MODEL,
        apiUrl: "",
      });

      expect(result).toEqual({ ok: true });
      expect(row()).toMatchObject({
        openai_api_key: OPENAI_KEY,
        openai_model: OPENAI_MODEL,
        openai_enabled: 1,
      });
      // The probe really was given the submitted key, not a placeholder.
      expect(bearerOf(requests[0])).toBe(OPENAI_KEY);
    });

    it("keeps the stored key when the field was left untouched", async () => {
      // The property the whole page turns on: a saved secret never reaches the
      // browser, so an unchanged field cannot round-trip it -- it submits the
      // sentinel, and the stored value has to come back out of the database.
      // It is also the end-to-end proof that the NUL sentinel survives the
      // schema's `.trim()`.
      stubFetch(anthropicOk);
      seed({ anthropicApiKey: ANTHROPIC_KEY, anthropicEnabled: true });

      const result = await actions.saveProvider("anthropic", {
        apiKey: KEEP_EXISTING,
        model: ANTHROPIC_MODEL,
      });

      expect(result).toEqual({ ok: true });
      expect(row()).toMatchObject({ anthropic_api_key: ANTHROPIC_KEY, anthropic_enabled: 1 });
      // And the probe ran against the *stored* key, so "keep existing" is
      // verified rather than assumed.
      expect(new Headers(requests[0].init?.headers).get("x-api-key")).toBe(ANTHROPIC_KEY);
    });

    it("treats an empty field as keep-existing too", async () => {
      stubFetch(geminiOk);
      seed({ geminiApiKey: GEMINI_KEY, geminiEnabled: true });

      expect(await actions.saveProvider("gemini", { apiKey: "", model: GEMINI_MODEL })).toEqual({
        ok: true,
      });
      expect(row()).toMatchObject({ gemini_api_key: GEMINI_KEY });
    });

    /**
     * **The paste artifact that destroys a working key.**
     *
     * A key copied out of a provider console arrives with a trailing newline.
     * Untrimmed it is sent mangled, comes back 401, classifies `unauthorized` --
     * and an `unauthorized` save *stores what was submitted*, so the mangled
     * value replaces the good one in a column this UI can never read back.
     *
     * Both halves are asserted together on purpose: the probe has to receive the
     * trimmed key *and* the row has to end up holding it. Trimming after the
     * probe would fix the toast and still store rubbish.
     */
    it("trims the submitted key before probing and before storing it", async () => {
      stubFetch(openaiOk);

      const result = await actions.saveProvider("openai", {
        apiKey: `  ${OPENAI_KEY}\n`,
        model: OPENAI_MODEL,
        apiUrl: "",
      });

      expect(result).toEqual({ ok: true });
      expect(bearerOf(requests[0])).toBe(OPENAI_KEY);
      expect(row()).toMatchObject({ openai_api_key: OPENAI_KEY });
    });

    it("stores the key with the provider switched off when it is refused", async () => {
      stubFetch(openaiRejected);

      const result = await actions.saveProvider("openai", {
        apiKey: "not-a-key",
        model: OPENAI_MODEL,
        apiUrl: "",
      });

      expect(result).toEqual({ ok: false, errorKey: "openai.rejected" });
      expect(failureMessage(result)).toBeTypeOf("string");
      expect(row()).toMatchObject({ openai_api_key: "not-a-key", openai_enabled: 0 });
    });

    /**
     * **The three providers do not share one answer to "is a 429 a pass?", and
     * this pair is where that stops being a comment.**
     *
     * Anthropic resolves rate limits from the key, so a 429 proves it was
     * accepted; OpenAI's base URL is an operator setting, so a gateway can shed
     * load before ever reading the `Authorization` header. The values live once
     * in `./providers` and are read from there -- never typed into the
     * descriptor -- which is what these two tests protect.
     */
    it("counts Anthropic's rate limit as a pass, and reports it as a notice", async () => {
      stubFetch(anthropicRateLimited);

      const result = await actions.saveProvider("anthropic", {
        apiKey: ANTHROPIC_KEY,
        model: ANTHROPIC_MODEL,
      });

      expect(result).toEqual({ ok: true, noticeKey: "anthropic.quota" });
      expect(noticeMessage(result)).toBeTypeOf("string");
      expect(row()).toMatchObject({ anthropic_api_key: ANTHROPIC_KEY, anthropic_enabled: 1 });
    });

    it("treats OpenAI's rate limit as no answer at all, and writes nothing", async () => {
      stubFetch(openaiRateLimited);

      const result = await actions.saveProvider("openai", {
        apiKey: OPENAI_KEY,
        model: OPENAI_MODEL,
        apiUrl: "",
      });

      expect(result).toEqual({ ok: false, errorKey: "openai.rateLimited" });
      expect(failureMessage(result)).toBeTypeOf("string");
      expect(row()).toMatchObject({ openai_api_key: "", openai_enabled: 0 });
    });

    it("changes nothing when the provider could not be reached", async () => {
      // "The answer is no" and "there was no answer" are different. With no
      // answer there is nothing to derive the flag from, so a momentary outage
      // must not disable a working provider -- nor store an untested key under a
      // flag that still vouches for the old one.
      seed({ geminiApiKey: GEMINI_KEY, geminiEnabled: true });
      stubFetch(networkFailure);

      const result = await actions.saveProvider("gemini", {
        apiKey: "a-different-key",
        model: GEMINI_MODEL,
      });

      expect(result).toEqual({ ok: false, errorKey: "unreachable" });
      expect(failureMessage(result)).toBeTypeOf("string");
      expect(row()).toMatchObject({ gemini_api_key: GEMINI_KEY, gemini_enabled: 1 });
    });

    it("refuses when nothing is submitted and nothing is stored", async () => {
      stubFetch(openaiOk);

      const result = await actions.saveProvider("openai", {
        apiKey: KEEP_EXISTING,
        model: OPENAI_MODEL,
        apiUrl: "",
      });

      expect(result).toEqual({ ok: false, errorKey: "openai.required" });
      expect(failureMessage(result)).toBeTypeOf("string");
      // Probing "" would come back "rejected" and blame a key nobody entered.
      expect(requests).toEqual([]);
    });

    it("refuses a model the registry does not offer, without asking the provider", async () => {
      // An unlisted id reaches the provider as a real request and comes back
      // 404, which classifies as `unexpected` -- so the operator would be sent to
      // a server log about a value they picked from a dropdown.
      stubFetch(openaiOk);

      const result = await actions.saveProvider("openai", {
        apiKey: OPENAI_KEY,
        model: "gpt-4o-mini",
        apiUrl: "",
      });

      expect(result).toEqual({ ok: false, errorKey: "openai.modelUnknown" });
      expect(failureMessage(result)).toBeTypeOf("string");
      expect(requests).toEqual([]);
      expect(row()).toMatchObject({ openai_api_key: "" });
    });

    it("refuses a base URL that is not an http(s) URL, and says so specifically", async () => {
      // The likeliest typo is a missing scheme. Left to the probe it would be
      // `unexpected` -- "the details are in the server log" -- about a field the
      // operator is looking straight at.
      stubFetch(openaiOk);

      const result = await actions.saveProvider("openai", {
        apiKey: OPENAI_KEY,
        model: OPENAI_MODEL,
        apiUrl: "gateway.example.com/v1",
      });

      expect(result).toEqual({ ok: false, errorKey: "openai.apiUrlInvalid" });
      expect(failureMessage(result)).toBeTypeOf("string");
      expect(requests).toEqual([]);
    });

    it("stores OpenAI's own endpoint when the base URL is left empty", async () => {
      // `apiUrl` is not a secret, so an empty field means empty -- and an empty
      // column would leave every later reader to remember its own fallback.
      stubFetch(openaiOk);
      seed({ openaiApiUrl: "https://gateway.example.com/v1" });

      expect(
        await actions.saveProvider("openai", {
          apiKey: OPENAI_KEY,
          model: OPENAI_MODEL,
          apiUrl: "",
        }),
      ).toEqual({ ok: true });
      expect(row()).toMatchObject({ openai_api_url: OPENAI_DEFAULT_API_URL });
    });

    it("probes the configured gateway rather than OpenAI when one is set", async () => {
      stubFetch(openaiOk);

      await actions.saveProvider("openai", {
        apiKey: OPENAI_KEY,
        model: OPENAI_MODEL,
        apiUrl: "https://gateway.example.com/v1/",
      });

      expect(requests[0].url).toBe("https://gateway.example.com/v1/chat/completions");
      expect(row()).toMatchObject({ openai_api_url: "https://gateway.example.com/v1/" });
    });

    it("refuses a provider key Yana does not support, and touches nothing", async () => {
      const result = await actions.saveProvider("mistral", { apiKey: "x", model: "y" });

      expect(result).toEqual({ ok: false, errorKey: "unknownProvider" });
      expect(failureMessage(result)).toBeTypeOf("string");
      expect(requests).toEqual([]);
    });

    it("logs the provider's detail and never returns it", async () => {
      // `ProbeResult.detail` is English prose for a log line, and a provider body
      // can echo back the credential just submitted. It must not be in the result
      // at all.
      stubFetch(openaiRejected);

      const result = await actions.saveProvider("openai", {
        apiKey: OPENAI_KEY,
        model: OPENAI_MODEL,
        apiUrl: "",
      });

      expect(Object.keys(result).sort()).toEqual(["errorKey", "ok"]);
      expect(JSON.stringify(result)).not.toContain("rejected.");
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("The API key was rejected"),
      );
    });
  });

  describe("testProvider", () => {
    it("writes nothing at all, which is what makes the button safe to press", async () => {
      stubFetch(openaiOk);
      seed({ openaiApiKey: OPENAI_KEY, openaiEnabled: false });

      const result = await actions.testProvider("openai", {
        apiKey: "a-candidate-key",
        model: OPENAI_MODEL,
        apiUrl: "",
      });

      expect(result).toEqual({ ok: true });
      expect(bearerOf(requests[0])).toBe("a-candidate-key");
      expect(row()).toMatchObject({ openai_api_key: OPENAI_KEY, openai_enabled: 0 });
    });

    /**
     * The property the shared `verify()` exists to hold, pinned directly.
     *
     * **A Test button that validates something other than what a Save would
     * store is worse than no button**: it reports a green result for a credential
     * the save then replaces with a different one.
     */
    it.each([
      ["the keep-existing sentinel", KEEP_EXISTING],
      ["an empty field", ""],
      ["a freshly typed key", "sk-proj-a-typed-key"],
    ])("resolves the same key as a save for %s", async (_label, submitted) => {
      stubFetch(openaiOk);
      seed({ openaiApiKey: OPENAI_KEY });
      const submission = { apiKey: submitted, model: OPENAI_MODEL, apiUrl: "" };

      await actions.testProvider("openai", submission);
      await actions.saveProvider("openai", submission);

      expect(requests).toHaveLength(2);
      expect(bearerOf(requests[0])).toBe(bearerOf(requests[1]));
      // And the row now holds precisely what the *test* validated.
      expect(row().openai_api_key).toBe(bearerOf(requests[0]));
    });

    it("refuses the same submission a save would, for the same reason", async () => {
      stubFetch(openaiOk);
      const submission = { apiKey: KEEP_EXISTING, model: OPENAI_MODEL, apiUrl: "" };

      const tested = await actions.testProvider("openai", submission);
      const saved = await actions.saveProvider("openai", submission);

      expect(tested).toEqual({ ok: false, errorKey: "openai.required" });
      expect(saved).toEqual(tested);
      expect(requests).toEqual([]);
    });

    it("refuses an unsupported provider key", async () => {
      expect(await actions.testProvider("mistral", {})).toEqual({
        ok: false,
        errorKey: "unknownProvider",
      });
    });
  });

  describe("removeProvider", () => {
    it("wipes the API key and switches the provider off, keeping the model", async () => {
      // A model and a base URL are not credentials, and throwing away a
      // carefully-typed gateway URL on the way to re-entering a key is a small
      // cruelty.
      seed({
        openaiApiKey: OPENAI_KEY,
        openaiModel: "gpt-5.6-sol",
        openaiApiUrl: "https://gateway.example.com/v1",
        openaiEnabled: true,
      });

      expect(await actions.removeProvider("openai")).toEqual({ ok: true });
      expect(row()).toMatchObject({
        openai_api_key: "",
        openai_enabled: 0,
        openai_model: "gpt-5.6-sol",
        openai_api_url: "https://gateway.example.com/v1",
      });
    });

    it("succeeds when there is nothing to remove", async () => {
      expect(await actions.removeProvider("gemini")).toEqual({ ok: true });
    });

    it("refuses an unsupported provider key", async () => {
      expect(await actions.removeProvider("mistral")).toEqual({
        ok: false,
        errorKey: "unknownProvider",
      });
    });

    it("touches only the caller's own row", async () => {
      const { createUserWithPassword } = await import("@/lib/auth/server");
      const other = await createUserWithPassword({
        email: "other@example.com",
        password: "correct horse battery staple",
      });
      client.writeTransaction((tx) =>
        tx
          .insert(schema.userSettings)
          .values({ userId: other.id, geminiApiKey: "someone-elses-key", geminiEnabled: true })
          .run(),
      );
      seed({ geminiApiKey: GEMINI_KEY, geminiEnabled: true });

      expect(await actions.removeProvider("gemini")).toEqual({ ok: true });

      const connection = new Database(dbPath);
      try {
        expect(
          connection
            .prepare("SELECT gemini_api_key FROM user_settings WHERE user_id = ?")
            .get(other.id),
        ).toEqual({ gemini_api_key: "someone-elses-key" });
      } finally {
        connection.close();
      }
    });
  });

  describe("setActiveProvider", () => {
    it("allows the empty string, which disables AI", async () => {
      seed({ geminiEnabled: true, activeAiProvider: "gemini" });

      expect(await actions.setActiveProvider("")).toEqual({ ok: true });
      expect(row()).toMatchObject({ active_ai_provider: "" });
    });

    it("refuses a provider whose credentials have not passed a probe", async () => {
      // Selecting a provider that was never verified is how AI features fail
      // silently: no summaries ever appear, and the page says everything is
      // configured.
      const result = await actions.setActiveProvider("anthropic");

      expect(result).toEqual({ ok: false, errorKey: "activeNotVerified" });
      expect(failureMessage(result)).toBeTypeOf("string");
      expect(row()).toMatchObject({ active_ai_provider: "" });
    });

    it("refuses an unknown provider key", async () => {
      const result = await actions.setActiveProvider("mistral");

      expect(result).toEqual({ ok: false, errorKey: "unknownProvider" });
      expect(failureMessage(result)).toBeTypeOf("string");
      expect(row()).toMatchObject({ active_ai_provider: "" });
    });

    it("accepts a provider whose probe passed", async () => {
      seed({ anthropicApiKey: ANTHROPIC_KEY, anthropicEnabled: true });

      expect(await actions.setActiveProvider("anthropic")).toEqual({ ok: true });
      expect(row()).toMatchObject({ active_ai_provider: "anthropic" });
    });

    it("refuses a stored-but-unverified provider — being configured is not being verified", async () => {
      // The flag is probe-derived; a key sitting in the column proves nothing.
      // This is the pair of arms that keeps "configured" and "works" apart.
      seed({ geminiApiKey: GEMINI_KEY, geminiEnabled: false });

      expect(await actions.setActiveProvider("gemini")).toEqual({
        ok: false,
        errorKey: "activeNotVerified",
      });
    });
  });

  /**
   * **The ordering hazard: a provider can be active and *then* stop working.**
   *
   * Nothing in the plan says what happens to `active_ai_provider` then, and the
   * answer chosen here is that it is cleared by whichever write switched the
   * flag off. Left dangling, the row would say "OpenAI is active" and "OpenAI is
   * not verified" at once, and phase 12's summariser would quietly do nothing
   * while the page still showed a provider selected -- the exact silent failure
   * the probe-derived flag exists to prevent. `getAiStatus()` derives the same
   * answer on the read side, so a row that goes dangling by any other route is
   * still never *reported* as active; these tests cover the write side.
   */
  describe("an active provider that stops working", () => {
    it("is cleared when its credentials are removed", async () => {
      seed({ openaiApiKey: OPENAI_KEY, openaiEnabled: true, activeAiProvider: "openai" });

      expect(await actions.removeProvider("openai")).toEqual({ ok: true });
      expect(row()).toMatchObject({ openai_enabled: 0, active_ai_provider: "" });
    });

    it("is cleared when a re-save is refused by the provider", async () => {
      seed({ openaiApiKey: OPENAI_KEY, openaiEnabled: true, activeAiProvider: "openai" });
      stubFetch(openaiRejected);

      const result = await actions.saveProvider("openai", {
        apiKey: "a-revoked-key",
        model: OPENAI_MODEL,
        apiUrl: "",
      });

      expect(result).toEqual({ ok: false, errorKey: "openai.rejected" });
      expect(row()).toMatchObject({ openai_enabled: 0, active_ai_provider: "" });
    });

    it("survives a probe that was never answered, because nothing was written", async () => {
      // The other half: an unreachable provider is not a verdict, so a working
      // integration keeps working and the operator's choice is left alone.
      seed({ openaiApiKey: OPENAI_KEY, openaiEnabled: true, activeAiProvider: "openai" });
      stubFetch(networkFailure);

      await actions.saveProvider("openai", {
        apiKey: "a-different-key",
        model: OPENAI_MODEL,
        apiUrl: "",
      });

      expect(row()).toMatchObject({ openai_enabled: 1, active_ai_provider: "openai" });
    });

    it("leaves a different provider's choice alone", async () => {
      // The clear is scoped to the provider that was just written; disabling
      // OpenAI must not switch off an Anthropic selection.
      seed({
        anthropicEnabled: true,
        activeAiProvider: "anthropic",
        openaiApiKey: OPENAI_KEY,
        openaiEnabled: true,
      });

      expect(await actions.removeProvider("openai")).toEqual({ ok: true });
      expect(row()).toMatchObject({ openai_enabled: 0, active_ai_provider: "anthropic" });
    });

    it("is repaired on the next save even if the row went dangling some other way", async () => {
      // The clear runs after every save and every removal rather than only where
      // it is expected to fire, so a row edited by hand -- or by a later phase
      // that flips a flag without going through these actions -- heals.
      seed({ activeAiProvider: "gemini", geminiEnabled: false, geminiApiKey: GEMINI_KEY });
      stubFetch(geminiOk);

      await actions.saveProvider("gemini", { apiKey: KEEP_EXISTING, model: GEMINI_MODEL });

      // The save re-enabled it, so the choice is legitimate again and stands.
      expect(row()).toMatchObject({ gemini_enabled: 1, active_ai_provider: "gemini" });
    });
  });

  describe("saveAdvanced", () => {
    /**
     * Every case here submits {@link VALID_ADVANCED} with **one** field
     * replaced, so a failure is attributable to the bound it names. The plan's
     * own partial payloads (`{ temperature: 2.5 }`) failed on the eight missing
     * fields instead, and would have stayed green whatever the bound did.
     */
    async function withField(field: string, value: unknown): Promise<AiResult> {
      return actions.saveAdvanced({ ...VALID_ADVANCED, [field]: value });
    }

    it("accepts the documented defaults and stores them", async () => {
      expect(await actions.saveAdvanced(VALID_ADVANCED)).toEqual({ ok: true });
      expect(row()).toMatchObject({
        ai_temperature: 0.3,
        ai_max_tokens: 2000,
        ai_default_daily_limit: 200,
        ai_default_monthly_limit: 2000,
        ai_max_prompt_length: 500,
        ai_request_timeout: 120,
        ai_max_retries: 3,
        ai_retry_delay: 2,
        ai_request_delay: 2,
      });
    });

    it("stores a changed value under the column whose `ai` prefix it drops", async () => {
      // The short names are the form's and the query's; the map back to columns
      // lives in exactly one place, and this is what proves it lands right.
      expect(
        await actions.saveAdvanced({ ...VALID_ADVANCED, dailyLimit: 7, monthlyLimit: 70 }),
      ).toEqual({ ok: true });
      expect(row()).toMatchObject({
        ai_default_daily_limit: 7,
        ai_default_monthly_limit: 70,
      });
    });

    it.each([
      ["a temperature above 2", "temperature", 2.5, "advanced.temperatureRange"],
      ["a negative temperature", "temperature", -0.1, "advanced.temperatureRange"],
      ["maxTokens of zero", "maxTokens", 0, "advanced.maxTokensRange"],
      ["a fractional maxTokens", "maxTokens", 10.5, "advanced.maxTokensRange"],
      ["a daily limit of zero", "dailyLimit", 0, "advanced.dailyLimitRange"],
      ["a prompt length of zero", "maxPromptLength", 0, "advanced.maxPromptLengthRange"],
      ["a two-second timeout", "requestTimeout", 2, "advanced.requestTimeoutRange"],
      ["an eleventh retry", "maxRetries", 11, "advanced.maxRetriesRange"],
      ["a negative retry count", "maxRetries", -1, "advanced.maxRetriesRange"],
      ["a two-minute retry delay", "retryDelay", 120, "advanced.retryDelayRange"],
      ["a two-minute request delay", "requestDelay", 120, "advanced.requestDelayRange"],
      ["a temperature that is not a number", "temperature", "warm", undefined],
    ])("rejects %s", async (_label, field, value, errorKey) => {
      const result = await withField(field as string, value);

      expect(result.ok).toBe(false);
      if (errorKey) {
        expect(result.errorKey).toBe(errorKey);
        expect(failureMessage(result)).toBeTypeOf("string");
      }
      // Nothing was written: the row still holds the migration's defaults.
      expect(row()).toMatchObject({ ai_temperature: 0.3, ai_max_tokens: 2000 });
    });

    it("rejects a monthly limit below the daily one, with its own message", async () => {
      // Otherwise the monthly cap is unreachable through the daily one and the
      // daily limit never applies -- one of the two numbers is decoration, and
      // which one depends on an ordering nobody wrote down.
      const result = await actions.saveAdvanced({
        ...VALID_ADVANCED,
        dailyLimit: 500,
        monthlyLimit: 100,
      });

      expect(result).toEqual({ ok: false, errorKey: "advanced.monthlyBelowDaily" });
      // Distinct from the plain range message: "at least as large as the daily
      // one" is different advice from "between 1 and 100000".
      expect(failureMessage(result)).not.toBe(aiMessage("advanced.monthlyLimitRange"));
      expect(failureMessage(result)).toBeTypeOf("string");
    });

    it("accepts a monthly limit exactly equal to the daily one", async () => {
      expect(
        await actions.saveAdvanced({ ...VALID_ADVANCED, dailyLimit: 200, monthlyLimit: 200 }),
      ).toEqual({ ok: true });
    });

    it("accepts the zero-valued ends of the three ranges that allow zero", async () => {
      // Zero is meaningful for all three -- do not retry, no spacing at all --
      // and a bound that refused it would be a bound with no reason.
      expect(
        await actions.saveAdvanced({
          ...VALID_ADVANCED,
          maxRetries: 0,
          retryDelay: 0,
          requestDelay: 0,
        }),
      ).toEqual({ ok: true });
    });

    it("touches only the caller's own row", async () => {
      const { createUserWithPassword } = await import("@/lib/auth/server");
      const other = await createUserWithPassword({
        email: "other@example.com",
        password: "correct horse battery staple",
      });
      client.writeTransaction((tx) =>
        tx.insert(schema.userSettings).values({ userId: other.id, aiMaxTokens: 111 }).run(),
      );

      expect(await actions.saveAdvanced({ ...VALID_ADVANCED, maxTokens: 999 })).toEqual({
        ok: true,
      });

      const connection = new Database(dbPath);
      try {
        expect(
          connection
            .prepare("SELECT ai_max_tokens FROM user_settings WHERE user_id = ?")
            .get(other.id),
        ).toEqual({ ai_max_tokens: 111 });
      } finally {
        connection.close();
      }
    });
  });
});
