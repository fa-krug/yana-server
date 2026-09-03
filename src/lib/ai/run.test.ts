import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseBlocks, plainTextOf } from "@/lib/aggregators/blocks/parser";

import { AI_COLUMNS } from "./columns";
import {
  AI_PROVIDERS,
  DEEPSEEK_API_URL,
  MISTRAL_API_URL,
  OPENAI_DEFAULT_API_URL,
  OPENROUTER_API_URL,
  QWEN_API_URL,
} from "./providers";
import { AIClient, applyAiToBlocks, type AiRuntimeSettings } from "./run";

function makeSettings(overrides: Partial<AiRuntimeSettings> = {}): AiRuntimeSettings {
  const provider = overrides.activeAiProvider ?? overrides.active_ai_provider ?? "gemini";
  return {
    userId: "test-user",
    activeAiProvider: provider,
    aiMaxRetries: 3,
    aiRetryDelay: 0, // speed up tests by default
    aiMaxRetryTime: 60,
    aiRequestTimeout: 30,
    aiTemperature: 0.7,

    geminiEnabled: provider === "gemini",
    geminiApiKey: "test-key",
    geminiModel: "gemini-3-flash-preview",

    openaiEnabled: provider === "openai",
    openaiApiKey: "sk-test",
    openaiModel: "gpt-4o-mini",
    openaiApiUrl: "https://api.openai.com/v1",

    anthropicEnabled: provider === "anthropic",
    anthropicApiKey: "sk-ant-test",
    anthropicModel: "claude-sonnet-4-20250514",

    ...overrides,
  };
}

describe("applyAiToBlocks & AIClient processing", () => {
  const originalFetch = globalThis.fetch;

  // `run.ts` reaches no database at all: it reads a settings object it is handed
  // and calls `fetch`. This file used to migrate a temp database and re-import
  // the module per test, because `generateResponse()` ran a usage counter inside
  // `writeTransaction()` and that read the `getDb()` singleton -- fifteen cold
  // dynamic imports for a dependency the module no longer has. The counter is
  // gone (see "no request cap in front of a call" below), so the import is
  // static and the fixture with it.
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("test_ai_client_retry assertions", () => {
    it("Gemini 429 should be retried and succeed on subsequent attempt", async () => {
      const settings = makeSettings({ activeAiProvider: "gemini", aiRetryDelay: 0 });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: "hello" }] } }],
          }),
        });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toMatchObject({ ok: true, text: "hello" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("OpenAI 429 should be retried and succeed on subsequent attempt", async () => {
      const settings = makeSettings({ activeAiProvider: "openai", aiRetryDelay: 0 });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "hello" } }],
          }),
        });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toMatchObject({ ok: true, text: "hello" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("Anthropic 429 should be retried and succeed on subsequent attempt", async () => {
      const settings = makeSettings({ activeAiProvider: "anthropic", aiRetryDelay: 0 });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            content: [{ text: "hello" }],
          }),
        });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toMatchObject({ ok: true, text: "hello" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("returns null after max retries exhausted", async () => {
      const settings = makeSettings({
        activeAiProvider: "gemini",
        aiMaxRetries: 3,
        aiRetryDelay: 0,
      });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toMatchObject({ ok: false });
      // 1 initial attempt + 3 retries = 4 attempts
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("does NOT retry non-429 errors", async () => {
      const settings = makeSettings({
        activeAiProvider: "gemini",
        aiMaxRetries: 3,
        aiRetryDelay: 0,
      });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toMatchObject({ ok: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reports providerUnauthorized on a 401 without retrying", async () => {
      const settings = makeSettings({
        activeAiProvider: "gemini",
        aiMaxRetries: 3,
        aiRetryDelay: 0,
      });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      fetchMock.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toMatchObject({ ok: false, reason: "providerUnauthorized" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reports providerUnauthorized on a 403 without retrying", async () => {
      const settings = makeSettings({
        activeAiProvider: "gemini",
        aiMaxRetries: 3,
        aiRetryDelay: 0,
      });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      fetchMock.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toMatchObject({ ok: false, reason: "providerUnauthorized" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("still reports plain providerError on a 500, distinct from providerUnauthorized", async () => {
      const settings = makeSettings({
        activeAiProvider: "gemini",
        aiMaxRetries: 3,
        aiRetryDelay: 0,
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toMatchObject({ ok: false, reason: "providerError" });
    });

    it("with maxRetries = 0, no retry is attempted", async () => {
      const settings = makeSettings({
        activeAiProvider: "gemini",
        aiMaxRetries: 0,
        aiRetryDelay: 0,
      });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toMatchObject({ ok: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("stops retrying when maxRetryTime budget would be exceeded", async () => {
      const settings = makeSettings({
        activeAiProvider: "gemini",
        aiMaxRetries: 5,
        aiRetryDelay: 2,
        aiMaxRetryTime: 3, // max retry time budget of 3s
      });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toMatchObject({ ok: false });
      // Attempt 0: delay 2s, 2s < 3s -> retry
      // Attempt 1: delay 4s, 2s + 4s = 6s > 3s -> budget exceeded, stops retry!
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("test_ai_json_extraction assertions", () => {
    it("extracts json payload when response contains surrounding markdown fluff and checks Gemini schema payload", async () => {
      const userSettings = makeSettings({ activeAiProvider: "gemini" });
      // `ai_improve_writing` rather than `ai_summarize`: this test's subject is
      // the markdown-fenced JSON payload, and only a request that rewrites the
      // body asks for 'title'/'content' at all (see `wantsRewrite` in
      // `./run`). Summarize-only asks for 'summary' and nothing else.
      const options = { ai_improve_writing: true };

      let capturedUrl = "";
      let capturedBody:
        | {
            generationConfig?: {
              responseMimeType?: string;
              responseSchema?: { type?: string; properties?: Record<string, { type?: string }> };
              responseJsonSchema?: unknown;
            };
          }
        | undefined;

      globalThis.fetch = vi.fn().mockImplementation(async (url, init) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(init.body);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: `
                Wait, here is the JSON:
                \`\`\`json
                {
                    "title": "Clean Title",
                    "document": "Clean prose."
                }
                \`\`\`
                `,
                    },
                  ],
                },
              },
            ],
          }),
        };
      });

      const result = await applyAiToBlocks(
        { title: "Old", blocks: parseBlocks("<p>Old content</p>") },
        options,
        userSettings,
      );

      expect(result.title).toBe("Clean Title");
      expect(plainTextOf(result.blocks)).toBe("Clean prose.");

      expect(capturedUrl).toContain("generativelanguage.googleapis.com");
      const config = capturedBody?.generationConfig || {};
      const schema = config.responseSchema;
      expect(config.responseMimeType).toBe("application/json");
      expect(schema).toBeDefined();
      expect(config.responseJsonSchema).toBeUndefined();
      expect(schema?.type).toBe("OBJECT");
      expect(schema?.properties?.title.type).toBe("STRING");
      expect(schema?.properties?.document.type).toBe("STRING");
    });
  });

  describe("test_ai_client_logging assertions", () => {
    it("logs API request failures at warning level instead of error", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const settings = makeSettings({ activeAiProvider: "gemini", aiMaxRetries: 0 });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      });

      const client = new AIClient(settings);
      await client.generateResponse("test");

      expect(warnSpy).toHaveBeenCalled();
      for (const call of errorSpy.mock.calls) {
        const msg = String(call[0] || "");
        expect(msg).not.toContain("Request Error");
        expect(msg).not.toContain("API call failed");
      }
    });
  });

  describe("no request cap in front of a call", () => {
    /**
     * The per-user daily/monthly request caps, and the `ai_requests` table
     * that counted against them, were removed on the owner's instruction:
     * switched on, AI runs without a quota refusing it. These cases exist so
     * that stays true -- a reintroduced cap, or a stray counter, fails here.
     */
    it("lets an unbounded run of calls through, every one reaching the provider", async () => {
      const settings = makeSettings({ activeAiProvider: "gemini" });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
      } as Response);
      globalThis.fetch = fetchMock;

      const client = new AIClient(settings);
      for (let i = 0; i < 25; i++) {
        expect(await client.generateResponse("test prompt")).toEqual({ ok: true, text: "ok" });
      }

      // 25 is past every default the old caps shipped with on a per-call basis
      // and well past any plausible small limit, so a cap of any shape would
      // have short-circuited before here.
      expect(fetchMock).toHaveBeenCalledTimes(25);
    });

    it("records nothing per call: no usage table remains to write to", async () => {
      const schema = await import("@/lib/db/schema");

      // The table is gone from the schema barrel, not merely unread. Left
      // behind, a future caller could start counting against it again without
      // anyone deciding to.
      expect("aiRequests" in schema).toBe(false);
    });

    it("cannot answer a limit reason at all", async () => {
      const settings = makeSettings({ activeAiProvider: "" });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      // The only failure arms left are noProvider / providerUnauthorized /
      // providerError -- the two limit reasons are off the union, so a caller
      // branching on them is a typecheck failure rather than dead code.
      expect(result).toEqual({ ok: false, reason: "noProvider" });
    });

    it("needs no userId on the settings row to make a call", async () => {
      const settings = makeSettings({ activeAiProvider: "gemini", userId: undefined });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: "hello" }] } }] }),
      } as Response);

      const client = new AIClient(settings);

      // It used to warn "usage limit not enforced for this call" here, because
      // a missing userId meant the counter had no key. With no counter there is
      // nothing to not-enforce, so this is an ordinary call now.
      expect(await client.generateResponse("test prompt")).toMatchObject({
        ok: true,
        text: "hello",
      });
    });
  });

  describe("a stale stored model id falls back to the registry default", () => {
    /**
     * `getAiStatus()` already runs every stored model id through
     * `resolveModel()` before rendering it, so `/ai` shows the *substituted*
     * current model for a row written before a registry refresh retired the
     * id it holds. `run.ts` must resolve the same way, or the actual
     * provider request goes out on the retired id -- a 404 from the
     * provider on every aggregation cycle, invisible anywhere but a job log.
     *
     * `gemini-1.5-flash` is a real case, not a hypothetical: migration
     * `0003_ai_model_defaults` changed only the column *default*, so every
     * `user_settings` row created before it still holds this phase-2 id,
     * which `providers.ts` no longer lists at all.
     */
    it("sends the registry's current default model, not a retired stored one", async () => {
      const provider = AI_PROVIDERS.find((p) => p.key === "gemini")!;
      const settings = makeSettings({
        activeAiProvider: "gemini",
        geminiEnabled: true,
        geminiApiKey: "k",
        geminiModel: "gemini-1.5-flash",
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
      } as Response);
      globalThis.fetch = fetchMock;

      const client = new AIClient(settings);
      const result = await client.generateResponse("hi");

      expect(result).toEqual({ ok: true, text: "ok" });
      const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain(provider.defaultModel);
      expect(calledUrl).not.toContain("gemini-1.5-flash");
    });
  });

  /**
   * **Every one of the seven registered providers, actually exercised.**
   *
   * Nothing before this block ever called `callMistral()`, `callQwen()` or
   * `callDeepseek()` -- the retry and json-extraction suites above only drive
   * `openai`/`anthropic`/`gemini`. That gap meant a seventh provider (or a typo
   * in one of these three's base URL or response parsing) would typecheck and
   * ship with nothing catching it at runtime. This iterates `AI_PROVIDERS`
   * itself (not a hand-written list of seven keys) so a future provider is
   * included automatically, stubs `fetch` with *that provider's own* response
   * shape, and asserts both the parsed text and the exact outbound URL --
   * against the exported `*_API_URL` constants in `./providers`, never a
   * hard-coded string, so a change to one of them is a single edit rather than
   * a test left asserting a stale value.
   */
  describe("generateResponse across every registered provider", () => {
    const responseShapeFor = (key: (typeof AI_PROVIDERS)[number]["key"], text: string): unknown => {
      switch (key) {
        case "anthropic":
          return { content: [{ type: "text", text }] };
        case "gemini":
          return { candidates: [{ content: { parts: [{ text }] } }] };
        default:
          // openai, mistral, qwen, deepseek, openrouter: the shared
          // OpenAI-compatible shape.
          return { choices: [{ message: { content: text } }] };
      }
    };

    const expectedUrlFor = (
      key: (typeof AI_PROVIDERS)[number]["key"],
      provider: (typeof AI_PROVIDERS)[number],
      apiKey: string,
    ): string => {
      switch (key) {
        case "openai":
          return `${OPENAI_DEFAULT_API_URL}/chat/completions`;
        case "anthropic":
          return "https://api.anthropic.com/v1/messages";
        case "gemini":
          return `https://generativelanguage.googleapis.com/v1beta/models/${provider.defaultModel}:generateContent?key=${apiKey}`;
        case "mistral":
          return `${MISTRAL_API_URL}/chat/completions`;
        case "qwen":
          return `${QWEN_API_URL}/chat/completions`;
        case "deepseek":
          return `${DEEPSEEK_API_URL}/chat/completions`;
        case "openrouter":
          return `${OPENROUTER_API_URL}/chat/completions`;
      }
    };

    it.each(AI_PROVIDERS.map((provider) => provider.key))(
      "calls %s with its own request shape and parses its own response shape",
      async (key) => {
        const provider = AI_PROVIDERS.find((p) => p.key === key);
        if (!provider) throw new Error(`no AI_PROVIDERS entry for "${key}"`);
        const columns = AI_COLUMNS[key];
        const apiKey = `test-${key}-key`;
        const text = `${key} reply`;

        const settings = makeSettings({
          activeAiProvider: key,
          [columns.enabled]: true,
          [columns.apiKey]: apiKey,
          [columns.model]: provider.defaultModel,
        } as Partial<AiRuntimeSettings>);

        const fetchMock = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => responseShapeFor(key, text),
        } as Response);
        globalThis.fetch = fetchMock;

        const client = new AIClient(settings);
        const result = await client.generateResponse("test prompt");

        expect(result).toEqual({ ok: true, text });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
        expect(calledUrl).toBe(expectedUrlFor(key, provider, apiKey));

        // **No output cap goes out**, on any provider but the one whose API
        // will not take a request without one. `aiMaxTokens` was removed with
        // the request caps, and it was the more damaging of the two: its
        // default was below what a rewritten article needs, so a longer one
        // came back truncated mid-JSON and the whole paid request was spent on
        // an answer that could not be parsed. A reintroduced cap would fail
        // here rather than only on a long article.
        const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as Record<
          string,
          unknown
        >;
        if (key === "anthropic") {
          // Required by the Messages API, so a constant rather than a setting.
          expect(body.max_tokens).toBe(16000);
        } else if (key === "gemini") {
          expect(body.generationConfig).not.toHaveProperty("maxOutputTokens");
        } else {
          expect(body).not.toHaveProperty("max_tokens");
          expect(body).not.toHaveProperty("max_completion_tokens");
        }
      },
    );
  });

  /**
   * The AI stage works on the block tree, so every case here builds one with
   * the real `parseBlocks()` rather than a literal: the point of the change is
   * that the stage consumes exactly what gets stored, and a hand-built tree
   * would not prove that pairing.
   */
  describe("applyAiToBlocks", () => {
    const BODY = '<section data-sanitized-class="article-content"><p>Body one.</p></section>';
    const LEAD = '<img src="yana-img://lead">';

    const blocksOf = (html: string) => parseBlocks(html, "https://example.com/a");
    const docOf = (html: string, title = "Original") => ({ title, blocks: blocksOf(html) });
    const openai = () =>
      makeSettings({ activeAiProvider: "openai", openaiEnabled: true, openaiApiKey: "sk-test" });

    /** OpenAI-shaped answer; returns a getter for the request body it saw. */
    function respondWith(payload: Record<string, string>): () => string {
      let sent = "";
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        sent = String(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        } as Response;
      });
      return () => sent;
    }

    /** The notation the model was actually shown, pulled back out of the body. */
    function documentSent(body: string): string {
      const outer = JSON.parse(body) as { messages: { content: string }[] };
      const prompt = outer.messages[0].content;
      const input = prompt.slice(prompt.lastIndexOf("\n\nInput:\n") + "\n\nInput:\n".length);
      return (JSON.parse(input) as { document?: string; text?: string }).document ?? "";
    }

    describe("what crosses the wire", () => {
      it("sends the block notation, not HTML", async () => {
        const sent = respondWith({ title: "T", document: "Rewritten." });

        await applyAiToBlocks(docOf(BODY), { ai_improve_writing: true }, openai());

        // The wrappers, classes and tags the HTML form paid for on every
        // article are simply not part of the format any more.
        expect(sent()).not.toContain("article-content");
        expect(sent()).not.toContain("<section");
        expect(sent()).not.toContain("data-sanitized");
        expect(documentSent(sent())).toBe("Body one.");
      });

      it("sends no URL, only an index the model cannot dereference", async () => {
        const sent = respondWith({ title: "T", document: "x" });
        const html = '<p>See <a href="https://tracker.example.com/x?utm=1">this</a>.</p>';

        await applyAiToBlocks(docOf(html), { ai_translate: true }, openai());

        expect(sent()).not.toContain("tracker.example.com");
        expect(documentSent(sent())).toContain("(L0)");
      });

      it("sends no image ref, embed or code, only placeholders", async () => {
        const sent = respondWith({ title: "T", document: "x" });
        const html = `${LEAD}<pre><code>rm -rf /tmp/x</code></pre><p>Text.</p>`;

        await applyAiToBlocks(docOf(html), { ai_improve_writing: true }, openai());

        expect(sent()).not.toContain("yana-img://");
        expect(sent()).not.toContain("rm -rf");
        expect(documentSent(sent())).toMatch(/\[\[M\d+\]\]/);
      });

      it("sends plain text and asks only for a summary when that is all that was asked", async () => {
        const sent = respondWith({ summary: "S." });

        await applyAiToBlocks(docOf(BODY), { ai_summarize: true }, openai());

        expect(sent()).toContain("the key 'summary'");
        expect(sent()).not.toContain("'document'");
        expect(sent()).toContain("do not reproduce the article");
        // No notation spec either: nothing comes back in it.
        expect(sent()).not.toContain("[[M7]]");
      });

      it("teaches the notation only when the document has to come back", async () => {
        const sent = respondWith({ title: "T", document: "x" });

        await applyAiToBlocks(docOf(BODY), { ai_improve_writing: true }, openai());

        expect(sent()).toContain("blank line separates blocks");
        expect(sent()).toContain("[[M7]]");
      });
    });

    describe("restructuring is allowed", () => {
      it("accepts a different number of blocks than it was given", async () => {
        respondWith({ title: "T", document: "## New heading\n\nOne.\n\nTwo.\n\nThree." });

        const result = await applyAiToBlocks(
          docOf("<p>a</p><p>b</p>"),
          { ai_improve_writing: true },
          openai(),
        );

        expect(result.outcome).toEqual({ status: "applied" });
        expect(result.blocks.map((b) => b.kind)).toEqual([
          "heading",
          "paragraph",
          "paragraph",
          "paragraph",
        ]);
      });

      it("accepts structure the input never had", async () => {
        respondWith({ title: "T", document: "- one\n- two\n\n> quoted" });

        const result = await applyAiToBlocks(
          docOf("<p>flat prose</p>"),
          { ai_improve_writing: true },
          openai(),
        );

        expect(result.blocks.map((b) => b.kind)).toEqual(["list", "blockquote"]);
      });

      it("tells the model the structure is its to change", async () => {
        const sent = respondWith({ title: "T", document: "x" });

        await applyAiToBlocks(docOf(BODY), { ai_improve_writing: true }, openai());

        expect(sent()).toContain("merge, split and reorder");
      });
    });

    describe("what restructuring may not touch", () => {
      it("keeps the lead media first even when the model moves it", async () => {
        // Clients hoist block 0 when it is an image, so a relocated lead image
        // silently changes what a timeline shows.
        respondWith({ title: "T", document: "Prose first now.\n\n[[M0]]" });

        const result = await applyAiToBlocks(
          docOf(`${LEAD}${BODY}`),
          { ai_improve_writing: true },
          openai(),
        );

        expect(result.blocks[0]).toMatchObject({ kind: "image", ref: "yana-img://lead" });
      });

      it("does not duplicate the lead media when the model keeps it in place", async () => {
        // The normal path, and the one the three positional assertions below
        // could not see: `textToBlocks()` returns a *fresh* object for an image
        // (its caption is rewritable), so an identity test read "the model
        // dropped it" and prepended a second copy. One image in, two out, in
        // every AI rewrite of an article with a lead image.
        // Echo the document straight back, placeholder intact -- what a
        // well-behaved rewrite looks like.
        globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
          const prompt = (JSON.parse(String(init.body)) as { messages: { content: string }[] })
            .messages[0].content;
          const marker = "\n\nInput:\n";
          const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as {
            document: string;
          };
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [
                { message: { content: JSON.stringify({ title: "T", document: input.document }) } },
              ],
            }),
          } as Response;
        });

        const result = await applyAiToBlocks(
          docOf(`${LEAD}${BODY}`),
          { ai_improve_writing: true },
          openai(),
        );

        expect(result.blocks.filter((b) => b.kind === "image")).toHaveLength(1);
        expect(result.blocks[0]).toMatchObject({ kind: "image", ref: "yana-img://lead" });
      });

      it("does not duplicate the lead media when the model emits its placeholder twice", async () => {
        respondWith({ title: "T", document: "[[M0]]\n\nProse.\n\n[[M0]]" });

        const result = await applyAiToBlocks(
          docOf(`${LEAD}${BODY}`),
          { ai_improve_writing: true },
          openai(),
        );

        // A duplicated thumbnail is the same defect as a moved one.
        expect(result.blocks.filter((b) => b.kind === "image")).toHaveLength(1);
        expect(result.blocks[0]).toMatchObject({ kind: "image", ref: "yana-img://lead" });
      });

      it("puts the lead media back when the model drops it entirely", async () => {
        respondWith({ title: "T", document: "Only prose." });

        const result = await applyAiToBlocks(
          docOf(`${LEAD}${BODY}`),
          { ai_improve_writing: true },
          openai(),
        );

        expect(result.blocks[0]).toMatchObject({ kind: "image", ref: "yana-img://lead" });
      });

      it("restores an image ref verbatim rather than whatever the model wrote", async () => {
        // The model never saw the ref, so it cannot have rewritten it -- this
        // pins that the placeholder resolves from the table, not the answer.
        respondWith({ title: "T", document: "[[M0]]\n\nText." });

        const result = await applyAiToBlocks(
          docOf(`${LEAD}${BODY}`),
          { ai_improve_writing: true },
          openai(),
        );

        expect(result.blocks[0]).toMatchObject({ ref: "yana-img://lead" });
      });

      it("reports dropped media to the job log rather than losing it silently", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        respondWith({ title: "T", document: "Just prose." });
        const onLog = vi.fn();

        await applyAiToBlocks(
          docOf(`<p>a</p><hr><pre><code>x</code></pre>`),
          { ai_improve_writing: true },
          openai(),
          onLog,
        );

        expect(onLog).toHaveBeenCalledWith(expect.stringContaining("dropped"));
      });
    });

    describe("the summary", () => {
      it("becomes a summary block after the lead media", async () => {
        respondWith({ summary: "The gist." });

        const result = await applyAiToBlocks(
          docOf(`${LEAD}${BODY}`),
          { ai_summarize: true },
          openai(),
        );

        expect(result.outcome).toEqual({ status: "applied" });
        expect(result.blocks[0].kind).toBe("image");
        expect(result.blocks[1]).toMatchObject({
          kind: "summary",
          blocks: [{ kind: "paragraph" }],
        });
        expect(plainTextOf([result.blocks[1]])).toBe("The gist.");
      });

      it("comes first when there is no lead media", async () => {
        respondWith({ summary: "S." });

        const result = await applyAiToBlocks(docOf(BODY), { ai_summarize: true }, openai());

        expect(result.blocks[0].kind).toBe("summary");
      });

      it("keeps a two-paragraph answer inside the one block", async () => {
        respondWith({ summary: "First.\n\nSecond." });

        const result = await applyAiToBlocks(docOf(BODY), { ai_summarize: true }, openai());

        expect(result.blocks[0]).toMatchObject({
          kind: "summary",
          blocks: [{ kind: "paragraph" }, { kind: "paragraph" }],
        });
      });

      it("leaves the article intact", async () => {
        respondWith({ summary: "S." });

        const result = await applyAiToBlocks(docOf(BODY), { ai_summarize: true }, openai());

        expect(plainTextOf(result.blocks)).toContain("Body one.");
      });

      it("keeps the original title, which a summarize-only request never asked about", async () => {
        respondWith({ title: "Model's own title", summary: "S." });

        const result = await applyAiToBlocks(docOf(BODY), { ai_summarize: true }, openai());

        expect(result.title).toBe("Original");
      });
    });

    describe("failure arms", () => {
      it("reports skipped when no AI option is set", async () => {
        const fetchMock = vi.fn();
        globalThis.fetch = fetchMock;

        const result = await applyAiToBlocks(docOf(BODY), { ai_summarize: false }, openai());

        expect(result.outcome).toEqual({ status: "skipped" });
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("reports failed, not skipped, when AI was asked for with no provider", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const result = await applyAiToBlocks(
          docOf(BODY),
          { ai_summarize: true },
          makeSettings({ activeAiProvider: "" }),
        );

        expect(result.outcome).toEqual({ status: "failed", reason: "noProvider" });
      });

      it("keeps the article when the answer is not JSON", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "not json at all" } }] }),
        } as Response);

        const input = docOf(BODY);
        const result = await applyAiToBlocks(input, { ai_improve_writing: true }, openai());

        expect(result.outcome).toEqual({ status: "failed", reason: "invalidJson" });
        expect(result.blocks).toEqual(input.blocks);
        expect(result.title).toBe("Original");
      });

      it("reports the provider's own reason on a rejected credential", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        globalThis.fetch = vi
          .fn()
          .mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" } as Response);

        const result = await applyAiToBlocks(docOf(BODY), { ai_summarize: true }, openai());

        expect(result.outcome).toEqual({
          status: "failed",
          reason: "providerUnauthorized",
        });
      });

      it("reports a rewrite whose document did not come back, and keeps the title as it was", async () => {
        // The defect a user reported as "reload only translates the title": the
        // answer's title used to be applied on its own, the source blocks
        // stored beside it and the outcome reported as `applied` -- a
        // translated title over an untranslated body, on a green job with
        // nothing in its log.
        vi.spyOn(console, "warn").mockImplementation(() => {});
        respondWith({ title: "Übersetzter Titel" });
        const onLog = vi.fn();

        const input = docOf(BODY);
        const result = await applyAiToBlocks(
          input,
          { ai_translate: true, ai_translate_language: "German" },
          openai(),
          onLog,
        );

        expect(result.outcome).toEqual({ status: "failed", reason: "missingDocument" });
        expect(result.title).toBe("Original");
        expect(result.blocks).toEqual(input.blocks);
        expect(result.requested).toBe(true);
        expect(onLog).toHaveBeenCalledWith(expect.stringContaining("no rewritten document"));
      });

      it.each([
        ["an empty document", ""],
        ["notation that reads as no blocks at all", "   \n\n  "],
      ])("reports %s the same way as an absent one", async (_label, document) => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        respondWith({ title: "Übersetzter Titel", document });

        const input = docOf(BODY);
        const result = await applyAiToBlocks(
          input,
          { ai_translate: true, ai_translate_language: "German" },
          openai(),
        );

        expect(result.outcome).toEqual({ status: "failed", reason: "missingDocument" });
        expect(result.title).toBe("Original");
        expect(result.blocks).toEqual(input.blocks);
      });

      it("says on the job's log that it ran, what it was asked for and what changed", async () => {
        // The line whose absence made this bug a guessing game: a job log that
        // read "reloaded article content" and nothing else could not say
        // whether the stage had run at all.
        respondWith({ title: "Übersetzter Titel", document: "Absatz eins.\n\nAbsatz zwei." });
        const onLog = vi.fn();

        const result = await applyAiToBlocks(
          docOf(BODY),
          { ai_translate: true, ai_translate_language: "German" },
          openai(),
          onLog,
        );

        expect(result.outcome).toEqual({ status: "applied" });
        expect(onLog).toHaveBeenCalledWith(
          "AI (translate) applied to 'Original': document 1 -> 2 blocks, title rewritten",
        );
      });

      it("names every option it was asked for, and reports a title left alone", async () => {
        respondWith({ title: "Original", document: "Rewritten.", summary: "Kurzfassung." });
        const onLog = vi.fn();

        await applyAiToBlocks(
          docOf(BODY),
          { ai_summarize: true, ai_improve_writing: true, ai_translate: true },
          openai(),
          onLog,
        );

        expect(onLog).toHaveBeenCalledWith(
          "AI (summarize+improve+translate) applied to 'Original': " +
            "document 1 -> 1 blocks, title unchanged, summary added",
        );
      });

      it("fails a translation whose document came back unchanged, rather than storing it", async () => {
        // The remaining shape of "reload only translates the title": a model
        // that translates the title and echoes the document back. The echo
        // parses perfectly, so before this it was stored over the article and
        // the job reported success.
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const onLog = vi.fn();

        // Two passes: the first learns the notation the model is shown, the
        // second answers with exactly that -- an echo, built from the real
        // document rather than from a guess at what it looks like.
        const seen = respondWith({ title: "T", document: "Rewritten." });
        const input = docOf(BODY);
        const options = { ai_translate: true, ai_translate_language: "German" };
        await applyAiToBlocks(input, options, openai());
        const echo = documentSent(seen());
        expect(echo).not.toBe("");

        respondWith({ title: "Übersetzter Titel", document: echo });
        const result = await applyAiToBlocks(input, options, openai(), onLog);

        expect(result.outcome).toEqual({ status: "failed", reason: "documentUnchanged" });
        expect(result.title).toBe("Original");
        expect(result.blocks).toEqual(input.blocks);
        expect(onLog).toHaveBeenCalledWith(expect.stringContaining("unchanged"));
      });

      it("keeps an improve-writing answer that came back unchanged, and says so in the log", async () => {
        // "This reads fine as it is" is a legitimate answer to that request,
        // unlike to a translation -- so a note, not a failure.
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const onLog = vi.fn();

        const seen = respondWith({ title: "T", document: "Rewritten." });
        const input = docOf(BODY);
        await applyAiToBlocks(input, { ai_improve_writing: true }, openai());
        const echo = documentSent(seen());

        respondWith({ title: "Same title", document: echo });
        const result = await applyAiToBlocks(input, { ai_improve_writing: true }, openai(), onLog);

        expect(result.outcome).toEqual({ status: "applied" });
        expect(result.title).toBe("Same title");
        expect(onLog).toHaveBeenCalledWith(expect.stringContaining("unchanged"));
      });

      it("tells the model the document must not come back in its original language", async () => {
        const sent = respondWith({ title: "T", document: "Übersetzt." });

        await applyAiToBlocks(
          docOf(BODY),
          { ai_translate: true, ai_translate_language: "German" },
          openai(),
        );

        const prompt = JSON.parse(sent()).messages[0].content as string;
        expect(prompt).toContain("Every line of the document must come back in German");
        expect(prompt).toContain("quoted lines");
        expect(prompt).toContain("not an acceptable answer");
      });

      it("keeps a rewrite that came back when the requested summary did not", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        respondWith({ title: "New title", document: "Rewritten prose." });
        const onLog = vi.fn();

        const result = await applyAiToBlocks(
          docOf(BODY),
          { ai_summarize: true, ai_improve_writing: true },
          openai(),
          onLog,
        );

        expect(result.outcome).toEqual({ status: "failed", reason: "missingSummary" });
        expect(result.title).toBe("New title");
        expect(plainTextOf(result.blocks)).toContain("Rewritten prose.");
        expect(onLog).toHaveBeenCalledWith(expect.stringContaining("no summary"));
      });

      it("leaves a summarize-only article untouched when the summary did not come back", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        respondWith({ title: "New title", document: "Rewritten." });

        const input = docOf(BODY);
        const result = await applyAiToBlocks(input, { ai_summarize: true }, openai());

        // Nothing else was asked for, so a volunteered title and document are
        // answers to a different question.
        expect(result.outcome).toEqual({ status: "failed", reason: "missingSummary" });
        expect(result.title).toBe("Original");
        expect(result.blocks).toEqual(input.blocks);
      });

      it("skips an article with no blocks at all", async () => {
        const fetchMock = vi.fn();
        globalThis.fetch = fetchMock;

        const result = await applyAiToBlocks(
          { title: "T", blocks: [] },
          { ai_summarize: true },
          openai(),
        );

        expect(result.outcome).toEqual({ status: "skipped" });
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });

    describe("the feed's own extra instruction", () => {
      it("is sent, delimited, ahead of the output contract", async () => {
        const sent = respondWith({ title: "T", document: "x" });

        await applyAiToBlocks(
          docOf(BODY),
          { ai_custom_prompt: true, ai_custom_prompt_text: "Keep it playful." },
          openai(),
        );

        const body = sent();
        expect(body).toContain("Keep it playful.");
        expect(body.indexOf("Keep it playful.")).toBeLessThan(body.indexOf("in the notation"));
      });

      it("counts as a rewrite on its own, since it is free-form", async () => {
        const sent = respondWith({ title: "T", document: "x" });

        await applyAiToBlocks(
          docOf(BODY),
          { ai_custom_prompt: true, ai_custom_prompt_text: "Do a thing." },
          openai(),
        );

        expect(sent()).toContain("'document'");
      });

      it("is a no-op when the box is checked but the text is empty", async () => {
        const fetchMock = vi.fn();
        globalThis.fetch = fetchMock;

        const result = await applyAiToBlocks(
          docOf(BODY),
          { ai_custom_prompt: true, ai_custom_prompt_text: "   " },
          openai(),
        );

        expect(result.outcome).toEqual({ status: "skipped" });
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("is a no-op when text is present but the box is unchecked", async () => {
        const fetchMock = vi.fn();
        globalThis.fetch = fetchMock;

        const result = await applyAiToBlocks(
          docOf(BODY),
          { ai_custom_prompt: false, ai_custom_prompt_text: "Ignore me." },
          openai(),
        );

        expect(result.outcome).toEqual({ status: "skipped" });
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });

    describe("translation", () => {
      it("names the target language and protects the link indices", async () => {
        const sent = respondWith({ title: "T", document: "x" });

        await applyAiToBlocks(
          docOf(BODY),
          { ai_translate: true, ai_translate_language: "German" },
          openai(),
        );

        expect(sent()).toContain("to German");
        expect(sent()).toContain("never the (L...) index");
      });

      it("applies the translated title", async () => {
        respondWith({ title: "Übersetzt", document: "Übersetzter Text." });

        const result = await applyAiToBlocks(docOf(BODY), { ai_translate: true }, openai());

        expect(result.title).toBe("Übersetzt");
        expect(plainTextOf(result.blocks)).toContain("Übersetzter Text.");
      });
    });
  });
});
