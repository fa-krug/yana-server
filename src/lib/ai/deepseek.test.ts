import { afterEach, describe, expect, it, vi } from "vitest";

import { testDeepseekKey } from "./deepseek";

afterEach(() => vi.restoreAllMocks());

const credentials = { apiKey: "deepseek-test-key", model: "deepseek-v4-flash" };

function stubFetch(response: Response | Error) {
  const mock =
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("testDeepseekKey", () => {
  it("reports success on a 200 with a non-empty choices array", async () => {
    stubFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
      }),
    );
    expect(await testDeepseekKey(credentials)).toMatchObject({ ok: true });
  });

  it("classifies a 401 as unauthorized", async () => {
    stubFetch(new Response(JSON.stringify({ error: { type: "auth" } }), { status: 401 }));
    expect(await testDeepseekKey(credentials)).toMatchObject({ ok: false, cause: "unauthorized" });
  });

  it("classifies a 429 as quota", async () => {
    stubFetch(new Response(JSON.stringify({ error: {} }), { status: 429 }));
    expect(await testDeepseekKey(credentials)).toMatchObject({ ok: false, cause: "quota" });
  });

  it("posts to the fixed DeepSeek endpoint with a Bearer header", async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
      }),
    );
    await testDeepseekKey(credentials);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer deepseek-test-key");
  });

  it("never echoes the submitted key back in a failure result", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { message: "key SECRET123 is invalid" } }), {
        status: 401,
      }),
    );
    const result = await testDeepseekKey({ ...credentials, apiKey: "SECRET123" });
    expect(JSON.stringify(result)).not.toContain("SECRET123");
  });

  it("classifies a rejected fetch as network", async () => {
    const failure = new TypeError("fetch failed");
    failure.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    stubFetch(failure);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await testDeepseekKey(credentials)).toMatchObject({ ok: false, cause: "network" });
  });

  it("sends max_tokens, not max_completion_tokens", async () => {
    // DeepSeek does not document `max_completion_tokens` and rejects it,
    // which previously fell through openaiCompatibleChatProbe's status
    // classification into a generic "unexpected" verdict on every DeepSeek
    // test, regardless of the credential. `run.ts`'s real generation call
    // already uses `max_tokens` for this provider; the probe must agree.
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
      }),
    );
    await testDeepseekKey(credentials);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ max_tokens: 1 });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });
});
