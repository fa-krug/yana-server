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
      // The deadline covers the *body*, not just the headers. Cleared below
      // the readCapped() call rather than as soon as fetch() resolves: a
      // server that sends headers and then stalls used to hold this call
      // open forever, because the only thing that could interrupt the drain
      // was this signal and it had already been disarmed. That is a worker
      // loop hung with no way back -- worker.ts's budget timer only requests
      // cooperative cancellation and has no checkpoint inside a fetch, so
      // WORKER_CONCURRENCY such feeds deadlock every background job. undici
      // wires the signal to the body stream, so aborting mid-drain rejects
      // the reader.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          headers,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new NetworkError(
            `HTTP ${response.status} ${response.statusText} fetching ${url}`,
            response.status,
            url,
          );
        }

        const body = await readCapped(response, url, maxBytes);
        const contentType = response.headers.get("content-type");
        return decodeText(body, contentType);
      } finally {
        clearTimeout(timer);
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

  // One deadline for the whole call -- every redirect hop and the final body
  // drain share it. Two separate defects were fixed by hoisting it out of the
  // loop and clearing it below readCapped(): a fresh timer per hop made the
  // real ceiling (MAX_REDIRECTS + 1) x `timeout`, and clearing it as soon as
  // the headers arrived left the body drain with no deadline at all, so a
  // server that stalled after its headers hung the calling worker loop
  // forever. See the same pair in fetchHtml() above.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (isAllowedUrl && !isAllowedUrl(target)) {
        throw new DisallowedRedirect(`Refusing to fetch ${target}: not on allowed site`, target);
      }

      const response = await fetch(target, {
        headers: { "User-Agent": USER_AGENT },
        signal: controller.signal,
        redirect: "manual",
      });

      const isRedirect = response.status >= 300 && response.status < 400;
      if (isRedirect) {
        const location = response.headers.get("location");
        if (!location) {
          throw new NetworkError(
            `Redirect status ${response.status} without Location header`,
            response.status,
            target,
          );
        }
        target = new URL(location, target).toString();
        continue;
      }

      if (!response.ok) {
        throw new NetworkError(
          `HTTP ${response.status} ${response.statusText} fetching ${target}`,
          response.status,
          target,
        );
      }

      const bytes = await readCapped(response, target, maxBytes);
      return Buffer.from(bytes);
    }

    throw new NetworkError(`Too many redirects fetching ${url}`, undefined, url);
  } finally {
    clearTimeout(timer);
  }
}
