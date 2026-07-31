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

/**
 * Every navigation the component under test asked for, in order.
 *
 * Recorded rather than performed: jsdom has no router to perform them with, and
 * *which* navigation was requested is the assertion -- "signing in lands the
 * user on `next`" is the whole point of the `?next=` plumbing, and the only way
 * to see it from a unit test is to watch the call.
 *
 * `push` and `replace` are kept distinct because they are not interchangeable
 * here: /login must be *replaced*, or the back button returns a signed-in user
 * to a sign-in form.
 */
export type NavigationCall = { method: "push" | "replace" | "refresh"; href?: string };

const navigations: NavigationCall[] = [];

/** What the component asked the router to do, oldest first. */
export function navigationCalls(): readonly NavigationCall[] {
  return navigations;
}

/** Forget them. Call between tests in one file -- module state is per file. */
export function resetNavigation() {
  navigations.length = 0;
}

const router = {
  push: (href: string) => void navigations.push({ method: "push", href }),
  replace: (href: string) => void navigations.push({ method: "replace", href }),
  refresh: () => void navigations.push({ method: "refresh" }),
  back: () => {},
  forward: () => {},
  prefetch: () => {},
};

export function useRouter() {
  return router;
}
