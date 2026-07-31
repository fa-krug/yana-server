import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Appended last so it wins on formatting rules -- Prettier owns formatting,
  // ESLint owns everything else.
  prettier,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Project-specific:
    "node_modules/**",
    "drizzle/**",
    // Not app code. The folder swap put these inside `eslint .`'s scope for
    // the first time; `old/` in particular contains vendored admin JS and an
    // untracked .venv with thousands of JS files.
    "old/**",
    "docs/**",
    "parity/**",
    "data/**",
    "media/**",
  ]),
]);

export default eslintConfig;
