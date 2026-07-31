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
  /**
   * Server-only modules, enforced rather than merely documented.
   *
   * `src/lib/avatar-storage.ts` imports `sharp` (a native addon) and
   * `node:path`; a component importing it gets an opaque bundler error rather
   * than the stated rule, and the presentation helpers it actually wants are in
   * `@/lib/avatar`, which imports nothing on purpose. The `server-only` package
   * would do this too, but it is not installed and a dependency is not worth
   * buying one lint rule.
   *
   * Scoped to `src/components/**` because that is the whole of the client
   * component surface today; a route handler or server action importing it is
   * correct and must keep working. Extend the `files` list, not the message,
   * when a second server-only module appears.
   */
  {
    files: ["src/components/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // A pattern rather than an exact `paths` entry, so a relative
          // specifier (`../lib/avatar-storage`) is caught as well as the alias.
          patterns: [
            {
              group: ["**/avatar-storage"],
              message:
                "avatar-storage is server-only (sharp, node:path). Import presentation " +
                "helpers from @/lib/avatar instead, and keep processAvatar()/avatarFilePath() " +
                "in server actions and route handlers.",
            },
          ],
        },
      ],
    },
  },
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
