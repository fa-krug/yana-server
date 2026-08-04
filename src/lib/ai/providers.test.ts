import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AI_PROVIDERS, providerByKey } from "./providers";

const ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * `providers.ts` says it imports nothing "and that is the point of it existing
 * separately from `./probes`". That was a comment; this is the tripwire, the
 * same one `src/lib/secrets.test.ts` and `src/lib/auth/roles.test.ts` carry --
 * and CLAUDE.md's standard for this rule is explicitly "pinned … not just
 * asserted in a comment".
 *
 * The rule is not tidiness. The whole of this module is rendered by the `/ai`
 * page's client components (task 3's provider tabs and model select), so
 * anything reachable from here is in the browser bundle. One import of
 * `./probes` would put three outbound `fetch` calls there, and one of a
 * feature's `queries` module would drag `better-sqlite3` in behind it -- the
 * latter as an opaque bundler error that names nothing.
 */
describe("the providers module's dependency contract", () => {
  it("imports nothing at all", () => {
    const source = fs
      .readFileSync(path.join(ROOT, "src/lib/ai/providers.ts"), "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const specifiers = [
      ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);

    expect(specifiers).toEqual([]);
  });
});

describe("AI_PROVIDERS", () => {
  it("covers exactly the six supported providers", () => {
    // Six providers, matching yana-ios's server-callable list. Apple
    // Intelligence is the iOS client's seventh provider but is on-device-only
    // with no network call, so it has no server-side equivalent and is
    // deliberately excluded here. A seventh *server* entry would be a scope
    // change, not a tweak.
    expect(AI_PROVIDERS.map((provider) => provider.key)).toEqual([
      "openai",
      "anthropic",
      "gemini",
      "mistral",
      "qwen",
      "deepseek",
    ]);
  });

  it("lists its default model among its models", () => {
    // A default absent from the list renders an empty select.
    for (const provider of AI_PROVIDERS) {
      expect(provider.models.map((model) => model.value)).toContain(provider.defaultModel);
    }
  });

  it("defaults to the cheapest entry, which is the first one", () => {
    // Each list is documented as cheapest-capable first and each default as its
    // head. Gemini's reads 3.5, 3.6, 3.5 because its version numbers do not
    // track tier, which is exactly the ordering a later reader would otherwise
    // "fix" into a wrong default.
    for (const provider of AI_PROVIDERS) {
      expect(provider.defaultModel).toBe(provider.models[0]?.value);
    }
  });

  it("only offers a custom URL where the provider supports one", () => {
    expect(providerByKey("openai")?.hasCustomUrl).toBe(true);
    expect(providerByKey("anthropic")?.hasCustomUrl).toBe(false);
    expect(providerByKey("gemini")?.hasCustomUrl).toBe(false);
  });

  it("returns undefined for an unknown key", () => {
    expect(providerByKey("unknown")).toBeUndefined();
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
   * at all. The six answers differ; the reasoning lives beside the field in
   * `providers.ts`, and -- for OpenAI, Anthropic and Gemini, whose probes
   * classify the 429 case themselves -- is deliberately duplicated at each
   * one's own 429 branch. Mistral, Qwen and DeepSeek route through the shared
   * `openaiCompatibleChatProbe()` in `@/lib/integrations/probe` instead, so
   * their reasoning lives only in `providers.ts`.
   * This pins the values, so an edit that "aligns" them fails a test rather than
   * silently enabling an integration a provider never vouched for.
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
    // true: api.mistral.ai is Mistral's own direct, fixed endpoint -- no
    // operator-configurable gateway in front of it -- so a 429 can only come
    // from Mistral itself having already accepted the key.
    expect(providerByKey("mistral")?.quotaMeansVerified).toBe(true);
    // true, but the least confident of the six: dashscope-intl.aliyuncs.com is
    // Alibaba Cloud's own DashScope endpoint, not a third-party proxy, so
    // Reddit's pre-auth load-shedding argument does not transfer here -- but
    // whether its edge evaluates the key before rate limiting is less publicly
    // documented than Anthropic's or Gemini's. This is the answer the
    // mandatory pre-release manual pass must verify live for Qwen.
    expect(providerByKey("qwen")?.quotaMeansVerified).toBe(true);
    // true: api.deepseek.com is DeepSeek's own direct, fixed endpoint --
    // independently the same argument as Mistral's, not inherited from it.
    expect(providerByKey("deepseek")?.quotaMeansVerified).toBe(true);
  });
});
