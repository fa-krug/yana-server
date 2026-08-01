import { afterEach, describe, expect, it, vi } from "vitest";

import { PROBE_TIMEOUT_MS } from "@/lib/integrations/probe";

import { testAnthropicKey } from "./anthropic";

afterEach(() => vi.restoreAllMocks());

const credentials = { apiKey: "sk-ant-test", model: "claude-haiku-4-5" };

/** A real answer to `max_tokens: 1`: the envelope, and an empty content array. */
function truncatedMessage(): Response {
  return new Response(
    JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [] }),
    { status: 200 },
  );
}

function stubFetch(response: Response | Error) {
  const mock =
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("testAnthropicKey", () => {
  /**
   * **The empty `content` array is the point.**
   *
   * `max_tokens: 1` caps thinking and response text together, so a model with
   * adaptive thinking on answers 200 with `stop_reason: "max_tokens"` and no
   * content blocks. Requiring `content` would report every working key as
   * broken -- the mistake the YouTube probe's note warns about -- which is why the
   * check reads the envelope discriminant instead.
   */
  it("reports success on a 200 whose content array is empty", async () => {
    stubFetch(truncatedMessage());
    expect(await testAnthropicKey(credentials)).toMatchObject({ ok: true });
  });

  it.each([
    ["a JSON error with a 200 status", JSON.stringify({ type: "error", error: { type: "x" } })],
    ["a middlebox block page", "<html><body>Blocked by policy</body></html>"],
  ])("refuses a 200 that is not a message envelope: %s", async (_label, body) => {
    stubFetch(new Response(body, { status: 200 }));
    const result = await testAnthropicKey(credentials);
    expect(result).toMatchObject({ ok: false, cause: "unexpected" });
    // The detail stays a constant: nothing from that body is interpolated,
    // which is where an echoed credential would come from.
    expect(JSON.stringify(result)).not.toContain("Blocked by policy");
  });

  it("classifies a 401 as unauthorized", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { type: "authentication_error" } }), { status: 401 }),
    );
    expect(await testAnthropicKey(credentials)).toMatchObject({
      ok: false,
      cause: "unauthorized",
    });
  });

  it("classifies a permission 403 as unauthorized", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { type: "permission_error" } }), { status: 403 }),
    );
    expect(await testAnthropicKey(credentials)).toMatchObject({
      ok: false,
      cause: "unauthorized",
    });
  });

  /**
   * Credit exhaustion is a 403 `billing_error` here, not a 429 -- which is half
   * the reason this provider's `quotaMeansVerified` can be `true`. It stays in
   * the `unauthorized` arm (store the key, integration off, because it will not
   * work) and only the log line distinguishes it from a permission refusal.
   */
  it("names an exhausted balance in the detail, and still refuses", async () => {
    stubFetch(new Response(JSON.stringify({ error: { type: "billing_error" } }), { status: 403 }));
    const result = await testAnthropicKey(credentials);
    expect(result).toMatchObject({ ok: false, cause: "unauthorized" });
    expect(result.detail).toContain("credit");
  });

  it("classifies a 429 as quota", async () => {
    // `quotaMeansVerified` is true for this provider (see `providers.ts`):
    // Anthropic's rate limits are resolved from the key, and the endpoint is
    // fixed so nothing sheds load in front of the auth check.
    stubFetch(
      new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 }),
    );
    expect(await testAnthropicKey(credentials)).toMatchObject({ ok: false, cause: "quota" });
  });

  it.each([
    [404, "an unknown model"],
    [400, "a request shape the API refused"],
    [529, "a transient overload"],
  ])("classifies %i (%s) as unexpected, never unauthorized", async (status) => {
    stubFetch(new Response(JSON.stringify({ error: {} }), { status }));
    expect(await testAnthropicKey(credentials)).toMatchObject({ ok: false, cause: "unexpected" });
  });

  it("classifies an unrecognised status as unexpected", async () => {
    stubFetch(new Response("", { status: 418 }));
    expect(await testAnthropicKey(credentials)).toMatchObject({ ok: false, cause: "unexpected" });
  });

  it("posts a 1-token message to the fixed endpoint with the key in a header", async () => {
    const fetchMock = stubFetch(truncatedMessage());
    // A dropped signal is an unbounded hang in production behind a green suite.
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await testAnthropicKey(credentials);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(timeout).toHaveBeenCalledWith(PROBE_TIMEOUT_MS);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "claude-haiku-4-5",
      max_tokens: 1,
    });
  });

  it("never echoes the submitted key back in a failure result", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { message: "key SECRET123 is invalid" } }), {
        status: 401,
      }),
    );
    const result = await testAnthropicKey({ ...credentials, apiKey: "SECRET123" });
    expect(JSON.stringify(result)).not.toContain("SECRET123");
  });

  it("never rejects for an API key that cannot be a header value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Invalid header value")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      testAnthropicKey({ ...credentials, apiKey: "sk-ant-é\nbroken" }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("classifies a timeout as timeout", async () => {
    stubFetch(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await testAnthropicKey(credentials)).toMatchObject({ ok: false, cause: "timeout" });
  });

  it("classifies any other rejection as network, logging the platform's code", async () => {
    const failure = new TypeError("fetch failed");
    failure.cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3128"), {
      code: "ECONNREFUSED",
    });
    stubFetch(failure);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testAnthropicKey(credentials);

    expect(result).toMatchObject({ ok: false, cause: "network" });
    expect(warned).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });
});
