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
   * A feature's `define.ts` is the third shape, and it arrived by *extraction*
   * rather than by being written: phase 7's refactor lifted the integrations
   * save/test/remove sequence out of `actions.ts`, and the safety it lost in the
   * move is invisible. Inside a `"use server"` module an accidental client
   * import is harmless by construction -- Next replaces the module with
   * reference stubs -- while the plain module it became imports `drizzle-orm`,
   * `@/lib/db/client` and `next/cache` like any other. It exports five *types*,
   * which is precisely what a component would reach for. Any later extraction
   * out of a `"use server"` module inherits this hazard and belongs here too.
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
   * message, when a fifth server-only shape appears.
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
            {
              // The third shape, and the one with the least warning attached to
              // it. `src/lib/integrations/define.ts` holds code that used to sit
              // inside a `"use server"` module, where an accidental client
              // import was safe by construction -- Next replaces such a module
              // with reference stubs. Extracted into a plain module it is an
              // ordinary import of drizzle-orm, @/lib/db/client and next/cache,
              // and its five exported *types* are exactly the reason a component
              // would reach for it.
              group: ["**/lib/*/define"],
              allowTypeImports: true,
              message:
                "A feature's define module is server-only (it reaches getDb() and " +
                "next/cache to build the save/test/remove actions). `import type` is fine " +
                "for the descriptor shapes; the actions themselves are reached through the " +
                'feature\'s "use server" actions module.',
            },
            {
              // The fourth shape, and the only one already *observed* as a build
              // failure rather than reasoned about in advance: `feeds-table.tsx`
              // imported AGGREGATOR_SPECS from the aggregator registry, whose
              // classes reach the image store -> @/lib/db/client ->
              // better-sqlite3, and the dev build died on
              // `Can't resolve 'fs'` pointing at binding.js rather than at the
              // component. The option descriptions a form renders live in
              // `specs.ts` beside it, which imports only zod and a type.
              group: ["**/aggregators/registry", "**/aggregators/base", "**/aggregators/sites/*"],
              allowTypeImports: true,
              message:
                "The aggregator registry is server-only (its classes reach getDb() and " +
                "better-sqlite3). Import AGGREGATOR_SPECS, schemaFor(), visibleOptionsFor() " +
                "and Capabilities from @/lib/aggregators/specs instead.",
            },
            {
              /**
               * **A separate entry with its own message, deliberately not folded
               * into the group above.**
               *
               * The three patterns before this one guard modules whose import
               * from a component produces an *opaque bundler error* --
               * `better-sqlite3`, `sharp`, a native addon -- so the rule is
               * telling you about a build that will fail. These are plain
               * `fetch` calls: nothing breaks if a component imports one, which
               * is exactly why the split that task 1 made between
               * `src/lib/ai/providers.ts` (client-safe, imports nothing) and the
               * probe modules is structural but unenforced. Filing them with the
               * others would blur what that group means.
               *
               * `probes.ts` is the barrel and the six provider modules are
               * what it wires; all seven are named, because reaching past the
               * barrel for one constant is the obvious way around a rule that
               * only guards the barrel. `OPENAI_DEFAULT_API_URL` -- the one
               * thing a form legitimately wants from this side -- was moved into
               * `providers.ts` for that reason, so no component needs an
               * exception.
               */
              group: [
                "**/lib/ai/probes",
                "**/lib/ai/openai",
                "**/lib/ai/anthropic",
                "**/lib/ai/gemini",
                "**/lib/ai/mistral",
                "**/lib/ai/qwen",
                "**/lib/ai/deepseek",
              ],
              allowTypeImports: true,
              message:
                "The AI probe modules are server-side outbound fetch calls, not a safety " +
                "boundary: importing one from a component costs bundle weight and puts six " +
                "provider clients in the browser for nothing. Everything a form needs -- the " +
                "model lists, the default model, whether a base URL is configurable, and " +
                "OPENAI_DEFAULT_API_URL -- is in the client-safe @/lib/ai/providers; the " +
                "probes are reached through the /ai server actions.",
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
    // Not app code.
    "docs/**",
    "data/**",
    "media/**",
    ".venv/**",
    ".claude/**",
    ".worktrees/**",
    "bin/**",
    "import-rss.ts",
  ]),
]);

export default eslintConfig;
