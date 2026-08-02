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
