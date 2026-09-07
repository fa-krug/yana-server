/**
 * One throttled request for a small text/JSON response, with a 429 retry.
 *
 * `fetchHtml()` and `fetchImageOutcome()` have their own loops because they
 * carry byte caps, charset decoding and image validation. Everything else that
 * reaches an external host from the aggregators is a small JSON API call --
 * Reddit's listings, comments and token endpoint; Bluesky's DID resolve and
 * post thread; the two Twitter mirrors -- and each of those had hand-rolled
 * the same block: build an abort signal, fetch, check `res.ok`, collapse
 * everything else to `null`. None of them was throttled, and none of them
 * distinguished a 429 from a DNS failure, which meant a rate-limited Reddit
 * shipped articles with silently empty comment sections.
 *
 * Two things this fixes that are easy to get wrong by hand:
 *
 * - **The abort signal is built inside the throttle slot, per attempt.** A
 *   caller-supplied `AbortSignal.timeout(10_000)` starts counting when it is
 *   *created*, so any time spent queued behind the host's concurrency cap or a
 *   `Retry-After` cooldown -- up to `maxCooldownMs`, 60s -- is spent against
 *   the request's own budget. With a cooldown active, a 10s signal is already
 *   aborted before the request is ever sent, which reads as a timeout against
 *   a host that was merely being waited for politely. So this takes
 *   `timeoutMs`, never a signal.
 * - **The body is read inside the slot.** Releasing at the response headers
 *   bounds the number of open sockets at nothing.
 *
 * The body comes back as text rather than parsed, because the callers disagree
 * about what to do with it (`JSON.parse`, cheerio, or nothing) and a helper
 * that parsed would have to invent an error for a body that is not JSON --
 * which is a real Reddit answer, not an edge case: its edge serves HTML block
 * pages with a 200.
 */

import { noteRateLimited, parseRetryAfterMs, withHostLimit } from "./host-limiter";

export const DEFAULT_TEXT_TIMEOUT_MS = 10_000;

/**
 * Attempts a request gets when the host answers 429. Matches
 * `RATE_LIMIT_ATTEMPTS` in `../images/fetcher` deliberately: same reasoning,
 * and two different numbers for "how many times do we re-ask a throttled
 * host" would be a difference nobody chose.
 */
export const RATE_LIMIT_ATTEMPTS = 3;

export interface ThrottledTextResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** The whole body, already read. Empty string when there was none. */
  body: string;
}

export interface ThrottledFetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  redirect?: RequestRedirect;
  timeoutMs?: number;
  /** Total attempts on a 429. `1` disables the retry. */
  attempts?: number;
}

/**
 * Returns the response (headers and body, already read), or `null` when the
 * request never produced one at all -- network, DNS, timeout, abort -- which
 * every caller here already treats as a transient failure. A 429 that survives
 * every attempt comes back as a response with `status === 429`, not as `null`,
 * so a caller can tell "the host refused me" from "the host never answered".
 */
export async function fetchTextThrottled(
  url: string,
  options?: ThrottledFetchOptions,
): Promise<ThrottledTextResponse | null> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TEXT_TIMEOUT_MS;
  const attempts = Math.max(1, options?.attempts ?? RATE_LIMIT_ATTEMPTS);

  let last: ThrottledTextResponse | null = null;

  // No sleep between attempts, deliberately: `noteRateLimited()` has already
  // pushed the host's cooldown out and `withHostLimit()` on the next attempt
  // waits it out, so sleeping here too would double the delay.
  for (let attempt = 0; attempt < attempts; attempt++) {
    let outcome: ThrottledTextResponse | null;
    try {
      outcome = await withHostLimit(url, async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, {
            method: options?.method,
            headers: options?.headers,
            body: options?.body,
            redirect: options?.redirect,
            signal: controller.signal,
          });
          return {
            status: response.status,
            ok: response.ok,
            headers: response.headers,
            body: await response.text(),
          };
        } finally {
          clearTimeout(timer);
        }
      });
    } catch {
      return null;
    }

    last = outcome;
    if (outcome.status !== 429) return outcome;

    noteRateLimited(url, parseRetryAfterMs(outcome.headers.get("retry-after")));
  }

  return last;
}

/**
 * `fetchTextThrottled()` plus `JSON.parse`, for the callers whose endpoint
 * always answers JSON when it answers at all.
 *
 * `null` covers every failure the caller cannot act on differently: no
 * response, a non-2xx status, or a body that would not parse. Callers that
 * need to branch on the status (Reddit's 401/403/404, which mean distinct
 * things to an operator) must use `fetchTextThrottled()` and parse themselves.
 */
export async function fetchJsonThrottled<T>(
  url: string,
  options?: ThrottledFetchOptions,
): Promise<T | null> {
  const response = await fetchTextThrottled(url, options);
  if (!response || !response.ok) return null;

  try {
    return JSON.parse(response.body) as T;
  } catch {
    return null;
  }
}
