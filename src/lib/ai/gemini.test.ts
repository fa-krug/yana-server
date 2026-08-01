import { afterEach, describe, expect, it, vi } from "vitest";

import { testGeminiKey } from "./gemini";

afterEach(() => vi.restoreAllMocks());

const credentials = { apiKey: "AIza-test", model: "gemini-3.5-flash-lite" };

/** The `400 INVALID_ARGUMENT` envelope Google returns for a rejected API key. */
function invalidKeyBody() {
  return JSON.stringify({
    error: {
      code: 400,
      status: "INVALID_ARGUMENT",
      message: "API key not valid. Please pass a valid API key.",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
    },
  });
}

function stubFetch(response: Response | Error) {
  const mock =
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("testGeminiKey", () => {
  /**
   * **The asymmetry with the OpenAI probe, pinned.**
   *
   * `generateContent` has two legitimate empty-but-valid 200s and this probe
   * must accept both: a single-token budget spent on thinking returns a
   * candidate with no parts, and a project with strict safety settings can
   * answer with `promptFeedback` and no candidates at all. Requiring a field
   * would report a working key as broken. OpenAI's probe deliberately does the
   * opposite -- its endpoint is an operator setting and has no such answer.
   */
  it.each([
    [
      "a normal candidate",
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "h" }] } }] }),
    ],
    [
      "a MAX_TOKENS candidate with no parts",
      JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
    ],
    ["no candidates at all", JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })],
  ])("reports success on any 200: %s", async (_label, body) => {
    stubFetch(new Response(body, { status: 200 }));
    expect(await testGeminiKey(credentials)).toMatchObject({ ok: true });
  });

  /**
   * **Google puts a rejected API key on a 400, alongside our own mistakes.**
   *
   * `API_KEY_INVALID` and a malformed `generationConfig` both arrive as
   * `400 INVALID_ARGUMENT`; only the `google.rpc.ErrorInfo` reason separates
   * them. Without that read, a bug in this file's request body would be
   * reported to the operator as a rejected key -- and, under the
   * write-on-rejection rule, would store the credential and switch the
   * integration off over something that was never their fault.
   */
  it("classifies a 400 carrying API_KEY_INVALID as unauthorized", async () => {
    stubFetch(new Response(invalidKeyBody(), { status: 400 }));
    expect(await testGeminiKey(credentials)).toMatchObject({
      ok: false,
      cause: "unauthorized",
    });
  });

  it("classifies a 400 without that reason as unexpected, not unauthorized", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            details: [{ reason: "FIELD_VIOLATION" }],
          },
        }),
        { status: 400 },
      ),
    );
    expect(await testGeminiKey(credentials)).toMatchObject({ ok: false, cause: "unexpected" });
  });

  it("does not throw when the error details are not an array", async () => {
    // A mangling intermediary can produce any shape. Reaching into it with
    // `.some()` unguarded would throw inside the try and be misreported as a
    // network failure.
    stubFetch(new Response(JSON.stringify({ error: { details: "nope" } }), { status: 400 }));
    expect(await testGeminiKey(credentials)).toMatchObject({ ok: false, cause: "unexpected" });
  });

  it("classifies a 403 as unauthorized", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED" } }), { status: 403 }),
    );
    expect(await testGeminiKey(credentials)).toMatchObject({
      ok: false,
      cause: "unauthorized",
    });
  });

  it("classifies a 429 as quota", async () => {
    // `quotaMeansVerified` is true for this provider (see `providers.ts`), for
    // YouTube's stated reason: quota is charged to the project the key resolves
    // to, so the key is validated first.
    stubFetch(
      new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), { status: 429 }),
    );
    expect(await testGeminiKey(credentials)).toMatchObject({ ok: false, cause: "quota" });
  });

  it.each([
    [404, "an unknown model or API version"],
    [500, "a server fault"],
  ])("classifies %i (%s) as unexpected", async (status) => {
    stubFetch(new Response(JSON.stringify({ error: {} }), { status }));
    expect(await testGeminiKey(credentials)).toMatchObject({ ok: false, cause: "unexpected" });
  });

  it("puts the key in a header, never in the query string", async () => {
    // A URL carrying the secret ends up in a `fetch` failure message, which is
    // why `logUnreachable()` reads only `.code`. Using the header form removes
    // the hazard rather than working around it.
    const fetchMock = stubFetch(new Response(JSON.stringify({ candidates: [] }), { status: 200 }));

    await testGeminiKey(credentials);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
    expect(url).not.toContain("AIza-test");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-test");
    expect(JSON.parse(String(init.body))).toMatchObject({
      generationConfig: { maxOutputTokens: 1 },
    });
  });

  it("encodes a model id that would otherwise change the path", async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({}), { status: 200 }));

    await testGeminiKey({ ...credentials, model: "../../v1beta/models/other" });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
        "..%2F..%2Fv1beta%2Fmodels%2Fother:generateContent",
    );
  });

  it("never echoes the submitted key back in a failure result", async () => {
    stubFetch(new Response(invalidKeyBody(), { status: 400 }));
    const result = await testGeminiKey({ ...credentials, apiKey: "AIzaSECRET123" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("AIzaSECRET123");
    // Nor the provider's own prose, which is where an echoed key would ride.
    expect(serialized).not.toContain("Please pass a valid API key");
  });

  it("never rejects for an API key that cannot be a header value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Invalid header value")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(testGeminiKey({ ...credentials, apiKey: "AIza\nbroken" })).resolves.toMatchObject({
      ok: false,
    });
  });

  it("classifies a timeout as timeout", async () => {
    stubFetch(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await testGeminiKey(credentials)).toMatchObject({ ok: false, cause: "timeout" });
  });

  it("classifies any other rejection as network, logging the platform's code", async () => {
    const failure = new TypeError("fetch failed");
    failure.cause = Object.assign(
      new Error("getaddrinfo ENOTFOUND generativelanguage.googleapis.com"),
      {
        code: "ENOTFOUND",
      },
    );
    stubFetch(failure);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testGeminiKey(credentials);

    expect(result).toMatchObject({ ok: false, cause: "network" });
    expect(warned).toHaveBeenCalledWith(expect.stringContaining("ENOTFOUND"));
    expect(JSON.stringify(result)).not.toContain("ENOTFOUND");
  });
});
