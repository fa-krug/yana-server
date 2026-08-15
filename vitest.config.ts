import path from "node:path";

import { defineConfig } from "vitest/config";

// Two projects, because the two kinds of test need environments that cannot be
// merged: the library tests open a real better-sqlite3 file and must run in
// `node`, component tests need a DOM. Everything shared -- the `@` alias above
// all -- lives at the root and reaches both projects through `extends: true`.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  test: {
    /**
     * 20s, against Vitest's 5s default -- and **the tests are not slow**. Their
     * bodies assert in milliseconds. What is slow is the one-time *cold* work a
     * test pays before it gets to assert anything, and there are two kinds:
     *
     * - **Loading the native stack.** Fifteen node tests call
     *   `vi.resetModules()` and then `await import(...)`, which re-transforms
     *   the graph through Vite and re-loads `better-sqlite3`'s native binding.
     *   Aggregate import time across the suite's 64 files is 34-44s (this
     *   machine reports `import 39.96s` on an idle run), so one cold import is
     *   seconds, not milliseconds. `src/instrumentation.test.ts > register >
     *   logs and exits when startup fails` pays one *in the test body*, because
     *   the reset happens in its `beforeEach`.
     * - **Better Auth's scrypt.** The KDF is expensive on purpose, and
     *   `src/lib/users/users.test.ts`'s `listUsers` cases seed a dozen users
     *   plus a real sign-in before asserting -- a dozen-odd hashes, serially.
     *
     * Neither is near 5s on an idle machine, which is exactly why this was a
     * flake: green locally, intermittent on CI, where `ubuntu-latest` is a
     * 2-core shared runner and these are wall-clock budgets against work that
     * is competing for a core. Reproduced by running the suite under 48 busy
     * loops on 8 cores: 8 tests failed, every one of them
     * `Test timed out in 5000ms` rather than an assertion or a lock error.
     *
     * 20s is 4x the default: comfortably past the worst case measured under
     * that contention, while still failing a genuinely hung test fast enough
     * that CI minutes are not the price of finding out. Do not tidy it back
     * down -- and do not raise it further either, because nothing in this suite
     * has any business taking 20s. `retry` would have hidden the flake instead
     * of bounding it, and would hide a real regression with it.
     *
     * At the **root**, so both projects inherit it via `extends: true`. Not
     * node-only, despite `dom` importing no native module: 4 of those 8
     * timeouts were `dom` tests (`general-section`, `user-form`,
     * `users-table`). Constructing a jsdom environment and rendering React is
     * its own cold cost -- the same run reports `environment 240.62s` -- so the
     * 5s budget is just as unrealistic there. One number also cannot drift out
     * of agreement with itself the way two could.
     *
     * **`hookTimeout` needs the same treatment, and this was measured, not
     * assumed.** Most node tests do strictly *more* of the cold work in
     * `beforeEach` than in the body -- a `vi.resetModules()`, a real
     * `applyMigrationsAt()`, then four to six cold imports -- so the hooks were
     * always the larger exposure; Vitest's 2x-larger default (10s) merely hid
     * it. Raising `testTimeout` alone made it visible: with the tests no longer
     * aborting at 5s, the very next run under the same 48 loops failed
     * `src/lib/settings/settings.test.ts > ... > rejects a retention of zero
     * days with a real catalog key` with `Hook timed out in 10000ms`. 30s keeps
     * the hook's budget above the body's, which is the right way round given
     * what each does.
     */
    testTimeout: 20_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          // .ts only: a component test is .tsx and belongs to the "dom"
          // project below, which is why this glob must stay narrow.
          // `scripts/**` is included alongside `src/**` for the one script
          // test that spawns `scripts/docs-api.ts` itself
          // (`scripts/docs-api.test.ts`) -- it lives beside the script it
          // tests, not under `src/`, so the glob has to reach it too.
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
          /**
           * One dependency module is inlined, and the regex is deliberately
           * this narrow.
           *
           * Vitest externalizes `node_modules` for SSR, so `vi.mock()` cannot
           * reach an import made *inside* a dependency. Better Auth's
           * `nextCookies()` plugin does exactly that -- `await
           * import("next/headers.js")` -- and it is the plugin that keeps a
           * password change from silently signing the caller out (see the
           * plugin comment in `src/lib/auth/server.ts`). Left externalized,
           * the one test that proves that behaves as if the plugin were
           * absent, and would pass with it deleted.
           *
           * Inlining just this file transforms it through Vite, so the
           * `next/headers` stub a test registers is what it receives. The
           * consequence to know about: **every `vi.mock("next/headers")` in
           * this repository must now also export `cookies`**, because the hook
           * calls it after any endpoint that sets a cookie, and a `cookies`
           * that is `undefined` throws a TypeError the plugin does not catch.
           */
          server: { deps: { inline: [/better-auth\/dist\/integrations\/next-js/] } },
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["src/test/setup.ts"],
        },
      },
    ],
  },
});
