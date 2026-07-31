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
│   │   ├── api/auth/[...all]/     # route.ts — every Better Auth endpoint
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
│   ├── instrumentation.ts         # register(): the one startup hook — see src/lib/startup.ts
│   ├── lib/
│   │   ├── startup.ts             # runStartupTasks(): migrate, then ensure an admin exists
│   │   ├── auth/
│   │   │   ├── server.ts          # the Better Auth instance — the single config point
│   │   │   ├── bootstrap.ts       # ensureAdminExists() — the default admin, when none exists
│   │   │   └── client.ts          # browser client (signIn/signOut/useSession, passkey)
│   │   ├── db/
│   │   │   ├── client.ts          # getDb(), writeTransaction(), PRAGMAs
│   │   │   ├── migrate.ts         # the only migrate() call — startup and tests share it
│   │   │   ├── schema.ts          # barrel: re-exports schema/, declares every relation
│   │   │   ├── schema/            # enums.ts, users.ts, auth.ts, references.ts, feeds.ts,
│   │   │   │                      #   articles.ts, jobs.ts — one module per table group
│   │   │   ├── test-support.ts    # TEST-ONLY: migrate()-based fixture databases
│   │   │   └── *.test.ts          # client, schema, relations, schema/enums
│   │   ├── nav.ts                 # NAV_ITEMS + breadcrumbsFor() — single source for both
│   │   ├── settings/               # queries.ts (getSettings), actions.ts (server actions)
│   │   └── utils.ts               # cn()
│   └── test/                      # TEST-ONLY: shared setup for the jsdom project
│       ├── render.tsx             # renderWithProviders() — real catalogs, optional theme
│       ├── next-navigation.ts     # usePathname stub (a router stub, not a data mock)
│       └── setup.ts               # cleanup + matchMedia/localStorage repair
├── messages/                      # en.json, de.json — must define identical keys (enforced)
├── drizzle/                       # generated migrations + meta/_journal.json
├── drizzle.config.ts              # drizzle-kit config (schema in, drizzle/ out)
├── public/                        # static assets served at /
├── Dockerfile                     # multi-stage, standalone output, runs as uid 1001
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
                             # Applying generated migrations is not a step you run:
                             # the server does it at startup, in every shape.

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
  Dockerfile's `node:25-alpine`. The one `overrides` entry
  (`better-auth` → `better-sqlite3`) exists because better-auth 1.6.25 declares
  a `peerOptional better-sqlite3@^12` it never loads (we use the Drizzle
  adapter). Without the override `npm install` fails ERESOLVE against this
  repo's 13.0.2 pin; with it, `npm ci` — what CI runs — resolves cleanly. That
  version is a **hand-maintained duplicate** of the top-level `better-sqlite3`
  pin: npm records it nowhere in the lockfile root, so bumping the dependency
  without bumping the override leaves the two disagreeing. Change both together.
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
  rebuild, so add them with the column, not later. `schema/auth.ts` is the
  documented exception and carries none: those tables have no Django ancestor
  and no JSON column, and a constraint we invented for a table Better Auth owns
  could be violated by a future release of it.
- **A table that gains _and_ loses columns in one `drizzle-kit generate` cannot
  be generated non-interactively — split it into two migrations.** drizzle-kit
  cannot tell "drop `is_admin`, add `role`" from "rename `is_admin` to `role`",
  so it opens `promptColumnsConflicts` and asks once per new column; with no TTY
  (an agent shell, CI) it aborts with
  `Error: Interactive prompts require a TTY terminal` and writes nothing. Piping
  newlines does not help — hanji reads raw keypresses and wants a TTY on stdin
  _and_ stdout. **Generate the additions first, then the drop as a second
  migration:** neither half has both an added and a missing column, so neither
  prompts. (Phase 4's `0002` predates this note and was produced the harder way,
  by driving the four prompts with `expect`. Same result, more moving parts.)
- **Better Auth maps onto the existing tables with `usePlural: true` and
  nothing else.** Its model names are singular (`user`, `session`, …) and this
  repo's Drizzle exports are plural; `usePlural` closes exactly that gap. No
  per-field `fields` mapping is needed or wanted, because the Drizzle adapter
  resolves a field by indexing the **table object** —
  `schemaModel[getFieldName(...)]` — so it matches the **JS property name**,
  never the SQL column name. `emailVerified: text("email_verified")` already
  lines up. The corollary is a trap: a property renamed for local taste
  (`credentialId` for Better Auth's `credentialID`) typechecks and then throws
  at the first request. None of this is visible to `tsc`, so
  `src/lib/auth/server.test.ts` provisions a user against a real migrated file;
  keep that test honest when the config changes.
- **`users.role` is the authorization model — there is no `isAdmin` boolean.**
  Phase 4 enabled Better Auth's `admin()` plugin, whose schema is role-based
  (`role`, `banned`, `banReason`, `banExpires` on the user, `impersonatedBy` on
  the session). Keeping a boolean beside it would have been two sources of
  truth for "may this person delete users" — the plugin's `setRole` writing one
  and our UI the other, with nothing keeping them agreed. Still no groups and
  no permission table: `"admin"` is the only role anything reads, and it is
  written once — `ADMIN_ROLE`/`ADMIN_ROLES` in `src/lib/auth/server.ts` are what
  the plugin's `adminRoles` is configured with _and_ what every "is this an
  admin" check reads, so a second literal `"admin"` in a query is a drift bug,
  not a shortcut. The plugin's
  own endpoints go unused (phase 5 hand-rolls user CRUD and declines
  impersonation); it is here for the `role` field and its server-side
  semantics, above all `input: false`, which makes Better Auth answer
  `FIELD_NOT_ALLOWED` to any request body carrying a role.
- **There is no self-registration.** `emailAndPassword.disableSignUp` is `true`,
  so `/api/auth/sign-up/email` answers `EMAIL_PASSWORD_SIGN_UP_DISABLED` to
  everyone: an open sign-up on a self-hosted server hands an account to anyone
  who can reach the host, with feed-URL fetching as an amplification surface
  behind it. Accounts exist only via `createUserWithPassword()` in
  `src/lib/auth/server.ts` — the admin bootstrap at startup, and admin-created
  users in phase 5. That seam reaches `auth.$context.internalAdapter` directly
  and hashes with the context's own `password.hash` (Better Auth's scrypt,
  never hand-rolled), which is also why `role` can be set there: `input: false`
  guards request bodies, not server code. `src/lib/auth/client.ts` deliberately
  does not re-export `signUp`. A phase adding invitations is _reopening_
  registration — design the token first.
- **The Better Auth instance takes a lazy database proxy, never `getDb()`
  directly.** `drizzleAdapter()` wants the handle by value, but `next build`
  imports every route's module graph and `data/` does not exist until the
  server's own startup hook migrates it. Do not read `betterAuth()` as lazy: it
  calls `init(options)` at import and stores the promise unawaited
  (`better-auth/dist/auth/base.mjs`), and that reaches the adapter factory
  immediately. What makes it safe is narrower — `drizzleAdapter`'s factory never
  _dereferences_ the handle (`createCustomAdapter(db)` closes over it without
  reading it; every `db.*` access sits inside an adapter method) — so the proxy
  is doing all the work. Two more consequences: the eager init means a rejection
  there (a missing `BETTER_AUTH_SECRET` under `NODE_ENV=production`) would be an
  unhandled rejection at module load, which under Node's default
  `--unhandled-rejections=throw` can take a worker down, so `server.ts` attaches
  a handler to `auth.$context` to turn it back into a failed request; and the
  proxy's `{}` target means `instanceof`, `Object.keys` and spread see nothing,
  while a bare `"x" in db` opens the connection.
- **Ratified exception to "every write goes through `writeTransaction()`":
  Better Auth's own writes do not.** Its adapter issues autocommit single
  statements, which never perform the WAL read→write lock upgrade
  `BEGIN IMMEDIATE` exists to prevent, and `busy_timeout` still applies because
  it runs on the same `getDb()` singleton — so the guarantee that rule buys is
  not lost here. The adapter's `transaction` option stays `false`, but as
  documentation only: every `db.transaction(...)` call site in it is gated on
  `provider === "mysql"`, so on SQLite the async-transaction hazard is
  unreachable either way. This exception covers Better Auth's own tables only;
  application code still uses `writeTransaction()`.
- **The passkey plugin ships as its own package.** `@better-auth/passkey` for
  the server plugin and `@better-auth/passkey/client` for the client half —
  it is no longer re-exported from `better-auth/plugins`, so a snippet that
  imports `passkey` from there is pre-1.6 and will not resolve. (`admin` _is_
  still exported from `better-auth/plugins`.) Both passkey halves must be
  registered: only one gives a client whose passkey methods do not exist, with
  no type error to say so.
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
  `src/lib/db/test-support.ts`, which goes through `applyMigrations()` in
  `src/lib/db/migrate.ts` — the **same function** the server calls at startup,
  so tests and production cannot disagree about `drizzle/meta/_journal.json`. Never hand-roll a loader that `exec`s the
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
  is gitignored and does not exist until the server's startup hook migrates it. Next 16 removes `dynamic` once Cache Components is enabled,
  so `connection()` is the form that keeps working; the local doc is
  `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md`,
  section "Synchronous database drivers", which names `better-sqlite3`
  explicitly.
  **It is per route, and a layout does not cover its pages.** The root layout's
  call does _not_ keep a page off the database: layout and page are sibling
  render scopes, React starts the page before the layout's interrupt lands, and
  a single `getTranslations()` there resolves the next-intl request config →
  `getSettings()` → `getDb()`. That is measured, not theoretical — until phase
  4's task 2 it left an empty, unmigrated `data/yana.db` behind on every
  `npm run build`. So **every route that can reach the database calls it
  itself, as its first statement**, before any translation or data call:
  `src/app/layout.tsx`, `src/app/health/route.ts`, `src/app/(app)/page.tsx` and
  `src/app/(app)/settings/page.tsx` today. A new page that reads anything needs
  its own line. The health route calls it _outside_ its `try`, because inside it
  the prerender bail-out (itself a thrown error) would be caught and turned into
  a 503, silently reinstating a static `{"status":"ok"}`. To check the invariant:
  delete `data/`, run `npm run build`, and confirm it was not recreated.
- **shadcn components here are built on Base UI (`@base-ui/react`), not Radix:
  compose with the `render` prop, never Radix's `asChild`.** A Radix-flavored
  snippet — `asChild` on a trigger, wrapping a `<Link>` — will not typecheck
  against this component library; see `src/components/app-sidebar.tsx` and
  `src/components/route-breadcrumbs.tsx` for the working form. Phases 5–13 will
  paste many shadcn snippets from documentation and tutorials that still assume
  Radix — expect this every time. One Base UI trap the phase-3 review caught
  late: **a `<Select>` needs an `items` prop** (a record, or a
  `{ value, label }[]`) or its collapsed trigger prints the raw value —
  `<Select.Value>` resolves labels from `items` alone and never reads
  `<Select.ItemText>`, so translated popup items prove nothing about the
  trigger. Build the list once and render the `<SelectItem>`s from it, as
  `src/components/settings/general-section.tsx` does.
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
  phase-4 seam**, and its owner lookup is memoized per process — deliberately
  **not** self-healing, so a `user_settings` row deleted at runtime stays
  deleted until restart. It resolves the administrator by role and **writes
  nothing**: seeding moved to startup (see the bullet below), so the settings
  path can no longer create the account it reads. The root layout's two reads
  (locale, theme) fall back instead of throwing (locale → `en`, theme →
  `system`) so a missing row cannot 500 the whole app; everywhere else the throw
  propagates on purpose.
- **There is one startup path: `register()` in `src/instrumentation.ts`, which
  awaits `runStartupTasks()` in `src/lib/startup.ts`.** Next calls it once per
  server instance before the first request — `next dev`, `npm start` and the
  image alike. It **migrates first, then ensures an admin exists**; the order is
  load-bearing, because the bootstrap queries `users`. Migrating here is what
  retired `docker-entrypoint.sh`: its inline `node -e` covered the container and
  nothing else, so a fresh checkout ran `npm run dev` against an empty database.
  Next does **not** call `register()` during `next build` —
  `registerInstrumentation()` returns early on
  `NEXT_PHASE === "phase-production-build"` — which is what keeps a build from
  creating and migrating a database on the build machine.
  Two consequences to respect when touching this:
  - **`instrumentation.ts` imports exactly one module, `@/lib/startup`, and it
    must stay one.** Webpack compiles the hook for the **edge** runtime too and
    follows its imports regardless of the `NEXT_RUNTIME` guard, so anything
    reachable from there drags `node:fs` and `better-sqlite3` into a runtime
    that has neither — which fails the compilation and makes **`next dev` answer
    500 on every route** while `next build` and `npm start` stay green.
    `next.config.ts` cuts that single specifier out of the edge layer with
    `IgnorePlugin`. Add startup steps inside `runStartupTasks()`, never a second
    import in the hook, and re-test `npm run dev` — not just the build — after
    touching either file.
  - **A failure at startup is not swallowed**, and the shape is worth knowing:
    Next logs `Failed to prepare server` plus an unhandled rejection, keeps the
    process alive and answers 500 to everything, retrying per request. That is
    the intended outcome for an unusable database (`/health` fails too, so a
    healthcheck sees it). The single exception is a duplicate-key loss to a
    concurrent bootstrap, absorbed inside `ensureAdminExists()`.
- **The default admin: `admin@admin.com` / `admin`, created only when no admin
  exists.** Three things are load-bearing. The check is keyed on **"any user
  holds an admin role"** (`ADMIN_ROLES` from `auth/server.ts`, the same list the
  `admin()` plugin is configured with), never on the address — so a renamed or
  deleted default does not come back on the next boot. The account is created
  through `createUserWithPassword()`, so it has a real scrypt credential and can
  sign in; the phase-3 seeder it replaces wrote a `users` row with no `accounts`
  row, which could not, and no row-shape assertion catches that — the test signs
  in for real. And because creating it is three writes that cannot be one
  transaction (better-sqlite3 has no async driver), every boot re-checks its own
  postcondition and completes a half-provisioned default admin: missing
  credential (unless the account has a passkey, which means passwordless on
  purpose) or missing `user_settings` row. That repair is scoped to
  `admin@admin.com` alone — never to an admin phase 5 created or an operator
  renamed — and it is not a licence for the read path to self-heal:
  `getSettings()` still throws.
- **Theme has two stores:** `localStorage` is authoritative for what is
  _applied_ (next-themes resolves `localStorage.getItem(key) || defaultTheme`);
  the database column is the _portable_ preference that seeds a fresh browser.
  The settings control displays the applied value.
- **Testing: two vitest projects, and the file extension picks one.**
  `vitest.config.ts` declares `test.projects` (the vitest 4 mechanism; the
  `workspace` field is gone), both inheriting the `@` alias via `extends: true`:
  - **`node`** — `environment: "node"`, `include: ["src/**/*.test.ts"]`. The
    real-SQLite library tests above. Keep this glob `.ts`-only.
  - **`dom`** — `environment: "jsdom"`, `include: ["src/**/*.test.tsx"]`,
    `setupFiles: ["src/test/setup.ts"]`. Component tests, colocated with the
    component; `@testing-library/react` + plain DOM queries and vitest's own
    `expect` (no `jest-dom`).

  Shared wrappers live in **`src/test/`** so later phases extend them instead of
  copy-pasting: `render.tsx` (`renderWithProviders`, which wraps
  `NextIntlClientProvider` with the **real** `messages/*.json` and optionally
  next-themes' provider), `next-navigation.ts` (`usePathname` + `setPathname`,
  registered per file with `vi.mock("next/navigation", () => import(...))`), and
  `setup.ts` (testing-library cleanup, plus repair for two APIs the runtime
  lacks: `window.matchMedia`, which jsdom declares but leaves `undefined`, and
  `localStorage`, which Node 25 shadows with a method-less object that makes
  next-themes silently fall back to `defaultTheme`).

  A `next/navigation` stub is a _router_ stub and does **not** violate the
  no-driver-mocks convention above, which is about the database. Messages are
  never stubbed — a test carrying its own message objects would pass while the
  shipped catalogs were broken.

  **`async` server components cannot be rendered by testing-library** — that
  covers `settings/page.tsx` and the `Sections`/`LibrarySummary` data regions,
  which stay untested. Don't reshape production code to make them testable. A
  synchronous server component is fine: `src/app/(app)/layout.tsx` is rendered
  in `layout.test.tsx`.

  What is covered so far is exactly what phase 3's escaped defects needed: one
  `<main>` landmark, no `li` inside `li`, breadcrumbs translating nav segments
  while showing record ids verbatim, and the Select trigger's translated label.
  Assert against `de.json` where English is too close to the raw value to prove
  anything ("Dark" vs. `dark`). New structural assertions are worth checking
  against the defect they describe — reintroduce it, watch the test fail, revert
  — because a `.tsx` test used to be ignored outright and a green test proves
  nothing on its own.

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
phase 2 (schema, migration `0000` and the bootstrap user — that seeder is gone,
retired by phase 4's admin bootstrap), phase 3 (app shell —
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
