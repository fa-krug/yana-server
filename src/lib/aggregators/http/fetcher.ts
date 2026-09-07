import { noteRateLimited, parseRetryAfterMs, withHostLimit } from "./host-limiter";

export const USER_AGENT =
  "Mozilla/5.0 (compatible; YanaBot/1.0; +https://github.com/yourusername/yana)";
export const DEFAULT_RETRIES = 3;
export const MAX_FETCH_BYTES = 2 * 1024 * 1024;
export const MAX_HTML_BYTES = 8 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

export class NetworkError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public url?: string,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

export class ResponseTooLarge extends NetworkError {
  constructor(message: string, url?: string) {
    super(message, undefined, url);
    this.name = "ResponseTooLarge";
  }
}

export class DisallowedRedirect extends NetworkError {
  constructor(message: string, url?: string) {
    super(message, undefined, url);
    this.name = "DisallowedRedirect";
  }
}

function rejectOversizedDeclaration(response: Response, url: string, maxBytes: number): void {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared)) {
    const contentLength = parseInt(declared, 10);
    if (contentLength > maxBytes) {
      throw new ResponseTooLarge(
        `Response from ${url} is too large: ${contentLength} bytes > ${maxBytes}`,
        url,
      );
    }
  }
}

async function readCapped(response: Response, url: string, maxBytes: number): Promise<Uint8Array> {
  rejectOversizedDeclaration(response, url, maxBytes);

  if (!response.body) {
    return new Uint8Array(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // Ignore stream cancel error
          }
          throw new ResponseTooLarge(
            `Response from ${url} is too large: over ${maxBytes} bytes`,
            url,
          );
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    if (err instanceof ResponseTooLarge) {
      throw err;
    }
    throw err;
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function decodeText(body: Uint8Array, contentType: string | null): string {
  let charset: string | null = null;
  if (contentType) {
    const match = /charset=([^\s;]+)/i.exec(contentType);
    if (match) {
      charset = match[1].replace(/["']/g, "").trim().toLowerCase();
    }
  }

  const isoAliases = ["iso-8859-1", "latin-1", "latin1"];

  if (charset && !isoAliases.includes(charset)) {
    try {
      return new TextDecoder(charset).decode(body);
    } catch {
      // Fallback if charset unrecognized
    }
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("iso-8859-1").decode(body);
  }
}

type HtmlOutcome =
  | { ok: true; text: string }
  | { ok: false; status: number; statusText: string; retryAfterMs: number | null };

/**
 * One request/response exchange, headers through body. Kept separate from
 * `fetchHtml`'s retry loop so the whole exchange -- not just the headers --
 * can be run inside the host's throttle slot, while the retry *sleep* happens
 * outside it, where it belongs: a worker waiting out a backoff must not be
 * holding a slot the host would let a sibling use.
 */
async function fetchHtmlOnce(
  url: string,
  headers: Record<string, string>,
  timeout: number,
  maxBytes: number,
): Promise<HtmlOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });

    if (!response.ok) {
      // Discard the error body rather than leaving it undrained, which would
      // hold the socket open for the whole keep-alive idle timeout -- and
      // this path is now, by definition, the one a rate-limited host takes
      // most often.
      void response.body?.cancel().catch(() => {});
      return {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      };
    }

    const body = await readCapped(response, url, maxBytes);
    return { ok: true, text: decodeText(body, response.headers.get("content-type")) };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHtml(
  url: string,
  options?: {
    timeout?: number;
    retries?: number;
    maxBytes?: number;
    retryDelayMs?: number;
  },
): Promise<string> {
  const timeout = options?.timeout ?? 30000;
  const retries = Math.max(1, options?.retries ?? DEFAULT_RETRIES);
  const maxBytes = options?.maxBytes ?? MAX_HTML_BYTES;
  const baseDelay = options?.retryDelayMs ?? 1000;

  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
  };

  let lastException: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const outcome = await withHostLimit(url, () =>
        fetchHtmlOnce(url, headers, timeout, maxBytes),
      );

      if (outcome.ok) {
        return outcome.text;
      }

      // A 429 is a statement about the host, not about this request: record it
      // so every *other* in-flight worker for the same host waits it out too,
      // rather than each of them independently discovering the same refusal.
      if (outcome.status === 429) {
        noteRateLimited(url, outcome.retryAfterMs);
      }

      const isDeterministic =
        outcome.status >= 400 && outcome.status < 500 && outcome.status !== 429;
      const err = new NetworkError(
        `HTTP ${outcome.status} ${outcome.statusText} fetching ${url}`,
        outcome.status,
        url,
      );

      if (isDeterministic) {
        throw err;
      } else {
        lastException = err;
        if (attempt < retries - 1) {
          // Honour the host's own `Retry-After` when it is longer than our
          // backoff. Ignoring it is how a 1s/2s ladder keeps re-asking a host
          // that just said "not for another thirty seconds", turning a soft
          // throttle into a longer block.
          const waitTime = Math.max(Math.pow(2, attempt) * baseDelay, outcome.retryAfterMs ?? 0);
          if (waitTime > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitTime));
          }
          continue;
        }
        throw err;
      }
    } catch (err) {
      if (err instanceof ResponseTooLarge) {
        throw err;
      }
      if (
        err instanceof NetworkError &&
        err.statusCode &&
        err.statusCode >= 400 &&
        err.statusCode < 500 &&
        err.statusCode !== 429
      ) {
        throw err;
      }
      lastException = err instanceof Error ? err : new NetworkError(String(err), undefined, url);
      if (attempt < retries - 1) {
        const waitTime = Math.pow(2, attempt) * baseDelay;
        if (waitTime > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }
    }
  }

  if (lastException instanceof NetworkError || lastException instanceof ResponseTooLarge) {
    throw lastException;
  }
  throw new NetworkError(
    lastException?.message ?? `Failed to fetch ${url} after ${retries} retries`,
    undefined,
    url,
  );
}

export async function fetchBinary(
  url: string,
  options?: {
    timeout?: number;
    maxBytes?: number;
    isAllowedUrl?: (url: string) => boolean;
  },
): Promise<Buffer> {
  const timeout = options?.timeout ?? 30000;
  const maxBytes = options?.maxBytes ?? MAX_FETCH_BYTES;
  const isAllowedUrl = options?.isAllowedUrl;

  let target = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (isAllowedUrl && !isAllowedUrl(target)) {
      throw new DisallowedRedirect(`Refusing to fetch ${target}: not on allowed site`, target);
    }

    // Each hop is throttled against its own host, because a redirect chain can
    // cross hosts and the cap belongs to whichever one is being asked next.
    // The body read is inside the slot for the same reason it is in
    // `fetchHtmlOnce()`: a slot released at the response headers bounds the
    // number of open sockets at nothing.
    const hopUrl = target;
    const hopResult = await withHostLimit(
      hopUrl,
      async (): Promise<{ redirectTo: string } | { bytes: Uint8Array }> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        let response: Response;
        try {
          response = await fetch(hopUrl, {
            headers: { "User-Agent": USER_AGENT },
            signal: controller.signal,
            redirect: "manual",
          });
        } finally {
          clearTimeout(timer);
        }

        if (response.status === 429) {
          noteRateLimited(hopUrl, parseRetryAfterMs(response.headers.get("retry-after")));
        }

        const isRedirect = response.status >= 300 && response.status < 400;
        if (isRedirect) {
          void response.body?.cancel().catch(() => {});
          const location = response.headers.get("location");
          if (!location) {
            throw new NetworkError(
              `Redirect status ${response.status} without Location header`,
              response.status,
              hopUrl,
            );
          }
          return { redirectTo: new URL(location, hopUrl).toString() };
        }

        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new NetworkError(
            `HTTP ${response.status} ${response.statusText} fetching ${hopUrl}`,
            response.status,
            hopUrl,
          );
        }

        return { bytes: await readCapped(response, hopUrl, maxBytes) };
      },
    );

    if ("redirectTo" in hopResult) {
      target = hopResult.redirectTo;
      continue;
    }

    return Buffer.from(hopResult.bytes);
  }

  throw new NetworkError(`Too many redirects fetching ${url}`, undefined, url);
}
