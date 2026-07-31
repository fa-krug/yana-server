<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

## Conventions for this tree (`yana-next/`)

This `CLAUDE.md`/`AGENTS.md` pair shadows the repository-root `CLAUDE.md` for
anyone working inside `yana-next/`. The root file's Django-focused sections
don't apply here; these do:

- **Style:** line length 100, double quotes, enforced by `npm run lint` +
  `npm run format:check`.
- **Dependency versions are pinned exactly** in `package.json` — no `^`/`~`
  ranges on any dependency or devDependency. Regenerate `package-lock.json`
  (`npm install`) whenever a pin changes, and grep both files for `^`/`~`
  before committing.
- **Database access is centralized.** `getDb()` from `@/lib/db/client` is the
  only place a connection is opened (it's a lazy singleton — see
  `src/lib/db/client.ts`). Every write goes through `writeTransaction()` from
  the same module, never raw `connection.exec`/`prepare` outside it. Its
  callback must be synchronous — better-sqlite3 has no async driver, and an
  `async` callback there commits before your awaited code runs.
- **Tests:** Vitest, run with `npm test`. New library code (`src/lib/**`)
  gets real-database tests in the style of `src/lib/db/client.test.ts` — no
  driver mocks.
- **`src/hooks/use-mobile.ts` is hand-modified, not stock shadcn output.** It
  was rewritten from the CLI's generated `useState`+`useEffect` form to
  `useSyncExternalStore` to clear a `react-hooks/set-state-in-effect` lint
  failure. Running `npx shadcn add sidebar` (or anything else that
  regenerates this file) will silently overwrite it back to the failing
  form — re-apply the `useSyncExternalStore` rewrite if that happens.

<!-- END:nextjs-agent-rules -->
