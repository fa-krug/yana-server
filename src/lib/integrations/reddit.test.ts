import { afterEach, describe, expect, it, vi } from "vitest";

import { testRedditCredentials } from "./reddit";

afterEach(() => vi.restoreAllMocks());

const credentials = {
  clientId: "client-id",
  clientSecret: "client-secret",
  userAgent: "yana/1.0 by u/example",
};

describe("testRedditCredentials", () => {
  it("classifies a 401 as unauthorized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 401 })),
    );
    const result = await testRedditCredentials(credentials);
    expect(result).toMatchObject({ ok: false, cause: "unauthorized" });
  });

  it("classifies a 429 as quota", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 429 })),
    );
    const result = await testRedditCredentials(credentials);
    expect(result).toMatchObject({ ok: false, cause: "quota" });
  });

  it("refuses an empty User-Agent without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await testRedditCredentials({ ...credentials, userAgent: "" });
    expect(result).toMatchObject({ ok: false, cause: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a whitespace-only User-Agent without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await testRedditCredentials({ ...credentials, userAgent: "   " });
    expect(result).toMatchObject({ ok: false, cause: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends HTTP Basic auth built from clientId:clientSecret and the configured User-Agent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ access_token: "t" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await testRedditCredentials(credentials);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.reddit.com/api/v1/access_token");
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(credentials.userAgent);
    const expectedAuth = `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`;
    expect(headers.Authorization).toBe(expectedAuth);
  });

  it("never echoes the client secret or client id in a failure result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: `bad ${credentials.clientSecret}` }), {
          status: 401,
        }),
      ),
    );
    const result = await testRedditCredentials(credentials);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(credentials.clientSecret);
    expect(serialized).not.toContain(credentials.clientId);
  });

  it("reports success on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ access_token: "t", scope: "read" }), { status: 200 }),
        ),
    );
    const result = await testRedditCredentials(credentials);
    expect(result.ok).toBe(true);
  });

  it("classifies a timeout as timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError")),
    );
    const result = await testRedditCredentials(credentials);
    expect(result).toMatchObject({ ok: false, cause: "timeout" });
  });

  it("classifies any other rejection as network", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
    const result = await testRedditCredentials(credentials);
    expect(result).toMatchObject({ ok: false, cause: "network" });
  });
});
