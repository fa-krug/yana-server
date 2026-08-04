import { afterEach, describe, expect, it, vi } from "vitest";

import { testQwenKey } from "./qwen";

afterEach(() => vi.restoreAllMocks());

const credentials = { apiKey: "qwen-test-key", model: "qwen3.5-flash" };

function stubFetch(response: Response | Error) {
  const mock =
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("testQwenKey", () => {
  it("reports success on a 200 with a non-empty choices array", async () => {
    stubFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
      }),
    );
    expect(await testQwenKey(credentials)).toMatchObject({ ok: true });
  });

  it("classifies a 401 as unauthorized", async () => {
    stubFetch(new Response(JSON.stringify({ error: { type: "auth" } }), { status: 401 }));
    expect(await testQwenKey(credentials)).toMatchObject({ ok: false, cause: "unauthorized" });
  });

  it("classifies a 429 as quota", async () => {
    stubFetch(new Response(JSON.stringify({ error: {} }), { status: 429 }));
    expect(await testQwenKey(credentials)).toMatchObject({ ok: false, cause: "quota" });
  });

  it("posts to the fixed Qwen endpoint with a Bearer header", async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
      }),
    );
    await testQwenKey(credentials);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer qwen-test-key");
  });

  it("never echoes the submitted key back in a failure result", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { message: "key SECRET123 is invalid" } }), {
        status: 401,
      }),
    );
    const result = await testQwenKey({ ...credentials, apiKey: "SECRET123" });
    expect(JSON.stringify(result)).not.toContain("SECRET123");
  });

  it("classifies a rejected fetch as network", async () => {
    const failure = new TypeError("fetch failed");
    failure.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    stubFetch(failure);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await testQwenKey(credentials)).toMatchObject({ ok: false, cause: "network" });
  });
});
