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
