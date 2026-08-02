import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AIClient, applyAiOptions } from "./run";

function makeSettings(overrides: Record<string, unknown> = {}) {
  const provider = overrides.activeAiProvider ?? overrides.active_ai_provider ?? "gemini";
  return {
    activeAiProvider: provider,
    aiMaxRetries: 3,
    aiRetryDelay: 0, // speed up tests by default
    aiMaxRetryTime: 60,
    aiRequestTimeout: 30,
    aiTemperature: 0.7,
    aiMaxTokens: 1000,

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

describe("applyAiOptions & AIClient processing", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("test_ai_processing assertions", () => {
    it("translates title and content when ai_translate option is set", async () => {
      const userSettings = makeSettings({
        activeAiProvider: "openai",
        openaiEnabled: true,
        openaiApiKey: "sk-test",
      });

      const options = { ai_translate: true, ai_translate_language: "German" };
      const article = {
        name: "Original Title",
        content: "<p>Original Content</p>",
        identifier: "http://example.com/1",
      };

      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Übersetzter Titel",
                content: "<p>Übersetzter Inhalt</p>",
              }),
            },
          },
        ],
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      await applyAiOptions(article, options, userSettings);

      expect(article.name).toBe("Übersetzter Titel");
      expect(article.content).toBe("<p>Übersetzter Inhalt</p>");
    });

    it("handles json failure gracefully without crashing or corrupting article", async () => {
      const userSettings = makeSettings();
      const options = { ai_translate: true, ai_translate_language: "German" };
      const article = {
        name: "Original Title",
        content: "<p>Original Content</p>",
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "Not valid JSON" }] } }],
        }),
      } as Response);

      await applyAiOptions(article, options, userSettings);

      expect(article.name).toBe("Original Title");
      expect(article.content).toBe("<p>Original Content</p>");
    });

    it("includes instructions for preserving links when improving writing", async () => {
      const userSettings = makeSettings();
      const options = { ai_improve_writing: true };
      const article = {
        name: "Original Title",
        content: '<p>This is text with <a href="https://example.com">a link</a> here.</p>',
      };

      let sentPrompt = "";
      globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
        const body = JSON.parse(init.body);
        sentPrompt = body.contents[0].parts[0].text;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title: "Improved Title",
                        content:
                          '<p>This is improved text with <a href="https://example.com">a link</a> preserved.</p>',
                      }),
                    },
                  ],
                },
              },
            ],
          }),
        };
      });

      await applyAiOptions(article, options, userSettings);

      expect(article.content).toContain('<a href="https://example.com">');
      expect(article.content).toContain("a link");

      expect(sentPrompt).toContain("Preserve the complete HTML structure");
      expect(sentPrompt).toContain("Keep all links");
    });

    it("includes instructions to not translate link labels during translation", async () => {
      const userSettings = makeSettings();
      const options = { ai_translate: true, ai_translate_language: "German" };
      const article = {
        name: "Original Title",
        content: '<p>This is text with <a href="https://example.com">Read More</a> here.</p>',
      };

      let sentPrompt = "";
      globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
        const body = JSON.parse(init.body);
        sentPrompt = body.contents[0].parts[0].text;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title: "Übersetzter Titel",
                        content:
                          '<p>Dies ist übersetzter Text mit <a href="https://example.com">Read More</a> hier.</p>',
                      }),
                    },
                  ],
                },
              },
            ],
          }),
        };
      });

      await applyAiOptions(article, options, userSettings);

      expect(article.content).toContain("Read More");
      expect(sentPrompt).toContain("Do NOT translate link labels");
      expect(sentPrompt).toContain("Keep link text in the original language");
    });

    it("preserves complex HTML structure", async () => {
      const userSettings = makeSettings();
      const options = { ai_improve_writing: true };
      const complexHtml = `
        <div>
            <h1>Heading</h1>
            <p>Paragraph with <a href="https://example.com">link</a>.</p>
            <ul>
                <li>List item 1</li>
                <li>List item 2</li>
            </ul>
            <img src="image.jpg" alt="Image">
        </div>
      `;

      let sentPrompt = "";
      globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
        const body = JSON.parse(init.body);
        sentPrompt = body.contents[0].parts[0].text;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title: "Improved Title",
                        content: complexHtml.trim(),
                      }),
                    },
                  ],
                },
              },
            ],
          }),
        };
      });

      const article = { name: "Original Title", content: complexHtml };
      await applyAiOptions(article, options, userSettings);

      expect(article.content).toContain("<h1>");
      expect(article.content).toContain("<ul>");
      expect(article.content).toContain("<li>");
      expect(article.content).toContain("<img");
      expect(article.content).toContain('<a href="https://example.com">');
      expect(sentPrompt).toContain("Preserve ALL HTML tags");
    });
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

      expect(result).toBe("hello");
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

      expect(result).toBe("hello");
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

      expect(result).toBe("hello");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("returns null after max retries exhausted", async () => {
      const settings = makeSettings({ activeAiProvider: "gemini", aiMaxRetries: 3, aiRetryDelay: 0 });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toBeNull();
      // 1 initial attempt + 3 retries = 4 attempts
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("does NOT retry non-429 errors", async () => {
      const settings = makeSettings({ activeAiProvider: "gemini", aiMaxRetries: 3, aiRetryDelay: 0 });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("with maxRetries = 0, no retry is attempted", async () => {
      const settings = makeSettings({ activeAiProvider: "gemini", aiMaxRetries: 0, aiRetryDelay: 0 });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toBeNull();
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

      expect(result).toBeNull();
      // Attempt 0: delay 2s, 2s < 3s -> retry
      // Attempt 1: delay 4s, 2s + 4s = 6s > 3s -> budget exceeded, stops retry!
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("test_ai_json_extraction assertions", () => {
    it("extracts json payload when response contains surrounding markdown fluff and checks Gemini schema payload", async () => {
      const userSettings = makeSettings({ activeAiProvider: "gemini" });
      const options = { ai_summarize: true };

      let capturedUrl = "";
      let capturedBody: any = null;

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
                    "content": "Clean Content"
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

      const article = { name: "Old", content: "Old content" };
      await applyAiOptions(article, options, userSettings);

      expect(article.name).toBe("Clean Title");
      expect(article.content).toBe("Clean Content");

      expect(capturedUrl).toContain("generativelanguage.googleapis.com");
      const config = capturedBody?.generationConfig || {};
      expect(config.responseMimeType).toBe("application/json");
      expect(config.responseSchema).toBeDefined();
      expect(config.responseJsonSchema).toBeUndefined();
      expect(config.responseSchema.type).toBe("OBJECT");
      expect(config.responseSchema.properties.title.type).toBe("STRING");
      expect(config.responseSchema.properties.content.type).toBe("STRING");
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

  describe("no-op behavior when options or provider disabled", () => {
    it("is a no-op when options are missing or all false", async () => {
      const userSettings = makeSettings();
      const article = { name: "Title", content: "<p>Content</p>" };

      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      await applyAiOptions(article, {}, userSettings);
      await applyAiOptions(article, { ai_summarize: false }, userSettings);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(article.name).toBe("Title");
    });

    it("is a no-op with warning log when no active provider is selected", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const userSettings = makeSettings({ activeAiProvider: "" });
      const article = { name: "Title", content: "<p>Content</p>" };

      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      await applyAiOptions(article, { ai_summarize: true }, userSettings);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No active AI provider"));
      expect(article.name).toBe("Title");
    });
  });
});
