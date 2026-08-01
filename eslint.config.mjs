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
   * A feature's `queries.ts` is the second shape, and phase 5 hit it live:
   * `src/lib/users/queries.ts` reaches `getDb()`, so importing one constant
   * from it dragged `better-sqlite3` into the browser bundle and the build
   * failed with a bundler error rather than the stated rule. The pattern below
   * names the *shape* -- any `queries` module one directory under `lib` --
   * rather than that one file, because phases 8-10 each add a `queries.ts` of
   * exactly the same kind, and a rule that has to be extended per feature is a
   * rule the next phase forgets. The client-safe
   * half of a feature lives in a dependency-free `fields.ts` beside it, which
   * is the `@/lib/avatar` to `queries.ts`'s `@/lib/avatar-storage`.
   *
   * **`allowTypeImports` is on, and that is the preferred form.** An
   * `import type { PasskeySummary } from "@/lib/account/queries"` is erased
   * before anything is bundled, so it cannot pull the driver in, and it keeps
   * the projection typed against the query that produces it -- see
   * `src/components/account/passkey-section.tsx`. Re-declaring the row
   * structurally in the component (as `users-table.tsx` does) is the fallback,
   * not the model to copy. This needs `@typescript-eslint/no-restricted-imports`
   * rather than the base rule, which has no such option; the base rule is left
   * unconfigured here so the two cannot both fire on one specifier.
   *
   * Scoped to `src/components/**` because that is the whole of the client
   * component surface today; a route handler, page or server action importing
   * these is correct and must keep working. Extend the `group` list, not the
   * message, when a third server-only shape appears.
   */
  {
    files: ["src/components/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          // Patterns rather than exact `paths` entries, so a relative specifier
          // (`../lib/avatar-storage`) is caught as well as the alias.
          patterns: [
            {
              group: ["**/avatar-storage"],
              allowTypeImports: true,
              message:
                "avatar-storage is server-only (sharp, node:path). Import presentation " +
                "helpers from @/lib/avatar instead, and keep processAvatar()/avatarFilePath() " +
                "in server actions and route handlers.",
            },
            {
              group: ["**/lib/*/queries"],
              allowTypeImports: true,
              message:
                "A feature's queries module is server-only (it reaches getDb()). Import " +
                "client-safe constants from the feature's fields.ts, call the feature's " +
                'server actions, or use `import type` for a row projection ("use server" ' +
                "modules cannot export types, which is why the projection lives here).",
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
