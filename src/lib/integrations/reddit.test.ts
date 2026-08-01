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

  it("never rejects for a client secret containing a character above U+00FF", async () => {
    // btoa() alone throws InvalidCharacterError for any code unit above
    // U+00FF (an emoji, here) -- this pins that testRedditCredentials still
    // resolves to a classified ProbeResult rather than letting that escape.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ access_token: "t" }), { status: 200 })),
    );
    await expect(
      testRedditCredentials({ ...credentials, clientSecret: "secret-🔒-emoji" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("base64-encodes a non-ASCII Latin-1-range credential as UTF-8, not Latin-1", async () => {
    // "é" (U+00E9) is a code unit btoa() accepts on its own, but as one byte
    // (0xE9) rather than the two-byte UTF-8 sequence a server expects --
    // this pins the Authorization header against the UTF-8 base64 that
    // Buffer.from(s, "utf8").toString("base64") produces, not the Latin-1
    // one plain btoa() would produce.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ access_token: "t" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const nonAsciiCredentials = { ...credentials, clientSecret: "café-sécret" };
    await testRedditCredentials(nonAsciiCredentials);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const raw = `${nonAsciiCredentials.clientId}:${nonAsciiCredentials.clientSecret}`;
    const expectedUtf8Auth = `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
    const wrongLatin1Auth = `Basic ${btoa(raw)}`;
    expect(headers.Authorization).toBe(expectedUtf8Auth);
    expect(headers.Authorization).not.toBe(wrongLatin1Auth);
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
