import { afterEach, describe, expect, it, vi } from "vitest";

import { AI_PROVIDERS, providerByKey, type AiProvider } from "./providers";

afterEach(() => vi.restoreAllMocks());

describe("AI_PROVIDERS", () => {
  it("covers exactly the three supported providers", () => {
    // The direction record defers provider expansion as a separate concern --
    // the iOS client supports seven. A fourth entry here is a scope change, not
    // a tweak.
    expect(AI_PROVIDERS.map((provider) => provider.key)).toEqual(["openai", "anthropic", "gemini"]);
  });

  it("lists its default model among its models", () => {
    // A default absent from the list renders an empty select.
    for (const provider of AI_PROVIDERS) {
      expect(provider.models.map((model) => model.value)).toContain(provider.defaultModel);
    }
  });

  it("only offers a custom URL where the provider supports one", () => {
    expect(providerByKey("openai")?.hasCustomUrl).toBe(true);
    expect(providerByKey("anthropic")?.hasCustomUrl).toBe(false);
    expect(providerByKey("gemini")?.hasCustomUrl).toBe(false);
  });

  it("returns undefined for an unknown key", () => {
    expect(providerByKey("mistral")).toBeUndefined();
  });

  /**
   * **The stale defaults are the thing being fixed.**
   *
   * Phase 2 copied the Django-era model ids into `schema/users.ts` verbatim so
   * that refreshing them would be a visible, deliberate change. This asserts
   * they did not survive the copy into the registry; the column defaults
   * themselves are the actions task's migration.
   */
  it("carries none of the stale phase-2 model ids", () => {
    const stale = ["gpt-4o-mini", "claude-3-5-sonnet-20240620", "gemini-1.5-flash"];
    const offered = AI_PROVIDERS.flatMap((provider) => provider.models.map((m) => m.value));
    for (const id of stale) expect(offered).not.toContain(id);
  });

  it("offers a non-empty, duplicate-free model list per provider", () => {
    for (const provider of AI_PROVIDERS) {
      const values = provider.models.map((model) => model.value);
      expect(values.length).toBeGreaterThan(0);
      expect(new Set(values).size).toBe(values.length);
      for (const model of provider.models) expect(model.label.trim()).not.toBe("");
    }
  });

  /**
   * **Each provider's rate-limit answer is decided, not inherited.**
   *
   * `quotaMeansVerified` is what `judge()` in `@/lib/integrations/define` reads
   * to decide whether a 429 stores and enables the credential or writes nothing
   * at all. The three answers differ and the reasoning lives beside the field in
   * `providers.ts`; this pins them so a later edit that "aligns" them fails a
   * test rather than silently enabling an integration a provider never vouched
   * for.
   */
  it("decides quotaMeansVerified per provider", () => {
    // false: the base URL is an operator setting, so a gateway can shed load
    // before reading the Authorization header -- and `insufficient_quota`
    // shares the 429 status without healing overnight.
    expect(providerByKey("openai")?.quotaMeansVerified).toBe(false);
    // true: rate limits are resolved from the key, credit exhaustion is a 403
    // rather than a 429, and the endpoint is fixed.
    expect(providerByKey("anthropic")?.quotaMeansVerified).toBe(true);
    // true: quota is charged to the project the key resolves to, so the key is
    // validated first -- YouTube's stated reason, applied rather than copied.
    expect(providerByKey("gemini")?.quotaMeansVerified).toBe(true);
  });
});

/**
 * The credential shapes a probe has to survive, including the ones an operator
 * really can produce by pasting.
 */
const hostileCredentials = [
  { label: "empty everything", credentials: { apiKey: "", model: "", apiUrl: "" } },
  {
    label: "a key with a newline",
    credentials: { apiKey: "sk-SECRET123\n", model: "m", apiUrl: "https://h/v1" },
  },
  {
    label: "a key outside Latin-1",
    credentials: { apiKey: "sk-SECRET123-🔒", model: "m", apiUrl: "https://h/v1" },
  },
  {
    label: "a model id with path separators",
    credentials: { apiKey: "sk-SECRET123", model: "../../etc", apiUrl: "https://h/v1" },
  },
  {
    label: "a base URL that is not a URL",
    credentials: { apiKey: "sk-SECRET123", model: "m", apiUrl: "not a url" },
  },
  {
    label: "a non-http base URL",
    credentials: { apiKey: "sk-SECRET123", model: "m", apiUrl: "file:///etc/passwd" },
  },
];

/**
 * What can come back. Each is a factory rather than a value: a `Response` body
 * can only be read once, and these are reused across providers.
 */
const hostileAnswers: { label: string; answer: () => Response | Promise<never> }[] = [
  { label: "a 200 with an HTML block page", answer: () => new Response("<html>no</html>") },
  { label: "a 200 with an empty body", answer: () => new Response("", { status: 200 }) },
  { label: "a 200 with JSON null", answer: () => new Response("null", { status: 200 }) },
  {
    label: "a 401 echoing the key",
    answer: () =>
      new Response(JSON.stringify({ error: { message: "key sk-SECRET123 invalid" } }), {
        status: 401,
      }),
  },
  {
    label: "a 429 echoing the key",
    answer: () =>
      new Response(JSON.stringify({ error: { type: "sk-SECRET123" } }), { status: 429 }),
  },
  { label: "a 599 with no body", answer: () => new Response("", { status: 599 }) },
  { label: "a transport rejection", answer: () => Promise.reject(new TypeError("fetch failed")) },
  // Not everything thrown is an Error; `transportFailure` must still classify.
  { label: "a non-Error rejection", answer: () => Promise.reject("boom") },
];

function eachCase(): { provider: AiProvider; ci: number; ai: number }[] {
  return AI_PROVIDERS.flatMap((provider) =>
    hostileCredentials.flatMap((_c, ci) => hostileAnswers.map((_a, ai) => ({ provider, ci, ai }))),
  );
}

/**
 * The two properties `ProbeResult` is worth nothing without, checked across
 * every provider rather than argued per file.
 *
 * A probe that rejects escapes `judge()` entirely and reaches the caller as an
 * unhandled failure; a `detail` carrying a credential defeats the whole reason
 * the field is documented as log-only prose built from constants.
 */
describe("every AI probe", () => {
  it.each(eachCase())(
    "$provider.key resolves to a classified result for credentials #$ci and answer #$ai",
    async ({ provider, ci, ai }) => {
      const { credentials } = hostileCredentials[ci]!;
      const { answer } = hostileAnswers[ai]!;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() => answer()),
      );
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await provider.probe(credentials);

      expect(typeof result.detail).toBe("string");
      expect(result.detail).not.toBe("");
      if (result.ok) {
        expect(result.ok).toBe(true);
      } else {
        expect(["unauthorized", "quota", "network", "timeout", "unexpected"]).toContain(
          result.cause,
        );
      }
    },
  );

  it.each(eachCase())(
    "$provider.key keeps the submitted credential out of the result for #$ci / #$ai",
    async ({ provider, ci, ai }) => {
      const { credentials } = hostileCredentials[ci]!;
      const { answer } = hostileAnswers[ai]!;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() => answer()),
      );
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await provider.probe(credentials);

      // "SECRET123" is the distinguishing part of every non-empty key above,
      // and it is what several of the answers echo back.
      expect(JSON.stringify(result)).not.toContain("SECRET123");
    },
  );

  it("does not reach the network for any provider in this suite", async () => {
    // A guard on the guard: if a probe ever fell through to a real `fetch`,
    // these tests would hit three live APIs with a bogus key.
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const provider of AI_PROVIDERS) {
      await provider.probe({ apiKey: "k", model: "m" });
    }

    expect(fetchMock).toHaveBeenCalledTimes(AI_PROVIDERS.length);
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\//);
    }
  });
});
