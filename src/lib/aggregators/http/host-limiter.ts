/**
 * A process-wide, per-hostname request throttle for every outbound fetch the
 * aggregators make.
 *
 * Nothing above this module bounds how hard one site is hit. `enrichArticles()`
 * runs `mapWithConcurrency(articles, feed.concurrency, ...)` -- `4` by default
 * -- and each of those workers makes several requests to the *same* host for
 * one article (the page, its header image, inline images, and for Heise the
 * forum page as well). `startWorker()` then runs `WORKER_CONCURRENCY` job loops
 * in this one process, so several feeds pointing at the same site aggregate
 * simultaneously: four Heise feeds at concurrency 4 is sixteen article workers
 * against `www.heise.de` at once. That is what earns a 429, and no amount of
 * retrying fixes a request rate the site is refusing.
 *
 * So the cap is keyed on the **hostname**, not on the feed: it is the only key
 * that matches what the remote is actually rate-limiting, and it is the only
 * one that still holds when two feeds, two jobs or two aggregators reach the
 * same host. It is a module-level singleton for the same reason -- per-instance
 * state would be per-feed state again.
 *
 * Two independent bounds, plus a third that only exists once a host complains:
 *
 * - **`maxConcurrent`** -- how many requests to one host may be in flight.
 * - **`minGapMs`** -- the minimum gap between two request *starts* on one host,
 *   which is what bounds the rate a slow-responding host sees. `maxConcurrent`
 *   alone does not: two slots turning over quickly is an unbounded rate.
 * - **`cooldownUntil`** -- set by `noteRateLimited()` when a 429 comes back,
 *   from the response's own `Retry-After` where it sent one. Every *other*
 *   request to that host waits it out too, which is the point: a 429 is a
 *   statement about the host, not about the one request that happened to draw
 *   it, and letting fifteen sibling workers keep hammering through it is how a
 *   soft throttle becomes a hard block.
 *
 * This module imports nothing.
 */

export interface HostLimits {
  /** Requests in flight per hostname. */
  maxConcurrent: number;
  /** Minimum milliseconds between two request starts on one hostname. */
  minGapMs: number;
  /** Cooldown applied on a 429 that carried no usable `Retry-After`. */
  defaultCooldownMs: number;
  /** Upper bound on any cooldown, however long `Retry-After` asked for. */
  maxCooldownMs: number;
}

export const DEFAULT_HOST_LIMITS: HostLimits = {
  maxConcurrent: 2,
  minGapMs: 500,
  defaultCooldownMs: 5_000,
  maxCooldownMs: 60_000,
};

let limits: HostLimits = { ...DEFAULT_HOST_LIMITS };

interface HostState {
  active: number;
  lastStart: number;
  cooldownUntil: number;
  waiting: Array<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

const hosts = new Map<string, HostState>();

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function stateFor(hostname: string): HostState {
  let state = hosts.get(hostname);
  if (!state) {
    state = { active: 0, lastStart: 0, cooldownUntil: 0, waiting: [], timer: null };
    hosts.set(hostname, state);
  }
  return state;
}

/**
 * Start as many waiting requests as both bounds currently allow, and schedule
 * another pass for the moment the next one becomes startable.
 *
 * The timer is `unref`ed so a pending gap can never hold the process open --
 * this runs inside a worker loop that is expected to be able to exit.
 */
function pump(state: HostState): void {
  if (state.timer !== null) return;
  if (state.waiting.length === 0) return;
  if (state.active >= limits.maxConcurrent) return;

  const now = Date.now();
  const earliest = Math.max(state.lastStart + limits.minGapMs, state.cooldownUntil);
  if (now < earliest) {
    state.timer = setTimeout(() => {
      state.timer = null;
      pump(state);
    }, earliest - now);
    state.timer.unref?.();
    return;
  }

  const start = state.waiting.shift()!;
  state.active += 1;
  state.lastStart = now;
  start();
  pump(state);
}

function release(state: HostState): void {
  state.active -= 1;
  pump(state);
}

/**
 * Run `fn` under this host's concurrency cap, minimum request gap and any
 * active cooldown.
 *
 * `fn` must cover the *whole* exchange -- the request and reading its body --
 * because a slot released at the response headers bounds nothing: the sockets
 * stay open and the next request starts immediately. A URL with no parseable
 * hostname runs unthrottled rather than being refused; this is a rate limiter,
 * not a validator, and the callers already have their own URL guards.
 */
export async function withHostLimit<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const hostname = hostnameOf(url);
  if (!hostname) return fn();

  const state = stateFor(hostname);
  await new Promise<void>((resolve) => {
    state.waiting.push(resolve);
    pump(state);
  });

  try {
    return await fn();
  } finally {
    release(state);
  }
}

/**
 * Parse a `Retry-After` header into milliseconds, accepting both forms RFC 9110
 * allows: delta-seconds, and an HTTP-date. Returns `null` for a missing,
 * unparseable or past value, which every caller reads as "the host named no
 * delay" rather than as "no delay".
 */
export function parseRetryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }

  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : null;
  }

  return null;
}

/**
 * Record that this host answered 429, holding every later request to it until
 * the cooldown expires. `retryAfterMs` is the host's own `Retry-After` where it
 * sent one; `null` falls back to `defaultCooldownMs`.
 *
 * The value is clamped to `maxCooldownMs` and only ever extends an existing
 * cooldown, never shortens one -- a second 429 arriving mid-cooldown must not
 * be able to shorten the wait the first one bought.
 */
export function noteRateLimited(url: string, retryAfterMs: number | null): void {
  const hostname = hostnameOf(url);
  if (!hostname) return;

  const requested = retryAfterMs ?? limits.defaultCooldownMs;
  const cooldown = Math.min(Math.max(requested, 0), limits.maxCooldownMs);
  const state = stateFor(hostname);
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + cooldown);
}

/** Milliseconds remaining on this host's cooldown, or `0` if it is not held. */
export function hostCooldownMs(url: string): number {
  const hostname = hostnameOf(url);
  if (!hostname) return 0;
  const state = hosts.get(hostname);
  if (!state) return 0;
  return Math.max(0, state.cooldownUntil - Date.now());
}

/**
 * TEST-ONLY: drop every host's queue state and replace the limits.
 *
 * The node project's setup file calls this with `minGapMs: 0` so the suite does
 * not pay a real half-second per mocked fetch; the limiter's own tests set the
 * values each case needs. Production never calls it.
 */
export function resetHostLimits(overrides?: Partial<HostLimits>): void {
  for (const state of hosts.values()) {
    if (state.timer !== null) clearTimeout(state.timer);
  }
  hosts.clear();
  limits = { ...DEFAULT_HOST_LIMITS, ...overrides };
}
