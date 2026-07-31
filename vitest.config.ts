import path from "node:path";

import { defineConfig } from "vitest/config";

// Two projects, because the two kinds of test need environments that cannot be
// merged: the library tests open a real better-sqlite3 file and must run in
// `node`, component tests need a DOM. Everything shared -- the `@` alias above
// all -- lives at the root and reaches both projects through `extends: true`.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          // .ts only: a component test is .tsx and belongs to the "dom"
          // project below, which is why this glob must stay narrow.
          include: ["src/**/*.test.ts"],
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
