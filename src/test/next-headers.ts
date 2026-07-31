/**
 * Stub for `next/headers`, used by the node-project tests.
 *
 * A *request-scope* stub, not a data mock: it stands in for framework plumbing
 * no unit test can boot. The database underneath stays real -- see CLAUDE.md's
 * testing convention, and `src/test/next-navigation.ts`, which is the same idea
 * for the router.
 *
 * **`cookies` is not optional here, and that is the whole reason this file
 * exists.** `vitest.config.ts` inlines Better Auth's `nextCookies()` plugin so
 * that a test can observe the cookies a server action writes; the plugin's
 * `after` hook then runs `await import("next/headers.js")` against *this* stub
 * after any endpoint that sets a cookie. A stub exporting only `headers` makes
 * `cookies` `undefined`, and the resulting `TypeError` is one the plugin does
 * not catch -- it rethrows, and every session-backed test in the file fails at
 * once. Loud, but only if every stub is built from here rather than typed out
 * again per file.
 *
 * Register it with the hoisted box the file already keeps for its headers:
 *
 * ```ts
 * const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
 * vi.mock("next/headers", async () =>
 *   (await import("@/test/next-headers")).nextHeadersStub(requestHeaders),
 * );
 * ```
 *
 * A box rather than a plain value because `vi.resetModules()` in `beforeEach`
 * would re-instantiate anything the factory imported directly.
 */

/** The mutable holder a test file swaps its request headers through. */
export type HeadersBox = { current: Headers };

/**
 * A `next/headers` module: `headers()` reads the box, `cookies()` reads and
 * writes `jar`.
 *
 * Pass a `jar` only when the test asserts on what was written to it -- see
 * `src/lib/account/account.test.ts`, which is the one place that does, for the
 * session cookie a password change mints. Everywhere else the default jar is a
 * throwaway that exists so the plugin has something to call.
 */
export function nextHeadersStub(headersBox: HeadersBox, jar: Map<string, string> = new Map()) {
  return {
    headers: () => Promise.resolve(headersBox.current),
    cookies: () =>
      Promise.resolve({
        set: (name: string, value: string) => jar.set(name, value),
        get: (name: string) =>
          jar.has(name) ? { name, value: jar.get(name) as string } : undefined,
        delete: (name: string) => jar.delete(name),
      }),
  };
}
