/**
 * Stub for `next/navigation`, used by the component tests.
 *
 * This is a *router* stub, not a data mock: it stands in for framework URL
 * plumbing that no unit test can boot, and it is explicitly outside the
 * no-driver-mocks convention, which is about the database (see CLAUDE.md).
 * Messages are never stubbed -- tests render the real catalogs, so a broken
 * catalog cannot pass.
 *
 * Register it at the top of a test file, then set the URL per test:
 *
 * ```ts
 * vi.mock("next/navigation", () => import("@/test/next-navigation"));
 * setPathname("/feeds/42");
 * ```
 *
 * The value is module state, and vitest gives each test *file* its own module
 * registry, so it leaks between tests in one file but never across files. Set
 * it in every test that depends on it rather than relying on the default.
 */
let pathname = "/";

/** The pathname `usePathname()` will return from here on. */
export function setPathname(next: string) {
  pathname = next;
}

export function usePathname() {
  return pathname;
}
