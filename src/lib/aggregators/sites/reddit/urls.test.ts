import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeHtmlEntitiesInUrl, fetchSubredditInfo } from "./urls";

describe("fetchSubredditInfo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the authenticated oauth.reddit.com host and a Bearer header when given a token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { icon_img: "https://example.com/icon.png" } })),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchSubredditInfo("privatesubreddit", null, "the-token");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("https://oauth.reddit.com/");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer the-token");
  });

  it("falls back to the public host when no token is available", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { icon_img: "https://example.com/icon.png" } })),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchSubredditInfo("publicsubreddit", null, null);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("https://www.reddit.com/");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("decodeHtmlEntitiesInUrl", () => {
  it("decodes numeric decimal and hex entity refs, not just the five named ones", () => {
    expect(decodeHtmlEntitiesInUrl("https://x.test/a&#39;b")).toBe("https://x.test/a'b");
    expect(decodeHtmlEntitiesInUrl("https://x.test/a&#x27;b")).toBe("https://x.test/a'b");
    expect(decodeHtmlEntitiesInUrl("https://x.test/a&apos;b")).toBe("https://x.test/a'b");
    expect(decodeHtmlEntitiesInUrl("https://x.test/a&amp;b")).toBe("https://x.test/a&b");
  });
});
