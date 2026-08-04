import { afterEach, describe, expect, it, vi } from "vitest";
import { getRedditAccessToken } from "./auth";

function basicAuthFor(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

describe("getRedditAccessToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not serve one credential pair's cached token to a different pair", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const token = headers.Authorization === basicAuthFor("client-a", "secret-a")
        ? "token-a"
        : "token-b";
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: token, expires_in: 3600 })),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokenA = await getRedditAccessToken("client-a", "secret-a");
    const tokenB = await getRedditAccessToken("client-b", "secret-b");

    expect(tokenA).toBe("token-a");
    expect(tokenB).toBe("token-b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses a cached token for the same credentials without a second fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "token-c", expires_in: 3600 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await getRedditAccessToken("client-c", "secret-c");
    const second = await getRedditAccessToken("client-c", "secret-c");

    expect(first).toBe("token-c");
    expect(second).toBe("token-c");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
