/**
 * Stub for `next/server`, used by node-project tests that exercise a route
 * handler calling `connection()` directly.
 *
 * `connection()` is CLAUDE.md's documented way to opt a route out of static
 * prerendering (see the `connection()` bullet) -- required here because
 * `/device/pair/start` has no `requireUser()`/other Dynamic API call ahead of
 * its database write to opt it out some other way. In production it is a
 * no-op once a real request is being handled; its only effect is on the
 * *build*, refusing to let Next bake a static response. Called outside Next's
 * own request/render lifecycle -- which a bare `await GET()` in a test never
 * establishes -- it throws `Route ... used "connection" ... outside a request
 * scope`. That is framework request-scope plumbing no unit test can boot,
 * exactly like `next/headers`/`next/navigation` (see `./next-headers.ts` and
 * `./next-navigation.ts`), so it is stubbed the same way rather than worked
 * around in the route itself.
 *
 * Register it with:
 *
 * ```ts
 * vi.mock("next/server", () => import("@/test/next-server"));
 * ```
 */
export async function connection(): Promise<void> {}
