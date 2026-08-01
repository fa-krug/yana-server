import { afterEach, describe, expect, it, vi } from "vitest";

import { OPENAI_DEFAULT_API_URL, testOpenaiKey } from "./openai";

afterEach(() => vi.restoreAllMocks());

const credentials = { apiKey: "sk-test", model: "gpt-5.6-luna" };

/** A body the probe accepts: a completion with at least one choice. */
function completion(): Response {
  return new Response(JSON.stringify({ id: "chatcmpl-1", choices: [{ index: 0 }] }), {
    status: 200,
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

describe("testOpenaiKey", () => {
  it("reports success on a 200 that carries a completion", async () => {
    stubFetch(completion());
    expect(await testOpenaiKey(credentials)).toMatchObject({ ok: true });
  });

  /**
   * **A 200 alone must not pass -- the asymmetry with the Gemini probe, pinned.**
   *
   * This is the one provider whose base URL is an operator setting, so what
   * answers a probe may be a gateway, a captive portal or a reverse proxy that
   * reports errors with a 200 status. `/chat/completions` has no empty-but-valid
   * success, so requiring `choices` costs nothing and stops an unverified
   * credential from switching the integration on. Gemini's probe deliberately
   * does the opposite (see its own test): `generateContent` has two
   * empty-but-valid 200s.
   */
  it.each([
    ["a JSON error with a 200 status", JSON.stringify({ error: { message: "nope" } })],
    ["an empty choices array", JSON.stringify({ choices: [] })],
    ["a gateway HTML page", "<html><body>502 Bad Gateway</body></html>"],
  ])("refuses a 200 that carries no completion: %s", async (_label, body) => {
    stubFetch(new Response(body, { status: 200 }));
    expect(await testOpenaiKey(credentials)).toMatchObject({ ok: false, cause: "unexpected" });
  });

  it("does not require choices[0].message.content, which a 1-token answer omits", async () => {
    // A reasoning model can spend the single token thinking and return an
    // empty string. Requiring the *content* rather than the array would report
    // every working key as broken.
    stubFetch(
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }), {
        status: 200,
      }),
    );
    expect(await testOpenaiKey(credentials)).toMatchObject({ ok: true });
  });

  it("classifies a 401 as unauthorized", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { type: "invalid_request_error" } }), { status: 401 }),
    );
    expect(await testOpenaiKey(credentials)).toMatchObject({
      ok: false,
      cause: "unauthorized",
    });
  });

  it("classifies a 403 as unauthorized", async () => {
    stubFetch(new Response(JSON.stringify({}), { status: 403 }));
    expect(await testOpenaiKey(credentials)).toMatchObject({ ok: false, cause: "unauthorized" });
  });

  it("classifies a plain rate limit as quota", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 }),
    );
    expect(await testOpenaiKey(credentials)).toMatchObject({ ok: false, cause: "quota" });
  });

  /**
   * **`insufficient_quota` shares the 429 status and is not a rate limit.**
   *
   * It means the account is out of credit, which does not heal overnight the
   * way YouTube's daily quota does. Reported as `quota` it would reach
   * `judge()`'s `unknown` arm and write *nothing*, so an operator whose only
   * fault is an unpaid bill could never save a key that is perfectly valid.
   * `unauthorized` stores the credential with the integration switched off,
   * which is the true state.
   */
  it("classifies insufficient_quota as unauthorized, not quota", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { type: "insufficient_quota" } }), { status: 429 }),
    );
    expect(await testOpenaiKey(credentials)).toMatchObject({
      ok: false,
      cause: "unauthorized",
    });
  });

  /**
   * A model this endpoint does not serve, and a request it does not understand,
   * are not verdicts about the credential -- so neither may store the key with
   * the integration switched off and tell the operator it was rejected.
   */
  it.each([
    [404, "an unknown model"],
    [400, "a request shape the endpoint refused"],
  ])("classifies %i (%s) as unexpected, never unauthorized", async (status) => {
    stubFetch(new Response(JSON.stringify({ error: {} }), { status }));
    expect(await testOpenaiKey(credentials)).toMatchObject({ ok: false, cause: "unexpected" });
  });

  it("classifies an unrecognised status as unexpected", async () => {
    stubFetch(new Response("", { status: 503 }));
    expect(await testOpenaiKey(credentials)).toMatchObject({ ok: false, cause: "unexpected" });
  });

  it("posts a 1-token completion to the default endpoint with a bearer token", async () => {
    const fetchMock = stubFetch(completion());

    await testOpenaiKey(credentials);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`${OPENAI_DEFAULT_API_URL}/chat/completions`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    // `max_completion_tokens`, not `max_tokens`: OpenAI documents the latter as
    // deprecated and incompatible with reasoning models, which the GPT-5.x
    // family are.
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "gpt-5.6-luna",
      max_completion_tokens: 1,
    });
  });

  it("uses the configured base URL, tolerating a trailing slash", async () => {
    const fetchMock = stubFetch(completion());

    await testOpenaiKey({ ...credentials, apiUrl: "https://gateway.example.com/v1/" });

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe("https://gateway.example.com/v1/chat/completions");
  });

  it("does not lose a path segment on the configured base URL", async () => {
    // `new URL("chat/completions", "https://host/v1")` would resolve to
    // `https://host/chat/completions` -- the `/v1` silently dropped, because it
    // is not a directory. String joining is what keeps the operator's path.
    const fetchMock = stubFetch(completion());

    await testOpenaiKey({ ...credentials, apiUrl: "https://gateway.example.com/openai/v1" });

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe("https://gateway.example.com/openai/v1/chat/completions");
  });

  it("refuses a base URL that is not http(s) without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await testOpenaiKey({ ...credentials, apiUrl: "file:///etc/passwd" })).toMatchObject({
      ok: false,
      cause: "unexpected",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never rejects for a base URL that is not a URL at all", async () => {
    // `new URL("not a url/chat/completions")` throws. The build happens inside
    // the try so this resolves to a classified result rather than escaping.
    stubFetch(completion());
    await expect(testOpenaiKey({ ...credentials, apiUrl: "not a url" })).resolves.toMatchObject({
      ok: false,
    });
  });

  it("never rejects for an API key that cannot be a header value", async () => {
    // A pasted key with a newline makes an illegal header value and `fetch`
    // rejects with a TypeError. Header construction happens inside the try for
    // exactly this reason.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Invalid header value")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      testOpenaiKey({ ...credentials, apiKey: "sk-broken\nkey" }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("classifies a timeout as timeout", async () => {
    // The shape AbortSignal.timeout() actually rejects with, so this exercises
    // the `error.name === "TimeoutError"` branch rather than a name attached
    // to an unrelated error.
    stubFetch(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await testOpenaiKey(credentials)).toMatchObject({ ok: false, cause: "timeout" });
  });

  it("classifies any other rejection as network, logging the platform's code", async () => {
    const failure = new TypeError("fetch failed");
    failure.cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.openai.com"), {
      code: "ENOTFOUND",
    });
    stubFetch(failure);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testOpenaiKey(credentials);

    expect(result).toMatchObject({ ok: false, cause: "network" });
    expect(warned).toHaveBeenCalledWith(expect.stringContaining("ENOTFOUND"));
    // The code is a diagnostic for the log and must not travel into the result,
    // and the message is never read at all -- on some paths it carries the URL.
    expect(JSON.stringify(result)).not.toContain("ENOTFOUND");
    expect(warned).not.toHaveBeenCalledWith(expect.stringContaining("getaddrinfo"));
  });
});
