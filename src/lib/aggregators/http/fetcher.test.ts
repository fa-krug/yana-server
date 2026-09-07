import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RETRIES,
  DisallowedRedirect,
  fetchBinary,
  fetchHtml,
  MAX_FETCH_BYTES,
  MAX_HTML_BYTES,
  MAX_REDIRECTS,
  NetworkError,
  ResponseTooLarge,
  USER_AGENT,
} from "./fetcher";
import { hostCooldownMs, resetHostLimits } from "./host-limiter";
import { stallingBodyResponse } from "./test-support";

describe("http/fetcher constants & errors", () => {
  it("exports expected constants", () => {
    expect(USER_AGENT).toContain("YanaBot");
    expect(DEFAULT_RETRIES).toBe(3);
    expect(MAX_FETCH_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_HTML_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_REDIRECTS).toBe(5);
  });

  it("exports correct error inheritance hierarchy", () => {
    const netErr = new NetworkError("net fail", 500, "https://example.com");
    const tooLargeErr = new ResponseTooLarge("too large", "https://example.com");
    const disallowedErr = new DisallowedRedirect("disallowed", "https://example.com");

    expect(netErr).toBeInstanceOf(Error);
    expect(tooLargeErr).toBeInstanceOf(NetworkError);
    expect(tooLargeErr).toBeInstanceOf(Error);
    expect(disallowedErr).toBeInstanceOf(NetworkError);
    expect(disallowedErr).toBeInstanceOf(Error);

    expect(netErr.statusCode).toBe(500);
    expect(netErr.url).toBe("https://example.com");
  });
});

/** Resolves to "HUNG" if `promise` has not settled within `ms`. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<"settled" | "HUNG"> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<"HUNG">((resolve) => {
    timer = setTimeout(() => resolve("HUNG"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      hung,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("fetchHtml", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockStreamResponse(
    bodyBytes: Uint8Array,
    init?: { status?: number; statusText?: string; headers?: Record<string, string> },
  ) {
    const status = init?.status ?? 200;
    const statusText = init?.statusText ?? "OK";
    const headers = new Headers(init?.headers);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bodyBytes);
        controller.close();
      },
    });

    return new Response(stream, { status, statusText, headers });
  }

  // 7e: the timer used to be cleared the moment headers arrived, so
  // readCapped() drained the body with no deadline at all. A server that
  // sends headers and then stalls blocked the calling worker loop forever --
  // and the worker's budget timer only *requests* cooperative cancellation,
  // with no checkpoint inside a fetch, so four such feeds deadlock every
  // background job on the instance.
  it("aborts a body that stalls after the headers arrive", async () => {
    const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) =>
      Promise.resolve(stallingBodyResponse(init.signal)),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const call = fetchHtml("https://example.com/stall", {
      timeout: 50,
      retries: 1,
      retryDelayMs: 0,
    });

    expect(await settledWithin(call, 2000)).toBe("settled");
    await expect(call).rejects.toThrow(NetworkError);
  });

  it("fetches HTML content successfully on 200 OK", async () => {
    const htmlContent = "<html><body><h1>Hello World</h1></body></html>";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockStreamResponse(new TextEncoder().encode(htmlContent)));
    globalThis.fetch = fetchMock;

    const result = await fetchHtml("https://example.com/test");
    expect(result).toBe(htmlContent);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://example.com/test");
    expect(calledInit.headers["User-Agent"]).toBe(USER_AGENT);
  });

  it("retries transient 500 error with backoff and succeeds", async () => {
    const htmlContent = "<html>Success after retry</html>";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockStreamResponse(new TextEncoder().encode("Server Error"), { status: 500 }),
      )
      .mockResolvedValueOnce(
        mockStreamResponse(new TextEncoder().encode(htmlContent), { status: 200 }),
      );
    globalThis.fetch = fetchMock;

    const result = await fetchHtml("https://example.com/transient", {
      retries: 3,
      retryDelayMs: 0,
    });

    expect(result).toBe(htmlContent);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries transient network exception and succeeds", async () => {
    const htmlContent = "<html>Network restored</html>";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        mockStreamResponse(new TextEncoder().encode(htmlContent), { status: 200 }),
      );
    globalThis.fetch = fetchMock;

    const result = await fetchHtml("https://example.com/network-retry", {
      retries: 2,
      retryDelayMs: 0,
    });
    expect(result).toBe(htmlContent);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits out a 429's Retry-After rather than its own shorter backoff", async () => {
    const htmlContent = "<html>Allowed through</html>";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockStreamResponse(new TextEncoder().encode("Too Many Requests"), {
          status: 429,
          headers: { "retry-after": "1" },
        }),
      )
      .mockResolvedValueOnce(
        mockStreamResponse(new TextEncoder().encode(htmlContent), { status: 200 }),
      );
    globalThis.fetch = fetchMock;

    const started = Date.now();
    // `retryDelayMs: 0` is what the caller asked for, so anything longer than
    // an instant retry can only have come from the header. Ignoring it is how
    // a 1s/2s ladder keeps re-asking a host that just said "not yet".
    const result = await fetchHtml("https://ratelimited.example.com/a", {
      retries: 3,
      retryDelayMs: 0,
    });

    expect(result).toBe(htmlContent);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("puts the whole host on cooldown when one request draws a 429", async () => {
    resetHostLimits({ minGapMs: 0, maxCooldownMs: 60_000 });

    const fetchMock = vi.fn().mockResolvedValue(
      mockStreamResponse(new TextEncoder().encode("Too Many Requests"), {
        status: 429,
        headers: { "retry-after": "30" },
      }),
    );
    globalThis.fetch = fetchMock;

    await expect(
      fetchHtml("https://cooldown.example.com/a", { retries: 1, retryDelayMs: 0 }),
    ).rejects.toThrow(NetworkError);

    // A sibling worker's *different* URL on the same host is held too --
    // without this, fifteen article workers each rediscover the same refusal.
    expect(hostCooldownMs("https://cooldown.example.com/b")).toBeGreaterThan(25_000);
  });

  it("does not retry deterministic 404 error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockStreamResponse(new TextEncoder().encode("Not Found"), { status: 404 }),
      );
    globalThis.fetch = fetchMock;

    await expect(fetchHtml("https://example.com/404", { retries: 3 })).rejects.toThrow(
      NetworkError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry deterministic ResponseTooLarge error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockStreamResponse(new TextEncoder().encode("Oversized content"), {
        headers: { "content-length": "99999999" },
      }),
    );
    globalThis.fetch = fetchMock;

    await expect(
      fetchHtml("https://example.com/large", { retries: 3, maxBytes: 100 }),
    ).rejects.toThrow(ResponseTooLarge);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized Content-Length before reading body", async () => {
    const cancelSpy = vi.fn();
    const stream = new ReadableStream({
      start() {},
      cancel: cancelSpy,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, {
        headers: { "content-length": "200" },
      }),
    );
    globalThis.fetch = fetchMock;

    await expect(
      fetchHtml("https://example.com/content-length", { maxBytes: 100 }),
    ).rejects.toThrow(ResponseTooLarge);
  });

  it("aborts mid-stream when body exceeds maxBytes", async () => {
    const chunk1 = new Uint8Array(60).fill(65); // 'A'
    const chunk2 = new Uint8Array(60).fill(66); // 'B' (total 120 > 100)

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response(stream));
    globalThis.fetch = fetchMock;

    await expect(fetchHtml("https://example.com/stream-large", { maxBytes: 100 })).rejects.toThrow(
      ResponseTooLarge,
    );
  });

  it("handles ISO-8859-1 decoding fallback for non-UTF8 bytes", async () => {
    // Single byte 0xE4 in ISO-8859-1 is 'ä'
    const iso8859Bytes = new Uint8Array([0x66, 0xe4, 0x68, 0x72, 0x65, 0x6e]); // "fähren"
    const fetchMock = vi.fn().mockResolvedValue(
      mockStreamResponse(iso8859Bytes, {
        headers: { "content-type": "text/html; charset=iso-8859-1" },
      }),
    );
    globalThis.fetch = fetchMock;

    const result = await fetchHtml("https://example.com/iso");
    expect(result).toBe("fähren");
  });
});

describe("fetchBinary", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockStreamResponse(
    bodyBytes: Uint8Array,
    init?: { status?: number; statusText?: string; headers?: Record<string, string> },
  ) {
    const status = init?.status ?? 200;
    const statusText = init?.statusText ?? "OK";
    const headers = new Headers(init?.headers);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bodyBytes);
        controller.close();
      },
    });

    return new Response(stream, { status, statusText, headers });
  }

  // 7e, the same defect in the other fetcher.
  it("aborts a body that stalls after the headers arrive", async () => {
    const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) =>
      Promise.resolve(stallingBodyResponse(init.signal)),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const call = fetchBinary("https://example.com/stall.png", { timeout: 50 });

    expect(await settledWithin(call, 2000)).toBe("settled");
    await expect(call).rejects.toThrow();
  });

  // 7e: one deadline for the whole call, not one per redirect hop. A fresh
  // timer per hop made the real worst case MAX_REDIRECTS + 1 times the
  // configured timeout.
  //
  // **This used to assert that every hop saw the identical `AbortSignal`, and
  // that is deliberately no longer true.** Each hop now runs inside its own
  // `withHostLimit()` slot -- a redirect chain can cross hosts, and the cap
  // belongs to whichever host is being asked next -- and a signal armed
  // before that queue wait would be spent on politeness rather than on the
  // request, up to `maxCooldownMs` of it, then abort a request that was never
  // sent. So the signal is per hop and the *budget* is shared: `fetchBinary()`
  // deadlines each hop with what is left and deducts only time spent in
  // flight. Signal identity was a proxy for the ceiling; this asserts the
  // ceiling itself, which is what 7e was actually about.
  it("spends one shared timeout across every redirect hop, not one per hop", async () => {
    const HOP_MS = 120;
    const signals: AbortSignal[] = [];
    let hops = 0;

    const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      signals.push(init.signal);
      hops++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve(
              hops <= 3
                ? new Response(null, {
                    status: 302,
                    headers: { location: "https://example.com/next" },
                  })
                : mockStreamResponse(new Uint8Array([1, 2, 3])),
            ),
          HOP_MS,
        );
        init.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Two hops' worth of in-flight time, against a four-hop chain. Per-hop
    // timers would let all four through and resolve; one shared budget runs
    // out partway.
    await expect(
      fetchBinary("https://example.com/start.png", { timeout: HOP_MS * 2 }),
    ).rejects.toThrow();

    expect(hops).toBeLessThan(4);
    // Per hop, for the throttling reason above -- stated so a future reader
    // does not "restore" a single hoisted signal and reintroduce the abort of
    // a request that was never sent.
    expect(signals[1]).not.toBe(signals[0]);
  });

  it("fetches binary Buffer successfully", async () => {
    const rawData = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchMock = vi.fn().mockResolvedValue(mockStreamResponse(rawData));
    globalThis.fetch = fetchMock;

    const result = await fetchBinary("https://example.com/image.png");
    expect(result).toBeInstanceOf(Buffer);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
  });

  it("respects isAllowedUrl and throws DisallowedRedirect before fetch", async () => {
    const isAllowedUrl = vi.fn((url: string) => url.startsWith("https://allowed.com"));
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    await expect(fetchBinary("https://blocked.com/favicon.ico", { isAllowedUrl })).rejects.toThrow(
      DisallowedRedirect,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(isAllowedUrl).toHaveBeenCalledWith("https://blocked.com/favicon.ico");
  });

  it("manually follows redirects up to MAX_REDIRECTS and checks isAllowedUrl per hop", async () => {
    const isAllowedUrl = vi.fn((url: string) => !url.includes("evil.com"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com/redirect2" },
        }),
      )
      .mockResolvedValueOnce(mockStreamResponse(new Uint8Array([10, 20]), { status: 200 }));
    globalThis.fetch = fetchMock;

    const result = await fetchBinary("https://example.com/redirect1", { isAllowedUrl });
    expect(Array.from(result)).toEqual([10, 20]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/redirect1");
    expect(fetchMock.mock.calls[1][0]).toBe("https://example.com/redirect2");
  });

  it("throws DisallowedRedirect if redirect target fails isAllowedUrl", async () => {
    const isAllowedUrl = vi.fn((url: string) => !url.includes("evil.com"));
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { location: "https://evil.com/malware" },
      }),
    );
    globalThis.fetch = fetchMock;

    await expect(fetchBinary("https://example.com/redirect1", { isAllowedUrl })).rejects.toThrow(
      DisallowedRedirect,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isAllowedUrl).toHaveBeenCalledWith("https://evil.com/malware");
  });

  it("enforces MAX_REDIRECTS limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/loop" },
      }),
    );
    globalThis.fetch = fetchMock;

    await expect(fetchBinary("https://example.com/loop")).rejects.toThrow(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });
});
