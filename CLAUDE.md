# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all
differ from your training data. Read the relevant guide in
`node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

# Yana

Self-hosted RSS aggregator. **Next.js 16 / React 19 / TypeScript, SQLite via
Drizzle + better-sqlite3.** One language, one toolchain, one process.

This file is the only agent-instruction file in the repository. There is no
`AGENTS.md` and no per-directory `CLAUDE.md` — everything goes here.

## `old/` is reference only — never edit it, never import from it

`old/` is the retired Django 6.0 implementation, kept in the tree so its
behavior can be read while it is ported. It is:

- **Read-only.** No fixes, no formatting, no dependency bumps. It is not built,
  linted, typechecked, tested, containerized or deployed by anything.
- **Not runnable as configured.** Its paths, its CI workflow (`old/ci.yml`) and
  its compose files assume it sits at the repository root. That is expected and
  is not a bug to fix.
- **Undocumented on purpose.** Its Django-era `CLAUDE.md` was deleted rather than
  moved: tools auto-load a `CLAUDE.md` next to the files you open, and one
  describing `manage.py`, ruff/mypy/pytest and the `/admin/` surface would be
  read as instructions for this repository. `old/README.md` still describes the
  Django setup; read it as history. Do not add an instruction file under `old/`.

Behavior questions ("what does the Heise scraper strip?") are answered by
reading `old/core/` and by `parity/`. Structure questions are answered by this
file.

## Layout

```
.                                  # the Next.js app (this is the project)
├── src/
│   ├── app/
│   │   ├── layout.tsx             # root: providers, theme, locale, <Toaster>
│   │   ├── global-error.tsx       # last-resort boundary — no providers, English only
│   │   ├── health/route.ts        # GET /health — SELECT 1 against the database
│   │   └── (app)/                 # sidebar + breadcrumb chrome for every real page
│   │       ├── layout.tsx         # sidebar, content frame
│   │       ├── loading.tsx        # route-level Suspense fallback
│   │       ├── page.tsx           # dashboard
│   │       ├── error.tsx          # error boundary for every route in the group
│   │       └── settings/page.tsx
│   ├── components/
│   │   ├── ui/                    # shadcn components (Base UI + Tailwind v4)
│   │   ├── settings/               # general-, library-, about-section.tsx
│   │   ├── app-sidebar.tsx         # navigation, from src/lib/nav.ts
│   │   ├── route-breadcrumbs.tsx   # segment-derived breadcrumbs
│   │   ├── data-skeleton.tsx       # TableSkeleton, CardSkeleton
│   │   └── theme-provider.tsx      # next-themes wrapper
│   ├── hooks/                     # use-mobile.ts (hand-modified — see below)
│   ├── i18n/
│   │   ├── request.ts             # next-intl request config; reads getSettings()
│   │   └── next-intl.d.ts         # AppConfig augmentation — compiler-checked catalog keys
│   └── lib/
│       ├── db/
│       │   ├── client.ts          # getDb(), writeTransaction(), PRAGMAs
│       │   ├── bootstrap.ts       # BOOTSTRAP_USER_ID + ensureBootstrapUser() (phase 3 calls it)
│       │   ├── schema.ts          # barrel: re-exports schema/, declares every relation
│       │   ├── schema/            # enums.ts, users.ts, references.ts, feeds.ts,
│       │   │                      #   articles.ts, jobs.ts — one module per table group
│       │   ├── test-support.ts    # TEST-ONLY: migrate()-based fixture databases
│       │   └── *.test.ts          # client, schema, relations, bootstrap, schema/enums
│       ├── nav.ts                 # NAV_ITEMS + breadcrumbsFor() — single source for both
│       ├── settings/               # queries.ts (getSettings), actions.ts (server actions)
│       └── utils.ts               # cn()
├── messages/                      # en.json, de.json — must define identical keys (enforced)
├── drizzle/                       # generated migrations + meta/_journal.json
├── drizzle.config.ts              # drizzle-kit config (schema in, drizzle/ out)
├── public/                        # static assets served at /
├── Dockerfile                     # multi-stage, standalone output, runs as uid 1001
├── docker-entrypoint.sh           # applies Drizzle migrations, then starts server
├── docker-compose.yml             # dev container (prod build; use `npm run dev` to work)
├── docker-compose.production.yml  # target production shape — not yet deployed
├── data/                          # SQLite lives here (gitignored, starts empty)
├── media/                         # article images and feed logos (gitignored, starts empty)
├── parity/                        # frozen golden corpus — the porting oracle
├── docs/superpowers/              # direction records (specs/) and phase plans (plans/)
└── old/                           # retired Django implementation — reference only
    ├── data/                      # its SQLite file (db.sqlite3) — never read from here
    └── media/                     # its article images and feed logos — likewise
```

## Commands

```bash
npm install                  # first-time setup (Node 25 — see .nvmrc)
npm run dev                  # dev server at http://localhost:3000
npm run build                # production build (standalone output)
npm start                    # serve a production build
npm run lint                 # eslint
npm run format               # prettier --write
npm run format:check         # prettier --check (what CI runs)
npm run typecheck            # tsc --noEmit
npm test                     # vitest run

npx drizzle-kit generate     # generate a migration from schema.ts into drizzle/
npx drizzle-kit push         # apply schema directly (local only, no migration file)

docker compose up --build    # build and run the image
```

Before committing, run the same four checks CI runs:

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```

## Conventions

- **Style:** line length 100, double quotes, semicolons, trailing commas.
  Prettier owns formatting; ESLint owns everything else
  (`eslint-config-prettier` is appended last so it wins on formatting rules).
- **Imports:** `@/*` maps to `src/*` in both `tsconfig.json` and
  `vitest.config.ts` — add a path alias to both or tests break.
- **Dependency versions are pinned exactly** in `package.json` — no `^`/`~` on
  any dependency or devDependency. Regenerate `package-lock.json`
  (`npm install`) whenever a pin changes, and grep both files for `^`/`~`
  before committing. Node is pinned three times and all three must agree:
  `.nvmrc` (25.6.1), `package.json` `engines.node` (`>=25.0.0 <26`), and the
  Dockerfile's `node:25-alpine`.
- **Database access is centralized.** `getDb()` from `@/lib/db/client` is the
  only place a connection is opened (a lazy singleton). Every write goes through
  `writeTransaction()` from the same module — never raw
  `connection.exec`/`prepare` outside it. Its callback **must be synchronous**:
  better-sqlite3 has no async driver, so an `async` callback there would commit
  before your awaited code runs. The type (`NotPromise<T>`) and a runtime
  thenable check both reject it.
- **PRAGMAs are applied in `applyPragmas()`**, ported from the retired Django
  backend (WAL, `synchronous = NORMAL`, 64 MB cache, 256 MB mmap,
  `foreign_keys = ON`, `busy_timeout = 30000`) plus `BEGIN IMMEDIATE` on every
  write transaction. `busy_timeout` alone does not prevent the WAL
  read-to-write lock-upgrade deadlock; `IMMEDIATE` is what does.
- **`CHECK` constraints mirror Django's field types, deliberately.** Django's
  SQLite backend emitted them for `Positive*IntegerField` and `JSONField`, so
  the port declares them with `check()` (see `schema/articles.ts`,
  `schema/feeds.ts`, `schema/jobs.ts`). The JSON ones are the load-bearing pair:
  without `json_valid(...)` a malformed write is _accepted_ and the row becomes
  poison — every later read throws inside Drizzle's `mapFromDriverValue`, far
  from the write that caused it. On nullable columns a bare `>= 0` is correct;
  `NULL >= 0` is NULL, which SQLite treats as satisfied, exactly as Django had
  it. Adding a `CHECK` to an existing SQLite table needs the 12-step table
  rebuild, so add them with the column, not later.
- **`updatedAt` columns carry `$onUpdate(() => new Date())`** — the port of
  Django's `auto_now=True`. It is client-side (invisible in the DDL), so it only
  holds for writes that go through Drizzle, which the `writeTransaction()`
  convention already requires. Declared once in the schema so no call site has
  to remember; `DEFAULT (unixepoch())` alone would leave `updated_at` frozen at
  `created_at` forever.
- **Tests:** Vitest, `src/**/*.test.ts`, run with `npm test`. New library code
  (`src/lib/**`) gets **real-database** tests in the style of
  `src/lib/db/client.test.ts` — no driver mocks. Each test points
  `DATABASE_PATH` at its own temp file. Get the schema from
  `src/lib/db/test-support.ts`, which applies migrations with `migrate()` — the
  same call `docker-entrypoint.sh` makes, so tests and production agree about
  `drizzle/meta/_journal.json`. Never hand-roll a loader that `exec`s the
  `.sql` files directly: it ignores the journal, so a stale entry stays green in
  CI and dies at container startup. Relation declarations are invisible to
  `tsc` — a new one needs a real `db.query.*` traversal in
  `src/lib/db/relations.test.ts` or it can ship broken.
- **`src/hooks/use-mobile.ts` is hand-modified, not stock shadcn output.** It
  was rewritten from the CLI's generated `useState`+`useEffect` form to
  `useSyncExternalStore` to clear a `react-hooks/set-state-in-effect` lint
  failure. Running `npx shadcn add sidebar` (or anything else that regenerates
  this file) will silently overwrite it back to the failing form — re-apply the
  `useSyncExternalStore` rewrite if that happens.
- **`next.config.ts` pins `outputFileTracingRoot`** to this directory. Left
  inferred, Next walks up looking for a lockfile and can nest the whole absolute
  path under `.next/standalone`, which breaks the Dockerfile's assumption that
  `server.js` lands at the tree root.
- **Opt a route or layout out of prerendering with `await connection()` from
  `next/server`, never `export const dynamic = "force-dynamic"`.**
  `better-sqlite3` is synchronous, so its queries complete during prerendering,
  and without this a production build would bake a page against `data/` — which
  is gitignored and does not exist until the entrypoint's migration step runs at
  container start. Next 16 removes `dynamic` once Cache Components is enabled,
  so `connection()` is the form that keeps working; the local doc is
  `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md`,
  section "Synchronous database drivers", which names `better-sqlite3`
  explicitly. Used in `src/app/layout.tsx` and `src/app/health/route.ts` — the
  health route calls it _outside_ its `try`, because inside it the
  prerender bail-out (itself a thrown error) would be caught and turned into a
  503, silently reinstating a static `{"status":"ok"}`.
- **shadcn components here are built on Base UI (`@base-ui/react`), not Radix:
  compose with the `render` prop, never Radix's `asChild`.** A Radix-flavored
  snippet — `asChild` on a trigger, wrapping a `<Link>` — will not typecheck
  against this component library; see `src/components/app-sidebar.tsx` and
  `src/components/route-breadcrumbs.tsx` for the working form. Phases 5–13 will
  paste many shadcn snippets from documentation and tutorials that still assume
  Radix — expect this every time.
- **Every user-facing string comes from `messages/en.json` + `messages/de.json`**,
  which must define identical key sets — enforced by `src/i18n/messages.test.ts`.
  Use `useTranslations(namespace)` in client components and synchronous server
  components; `await getTranslations(namespace)` in async server components.
  The one accepted literal is the brand name "Yana".
- **Catalog keys are compiler-checked** via the `AppConfig` augmentation in
  `src/i18n/next-intl.d.ts`. The widely-copied `declare global { interface
IntlMessages }` form is next-intl **3** and is a silent no-op here; 4.x
  derives message types from `AppConfig` instead. A dynamic key must be typed
  narrowly at its _source_ (see `NavItem["labelKey"]` in `src/lib/nav.ts` and
  the `errorKey` field in `src/lib/settings/actions.ts`) — casting at a `t()`
  call site defeats the check.
- **Server actions return a catalog `errorKey`, never a zod or driver
  message**, or an English validator string reaches a German UI. See
  `src/lib/settings/actions.ts`.
- **Changing a catalog value requires re-running `npm run build`** before it
  shows up in a production server: webpack's context module inlines the
  dynamically-imported JSON into the server chunk at build time. `npm run dev`
  is unaffected. This cost an agent an hour already.
- **The streaming pattern:** chrome renders synchronously; data regions are
  async components inside `<Suspense>` with fallbacks from
  `src/components/data-skeleton.tsx`, **plus an error boundary** — once the
  shell has flushed its first byte the response status is already 200 and
  cannot become a 5xx, so a throw inside a Suspense boundary with no error
  boundary above it just truncates the stream. Locale resolution in the root
  layout is the one documented exception to "chrome never waits on data".
- **`getSettings()` is `cache()`d per request; `currentUserId()` is the
  phase-4 seam**, and its bootstrap seed is memoized per process —
  deliberately **not** self-healing, so a `user_settings` row deleted at
  runtime stays deleted until restart. The root layout's two reads (locale,
  theme) fall back instead of throwing (locale → `en`, theme → `system`) so a
  missing row cannot 500 the whole app; everywhere else the throw propagates on
  purpose.
- **Theme has two stores:** `localStorage` is authoritative for what is
  _applied_ (next-themes resolves `localStorage.getItem(key) || defaultTheme`);
  the database column is the _portable_ preference that seeds a fresh browser.
  The settings control displays the applied value.
- **Testing:** vitest runs `environment: "node"` with `include:
["src/**/*.test.ts"]` — **no `.tsx`, no jsdom, no testing-library, so no
  component has any test and a test file written for a component would be
  silently ignored.** Nothing currently warns anyone of this. When a harness is
  eventually added, a `next/navigation` stub is a _router_ stub and does not
  violate the no-driver-mocks convention above.

## Porting: `parity/` is the oracle

`parity/` holds frozen golden JSON generated from the Django pipeline before it
was retired. It is how a ported aggregator is proven correct.

- The fixtures are **deliberately stale**. A golden only requires both
  implementations to receive identical bytes; whether the HTML still matches the
  live site is a different question with different tests. Never refresh them to
  match production.
- Image content hashes are **not** compared — Pillow and sharp/libvips emit
  different bytes for identical input. Records carry normalized refs
  (`yana-img://{img:N}`) plus a manifest asserting content type and dimensions
  exactly and byte size within a tolerance.
- Regenerating a golden needs the Django tree in `old/`, which no longer runs
  as-is. Treat the corpus as frozen; see `parity/README.md`.

## Where the work is planned

`docs/superpowers/specs/2026-07-30-nextjs-migration-direction.md` is the
direction record — the decisions every phase builds on (multi-tenant, real tags,
greenfield data, SQLite `jobs` table with an in-process worker). Per-phase plans
are `docs/superpowers/plans/nextjs-*.md`, executed in order. Phase 1 (scaffold),
phase 2 (schema, migration `0000` and the bootstrap user), phase 3 (app shell —
i18n/theme, sidebar/breadcrumbs, streaming skeletons, the settings page and
`/health`) and the folder swap (phase 14, reworked to keep `old/`) are done;
phases 4–13 — auth, CRUD, aggregators, jobs and client API — are not. The
direction record's last sections carry the decisions phases 2's and 3's reviews
left to those phases.

Plans written before the swap use `yana-next/`-prefixed paths. Those are
repository-root paths now.

## Commit messages

```
<type>(<scope>): <description>

Types: feat, fix, docs, style, refactor, test, chore
Examples:
  feat(db): Add the feeds and articles tables
  fix(aggregator): Correct duplicate article detection
  test(db): Cover nested writeTransaction rollback
```
