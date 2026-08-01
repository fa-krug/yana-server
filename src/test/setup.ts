// Setup for the "dom" vitest project (see vitest.config.ts). Environment only:
// it repairs two browser APIs the environment does not supply and resets state
// between tests. Nothing here decides what a component renders.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom implements no CSS media queries, so window.matchMedia is declared but
// undefined ("matchMedia" in window is true, calling it is a TypeError -- hence
// the typeof guard, not an `in` check). useIsMobile()
// (src/hooks/use-mobile.ts) subscribes to it on mount, which crashes anything
// rendering the sidebar; next-themes queries it too, for `enableSystem`. A
// never-matching list is the honest stand-in: it makes the desktop layout and
// the light system theme the test default, which is what these tests assert
// against.
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): MediaQueryList => ({
      media: query,
      matches: false,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
      // Deprecated, and unused here, but part of the interface.
      addListener: () => {},
      removeListener: () => {},
    }),
  });
}

// Node 25 defines its own `localStorage` global, and without
// `--localstorage-file` it is an empty object with no Storage methods at all
// (it also prints a process warning about the missing path). It shadows the
// jsdom one, so `localStorage.setItem` is a TypeError inside a jsdom test --
// which next-themes swallows, silently falling back to its defaultTheme and
// making the "localStorage wins over the server value" rule untestable. An
// in-memory Storage restores it. Delete this once the environment provides a
// working one; the typeof guard makes that a no-op change.
if (typeof window.localStorage?.setItem !== "function") {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, String(value)),
    removeItem: (key) => void entries.delete(key),
    clear: () => entries.clear(),
  };
  Object.defineProperty(window, "localStorage", { writable: true, value: storage });
}

/**
 * **No jsdom test may reach the network, and one of them now tries to.**
 *
 * `attemptCall()` (`src/lib/attempt.ts`, which every feature's `attempt()` and
 * the CRUD kit's backstops are built on) answers "did the session end?" by
 * probing `/api/auth/get-session` before it reports a failed action, so every
 * component test that exercises a rejecting action reaches a real `fetch` --
 * which in Node resolves the relative URL against jsdom's origin and spends a
 * connection refusal on it. Measured: one such test went from instant to over a
 * second and then failed its `waitFor`.
 *
 * The default is "the session is fine", which makes the ordinary failure path
 * the ordinary answer. A test that is *about* the probe overrides this with its
 * own `vi.stubGlobal("fetch", …)`, as `src/lib/account/result.test.tsx` does.
 * Whether the probe is consulted at all is that file's business; this only
 * keeps every other file off the wire.
 */
globalThis.fetch = (() =>
  Promise.resolve(
    new Response(JSON.stringify({ user: { id: "test-session" } }), { status: 200 }),
  )) as typeof fetch;

// Testing-library auto-cleans only when `afterEach` is a global, and this repo
// runs vitest without `globals: true`. Without this, every render stays in
// document.body and the next test's querySelectorAll sees both trees -- which
// would make "exactly one <main>" pass or fail depending on file order.
afterEach(() => {
  cleanup();
  // next-themes writes its key here, and one storage serves a whole test file
  // -- so without this a theme picked in one test decides what the next one
  // renders.
  localStorage.clear();
});
