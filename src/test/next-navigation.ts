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

/**
 * **Re-exported for real, not stubbed.** `vi.mock` replaces the *whole* module,
 * so any export a test file's tree reaches has to appear here or the import
 * throws `No "x" export is defined on the "next/navigation" mock` -- which is
 * how `attempt()` (`src/lib/account/result.ts`) broke `passkey-section.test.tsx`
 * the moment it started calling `unstable_rethrow`.
 *
 * A stub would be actively wrong here: this is not URL plumbing but a predicate
 * over Next's control-flow errors, and faking it would make a test prove the
 * opposite of what it claims -- that a `redirect()` from inside an action
 * escapes a `catch`. Imported by its implementation path rather than from
 * `next/navigation`, which inside this module would resolve back to this mock.
 */
import { unstable_rethrow as rethrow } from "next/dist/client/components/unstable-rethrow";

export function unstable_rethrow(error: unknown): void {
  rethrow(error);
}

let pathname = "/";

/** The pathname `usePathname()` will return from here on. */
export function setPathname(next: string) {
  pathname = next;
}

export function usePathname() {
  return pathname;
}

let searchParams = new URLSearchParams();

/**
 * The query string `useSearchParams()` will return from here on.
 *
 * A real `URLSearchParams` rather than a hand-shaped object, because the CRUD
 * kit's `useListParams()` calls `keys()`/`getAll()` on it -- and because
 * `parseListParams` has a documented rule about repeated keys that only a real
 * one can exercise.
 */
export function setSearchParams(next: string | URLSearchParams) {
  searchParams = typeof next === "string" ? new URLSearchParams(next) : next;
}

export function useSearchParams() {
  return searchParams;
}

/**
 * What `useRouter()` hands back. Empty by default: a test that never touches
 * the router does not have to say so, and one that does declares exactly the
 * methods it expects to be called.
 *
 * ```ts
 * const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
 * setRouter({ refresh });
 * ```
 *
 * Its own object rather than an inline `vi.mock("next/navigation", () => ({
 * useRouter: … }))` per file, because that form replaces the *whole* module:
 * the moment a component's tree reaches any other export -- `unstable_rethrow`,
 * which `attempt()` now calls -- the file dies with "No export is defined on
 * the mock", in a test that has nothing to do with routing.
 */
type Router = Partial<{
  refresh: () => void;
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
  forward: () => void;
  prefetch: (href: string) => void;
}>;

let router: Router = {};

/** The object `useRouter()` will return from here on. */
export function setRouter(next: Router) {
  router = next;
}

export function useRouter() {
  return router;
}
