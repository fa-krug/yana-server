import { afterEach, describe, expect, it, vi } from "vitest";

import { AI_PROBES, type AiCredentials } from "./probes";
import { AI_PROVIDERS } from "./providers";

afterEach(() => vi.restoreAllMocks());

describe("AI_PROBES", () => {
  it("has one probe per declared provider, and no others", () => {
    // The `Record<AiProviderKey, AiProbe>` makes a *missing* key a typecheck
    // failure; this catches the other half -- a provider declared in
    // `AI_PROVIDERS` and a probe keyed under a name nothing renders.
    expect(Object.keys(AI_PROBES).sort()).toEqual(
      AI_PROVIDERS.map((provider) => provider.key).sort(),
    );
  });
});

/**
 * The credential shapes a probe has to survive, including the ones an operator
 * really can produce by pasting.
 *
 * **Every row carries `SECRET123`,** so the no-echo assertion below is never
 * vacuous -- a row with an empty key would pass it for free. The genuinely
 * empty case is covered on its own, further down. Base-URL shapes are *not*
 * varied here: only OpenAI can read `apiUrl`, so varying it would produce rows
 * that are byte-identical inputs for five of the six providers. `openai.test.ts`
 * owns that axis.
 */
const hostileCredentials: { label: string; credentials: AiCredentials }[] = [
  {
    label: "a key with a newline",
    credentials: { apiKey: "sk-SECRET123\n", model: "m", apiUrl: "https://gw.example.com/v1" },
  },
  {
    label: "a key outside Latin-1",
    credentials: { apiKey: "sk-SECRET123-🔒", model: "m", apiUrl: "https://gw.example.com/v1" },
  },
  {
    label: "a model id with path separators",
    credentials: {
      apiKey: "sk-SECRET123",
      model: "../../etc",
      apiUrl: "https://gw.example.com/v1",
    },
  },
];

/**
 * What can come back.
 *
 * Each is a factory rather than a value: a `Response` body can only be read
 * once, and these are reused across providers and cases.
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

const CAUSES = ["unauthorized", "quota", "network", "timeout", "unexpected"];

const matrix = AI_PROVIDERS.flatMap((provider) =>
  hostileCredentials.flatMap(({ label: credentialLabel, credentials }) =>
    hostileAnswers.map(({ label: answerLabel, answer }) => ({
      providerKey: provider.key,
      credentialLabel,
      answerLabel,
      credentials,
      answer,
    })),
  ),
);

/**
 * The two properties `ProbeResult` is worth nothing without, checked across
 * every provider rather than argued per file.
 *
 * A probe that rejects escapes `judge()` entirely and reaches the caller as an
 * unhandled failure; a `detail` carrying a credential defeats the whole reason
 * the field is documented as log-only prose built from constants. Both are
 * asserted in one pass, because the setup is identical and two matrices over
 * the same cross product is just the cross product twice.
 */
describe("every AI probe", () => {
  it.each(matrix)(
    "$providerKey resolves and stays quiet: $credentialLabel / $answerLabel",
    async ({ providerKey, credentials, answer }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() => answer()),
      );
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await AI_PROBES[providerKey](credentials);

      // Resolved, and to a member of the union rather than to anything.
      expect(typeof result.ok).toBe("boolean");
      if (!result.ok) expect(CAUSES).toContain(result.cause);
      expect(typeof result.detail).toBe("string");
      expect(result.detail).not.toBe("");
      // "SECRET123" is the distinguishing part of every key above, and several
      // of the answers echo it back.
      expect(JSON.stringify(result)).not.toContain("SECRET123");
    },
  );

  it.each(AI_PROVIDERS.map((provider) => provider.key))(
    "%s resolves for a wholly empty credential",
    async (providerKey) => {
      // Unreachable through `verify()` in `@/lib/integrations/define`, which
      // refuses an empty secret before any probe runs -- but the probe's
      // contract is per-input, not per-caller.
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() => new Response("", { status: 200 })),
      );
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await AI_PROBES[providerKey]({ apiKey: "", model: "", apiUrl: "" });

      expect(typeof result.ok).toBe("boolean");
      if (!result.ok) expect(CAUSES).toContain(result.cause);
    },
  );

  it("reaches only https endpoints, and never the real network", async () => {
    // A guard on the guard: if a probe ever fell through to a real `fetch`,
    // these tests would hit three live APIs with a bogus key. The factory shape
    // matters here too -- one shared `Response` would have its body consumed by
    // the first probe and reject on `bodyUsed` for the next.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const provider of AI_PROVIDERS) {
      await AI_PROBES[provider.key]({ apiKey: "k", model: "m" });
    }

    expect(fetchMock).toHaveBeenCalledTimes(AI_PROVIDERS.length);
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\//);
    }
  });
});
