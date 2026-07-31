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
│   │   ├── media/avatars/[userId]/ # route.ts — the only thing that serves media/
│   │   ├── login/page.tsx         # /login — outside (app): no sidebar, no requireUser()
│   │   └── (app)/                 # sidebar + breadcrumb chrome for every real page
│   │       ├── layout.tsx         # sidebar, content frame; awaits requireUser()
│   │       ├── loading.tsx        # route-level Suspense fallback
│   │       ├── page.tsx           # dashboard
│   │       ├── error.tsx          # error boundary for every route in the group
│   │       ├── account/page.tsx   # /account — profile, password, passkeys
│   │       └── settings/page.tsx
│   ├── components/
│   │   ├── ui/                    # shadcn components (Base UI + Tailwind v4)
│   │   ├── auth/                   # login-form.tsx — passkey first, password revealed
│   │   ├── account/                # profile-, password-, passkey-section.tsx
│   │   ├── settings/               # general-, library-, about-section.tsx
│   │   ├── user-avatar.tsx         # image, else initials on a colour from the id
│   │   ├── app-sidebar.tsx         # navigation, from src/lib/nav.ts
│   │   ├── route-breadcrumbs.tsx   # segment-derived breadcrumbs
│   │   ├── data-skeleton.tsx       # TableSkeleton, CardSkeleton
│   │   └── theme-provider.tsx      # next-themes wrapper
│   ├── hooks/                     # use-mobile.ts (hand-modified — see below)
│   ├── i18n/
│   │   ├── request.ts             # next-intl request config; reads getSettings()
│   │   ├── locale.ts              # LOCALES + negotiateLocale() — the signed-out locale
│   │   └── next-intl.d.ts         # AppConfig augmentation — compiler-checked catalog keys
│   ├── instrumentation.ts         # register(): the one startup hook — see src/lib/startup.ts
│   ├── proxy.ts                   # route protection (Next 16's name for middleware.ts)
│   ├── lib/
│   │   ├── startup.ts             # runStartupTasks(): migrate, then ensure an admin exists
│   │   ├── auth/
│   │   │   ├── roles.ts           # ADMIN_ROLE(S) + isAdminRole() — imports nothing, on purpose
│   │   │   ├── server.ts          # the Better Auth instance — the single config point
│   │   │   ├── session.ts         # currentUser/currentUserRow/requireUser/requireAdmin/
│   │   │   │                      #   refreshSession/currentUserId
│   │   │   ├── bootstrap.ts       # ensureAdminExists() — the default admin, when none exists
│   │   │   ├── client.ts          # browser client (signIn/signOut/useSession, passkey)
│   │   │   ├── next-path.ts       # LOGIN_PATH + safeNextPath() — the open-redirect guard
│   │   │   ├── sign-in-errors.ts  # Better Auth error codes → `auth` catalog keys
│   │   │   └── test-support.ts    # TEST-ONLY: sign in, and turn Set-Cookie into a Cookie header
│   │   ├── db/
│   │   │   ├── client.ts          # getDb(), writeTransaction(), PRAGMAs
│   │   │   ├── migrate.ts         # the only migrate() call — startup and tests share it
│   │   │   ├── schema.ts          # barrel: re-exports schema/, declares every relation
│   │   │   ├── schema/            # enums.ts, users.ts, auth.ts, references.ts, feeds.ts,
│   │   │   │                      #   articles.ts, jobs.ts — one module per table group
│   │   │   ├── test-support.ts    # TEST-ONLY: migrate()-based fixture databases
│   │   │   └── *.test.ts          # client, schema, relations, schema/enums
│   │   ├── account/               # queries.ts (getAccountOverview), actions.ts (writes)
│   │   ├── avatar.ts              # initialsFor/colourFor/displayNameFor/avatarUrlFor/
│   │   │                          #   safeAvatarSrc + AVATAR_MAX_* — imports nothing
│   │   ├── avatar-storage.ts      # SERVER-ONLY: processAvatar() (sharp), avatarFilePath(), mediaRoot()
│   │   ├── browser-location.ts    # replaceLocation() — the one hard navigation, and its test seam
│   │   ├── nav.ts                 # NAV_ITEMS + breadcrumbsFor() — single source for both
│   │   ├── settings/               # queries.ts (getSettings + the re-exported currentUserId),
│   │   │                           #   actions.ts (server actions)
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
  written once — `ADMIN_ROLE`/`ADMIN_ROLES`/`isAdminRole()` in
  **`src/lib/auth/roles.ts`** are what the plugin's `adminRoles` is configured
  with _and_ what every "is this an admin" check reads, so a second literal
  `"admin"` in a query is a drift bug, not a shortcut. That module **imports
  nothing** and must stay that way: it is the one piece of the auth stack a DOM
  test, a client component or `src/proxy.ts` may read without dragging
  `better-sqlite3` in behind it. The plugin's
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
  `src/app/layout.tsx`, `src/app/health/route.ts`, `src/app/(app)/page.tsx`,
  `src/app/(app)/settings/page.tsx` and `src/app/login/page.tsx` today. A new page that reads anything needs
  its own line — unless it already awaits a Dynamic API, which opts the route
  out just as well: `src/app/(app)/layout.tsx` needs no `connection()` because
  `requireUser()` awaits `headers()` before anything touches SQLite.
  The health route calls it _outside_ its `try`, because inside it
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
  boundary above it just truncates the stream. There are exactly two documented
  exceptions to "chrome never waits on data": locale resolution in the root
  layout, and the `requireUser()` in `src/app/(app)/layout.tsx` — both are a
  cookie read plus at most one indexed query, and the sidebar cannot render
  before the second one, since which items it contains depends on the answer.
  The layout's await is also the last point at which a `redirect()` can still
  change the response; after the first byte flushes it cannot.
- **Identity comes from the session: `currentUser()`, `requireUser()`,
  `requireAdmin()` and `currentUserId()` in `src/lib/auth/session.ts`.**
  `currentUserId()` keeps the signature phase 3 gave it and is re-exported from
  `src/lib/settings/queries.ts`, which is why closing the seam changed no
  consumer. **Never memoize an identity across requests** — the per-process memo
  that lived here while a single hard-coded owner _was_ the authorization model
  would now serve the first visitor's identity, and settings, to everyone else;
  `cache()` (per request) is the only sound memo, and `currentUser()` carries it.
  Two rules on top:
  - **`requireAdmin()` passes `disableCookieCache: true`, and must keep doing
    so.** `session.cookieCache` serves the whole user object — `role` included —
    from a signed cookie for 5 minutes with no database read, so an admin
    demoted a minute ago is still an admin to any check that trusts it. Identity
    reads may keep the cache (a stale id is not a privilege bug, and that is the
    read on every render); authorization may not.
  - **`requireAdmin()` answers 404, not 403.** A 403 confirms the route exists,
    which a non-admin has no reason to learn.
- **`nextCookies()` is registered last in the plugin array, and removing it
  breaks a feature silently.** Better Auth writes its cookies into
  `ctx.context.responseHeaders`; the `/api/auth/*` route turns those into a real
  `Set-Cookie`, but an `auth.api.*` call from a **server action** has no such
  response, so without this plugin those headers are dropped. The case that
  makes it mandatory is `changePassword({ revokeOtherSessions: true })`: it
  deletes _every_ session including the caller's and mints a replacement, so a
  dropped cookie signs the user out by changing their own password, under a
  success toast. It must be **last** — Better Auth's own
  `warnIfCookiePluginNotLast()` logs when any later plugin declares
  `hooks.after`. Testing it needs one more thing: vitest externalizes
  `node_modules`, so `vi.mock("next/headers")` cannot reach the plugin's
  internal `await import("next/headers.js")` — `vitest.config.ts` inlines that
  single module for the `node` project, and **every `vi.mock("next/headers")`
  in this repository must therefore also export `cookies`**, or the hook throws
  a TypeError it does not catch.
- **Displaying a user's own columns uses `currentUserRow()`, not
  `currentUser()`.** The session is served from a five-minute signed cookie and
  React's per-request `cache()` freezes even that, so after a server action
  writes to `users` the re-render _that action triggers_ still paints the old
  values — measured in a browser, where the sidebar footer kept saying "Admin"
  after the account page saved "Ada Lovelace", and only a full reload fixed it.
  `currentUserRow()` is one indexed lookup, `cache()`d per request, shared by
  the (app) layout's footer and `getAccountOverview()`. `requireUser()` /
  `requireAdmin()` remain the gates; this is a projection called after one.
  Writes additionally call **`refreshSession()`**, which re-reads with
  `disableCookieCache: true` so the _cookie_ is honest on the next request —
  and that rewrite only lands because `nextCookies()` is registered.
- **`/account` is the one page that writes `users` directly.** Better Auth's
  `/update-user` is in `disabledPaths` (it accepts an arbitrary `image`), so
  `src/lib/account/actions.ts` writes the columns through `writeTransaction()`
  like every other write here — and writes `name` alongside
  `firstName`/`lastName`, because that is what the browser's passkey chooser
  displays. Two rules with teeth: **removing an avatar must `unlink` the file**,
  not just null the column (the media route serves what is on disk and never
  reads `users.image`), and **the last passkey may be deleted only when a
  password credential exists** — no self-registration and no mail transport
  means an account with neither is unreachable without editing SQLite by hand.
  That guard lives in the server action; the card only decides whether to
  _offer_ the button.
- **`/account` has a label but is deliberately not in `NAV_ITEMS`.** It is
  reached from the sidebar _footer_; `UNLISTED_ROUTES` in `src/lib/nav.ts` is
  what still gives its breadcrumb a catalog key, without printing a second
  navigation entry.
- **next-intl is given an explicit `timeZone` (`process.env.TZ || "UTC"`).**
  Left unset it falls back to the _environment's_ zone — the container's on the
  server, the visitor's in the browser — so a date formatted in both places can
  render one day on the server and another after hydration, and next-intl logs
  an ENVIRONMENT_FALLBACK warning until one is configured. `src/test/render.tsx`
  pins `"UTC"` for the same reason: otherwise a date assertion depends on the
  developer's laptop.
- **`getSettings()` is `cache()`d per request and has no insert-if-absent
  fallback**: a missing `user_settings` row is a provisioning bug and throws.
  The root layout's two reads are the exception, because a throw there is a 500
  on every route in the app — including `/settings`, the one page that could
  repair the state. Both degrade instead: the theme falls back to `system` in
  `themePreference()` in `src/app/layout.tsx`, and the locale falls back in
  `src/i18n/request.ts` — which the layout reaches through `getLocale()` — where
  `browserLocale()` negotiates `Accept-Language` against `["en", "de"]` rather
  than settling for a constant. Both also swallow the signed-out `redirect()`
  (`isLoginRedirect()`), because this layout renders on `/login` too and
  propagating it there would loop forever. Everywhere else the throw propagates
  on purpose.
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
    import in the hook. `src/instrumentation.test.ts` is the tripwire: it reads
    both files and fails if the import list stops matching that regexp, or if
    `dev` and `build` stop agreeing on `--webpack` (the hook is inert under
    Turbopack). Nothing else would catch it — CI runs no build and no dev boot,
    and `next build` never compiles the edge hook at all.
  - **A startup failure logs and then `process.exit(1)`** — unconditionally, no
    `NODE_ENV` branch. Left to Next, a thrown `register()` leaves the standalone
    production server _up_, answering 500 to every route: under compose the
    `/health` check eventually marks it unhealthy, but a plain `docker run` shows
    a running container serving nothing. That is the `exit 1` contract
    `docker-entrypoint.sh` used to provide, restored. The absence of a
    dev-keeps-running branch is measured, not an oversight: `next dev` **already
    exits with code 1** when `register()` throws, so such a branch would document
    behaviour that does not exist. The single failure that reaches neither is a
    duplicate-key loss to a concurrent bootstrap, absorbed inside
    `ensureAdminExists()`.
- **Route protection is `src/proxy.ts` — Next 16's rename of `middleware.ts`,
  and it is not cosmetic.** The old name still works but warns on every build,
  and a Proxy defaults to the **Node.js** runtime where middleware was compiled
  for the edge (the `runtime` segment config is rejected in this file). Both the
  file name and the exported function name (`proxy`, not `middleware`) have to
  change together: half a rename is a file Next silently never calls, which
  would leave every route unguarded with nothing failing. The doc is
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`.
  Three rules:
  - **It checks cookie _presence_ only, and is not authentication.** It cannot
    reach the database — `@/lib/db/*` and `@/lib/auth/server` are banned there,
    pinned by `src/proxy.test.ts`, because a proxy is documented as code that may
    run outside the application's main runtime (and under the old edge
    compilation such an import failed the _build_ and made `next dev` 500 on
    every route). What it buys is a redirect with `?next=` before Next renders
    anything. The real check is `requireUser()`/`requireAdmin()` in the layout or
    the server action — which is also Next's own guidance, for a sharper reason:
    a server function is a POST to the route that uses it, so a matcher change
    can silently remove proxy coverage from it.
  - **Use `getSessionCookie()` from `better-auth/cookies`**, never a
    `name.includes("session")` substring match: it knows the configured prefix
    and the `__Secure-` prefix that appears the moment this is served over
    HTTPS, so the substring version is a check that works locally and sends
    every authenticated production request to `/login`.
  - **The public surface is compared at a path boundary, and static assets are
    excluded by extension.** `PUBLIC_PREFIXES` goes through `isPublic()`
    (`pathname === p || pathname.startsWith(p + "/")`): a bare `startsWith`
    opens routes rather than closing them — it exempted `/loginx` and, worse,
    `/api/authorize` under the `/api/auth` prefix. The matcher's
    `.*\.(?:svg|png|…|woff2)$` exclusion is what covers `public/`, whose files
    are served from the site root where no prefix can tell them from a route:
    without it `/globe.svg` answered `307 → /login`, on the one page whose
    visitor has no session to be redirected with. **Every extension on that
    list is a path shape that can never be guarded again**, so it is kept to
    what `public/` actually holds: `svg|ico|txt|xml|webmanifest` and the fonts.
    The raster extensions are deliberately _not_ on it — `.png`, `.jpg` and
    `.webp` are what user content is served as, and exempting them removed
    proxy coverage from routes phases 5–13 have yet to write. `media/` is not
    exempted either, for the same reason: nothing serves it yet. Naming
    `public/`'s three files instead (`(?!file\.svg|globe\.svg|window\.svg)`)
    is legal — a matcher entry is a regex — and is rejected only because it
    needs editing every time a file is added there.
- **A route handler serving `media/` authenticates itself — nothing above it
  does.** `src/app/media/avatars/[userId]/route.ts` is the first one and the
  pattern for phases 9/11's article images, which are numerous, per-user and may
  be paywalled. The proxy _runs_ for these paths (`media/` is not exempted and
  the raster extensions are off the matcher's list) but only checks that _a_
  session cookie exists, and **a route handler has no layout above it**, so no
  `requireUser()` is otherwise in its path. Six rules:
  - `requireUser()` inside the handler, **then** compare the requested id to the
    caller's. Being signed in is not authorization to read someone else's file.
  - **The filesystem path is built from the session's id, never from the URL
    segment** — the segment is only ever compared. Same lesson as
    `safeNextPath()`: validate the value you _use_, not the value you received.
  - **The id is checked against a whole-string allow-list, never sanitised.**
    `avatarFilePath()` in `src/lib/avatar-storage.ts` owns that check —
    `/^[A-Za-z0-9]{32}$/`, which is Better Auth's `generateId()` exactly — and
    returns `null` rather than a path, so no caller can build one from an
    unchecked string. A blocklist only refuses the encodings someone remembered;
    this refuses `%2e%2e%2f`, a NUL, a backslash and a bare `.` without naming
    them. The route test pins the pattern against an id Better Auth really
    minted, so a `generateId` change fails a test instead of 404ing every avatar.
  - **Every refusal is the same empty 404.** "Not yours", "no such user" and
    "nothing uploaded" must be indistinguishable, or the 200-vs-404 difference
    is a user-id enumeration oracle. (`requireAdmin()` answers 404 for the same
    reason.)
  - **`Cache-Control: private, no-store`, deliberately**, plus `nosniff` and a
    constant `Content-Type`. The URL carries no version token, so any freshness
    lifetime would survive a re-upload; give the URL a content hash first if a
    later phase wants `immutable`.
  - **A signed-out caller gets `requireUser()`'s `307 → /login`, not a 404, and
    that stays.** It is the same answer the proxy already gives for the whole
    `media/` prefix on the no-cookie path, and it is uniform across ids, so it
    leaks nothing. Diverging in the handler alone would make one condition — no
    valid session — answer two ways depending only on whether a cookie header
    happened to be present. A media-specific answer has to change the proxy too,
    in one deliberate step.

  Three more things that are easy to get wrong here:

  - **The media root** is `process.env.MEDIA_PATH ?? ./media` (`/app/media` in
    the image), read **per call** rather than pinned at module load like
    `DB_PATH` — there is no connection to cache, and a test can then point it at
    a temp directory without resetting the module registry.
  - **Type the handler's context structurally**
    (`{ params: Promise<{ userId: string }> }`), not with the global
    `RouteContext<"/…">` helper the Next docs show: that type is generated into
    `.next/types/routes.d.ts` by `next dev`/`build`/`typegen`, and CI runs
    `npm run typecheck` after none of them. (`next-env.d.ts` imports the same
    missing file and survives only because `skipLibCheck` ignores errors inside
    declaration files.)
  - **`next/image` cannot optimise a media URL.**
    `/_next/image?url=/media/avatars/<id>` answers 400 for everyone including
    the owner, because the optimizer refetches server-side and that request
    carries no session cookie. Use a plain `<img>`; these are already 256×256.

- **The `users.image` contract, in both directions.** The column holds
  **`avatarUrlFor(userId)`** — the URL `/media/avatars/<userId>` — and never a
  filesystem path. The filesystem path is `avatarFilePath(userId)` and is a
  separate thing with a `.webp` on the end. Getting this wrong fails silently:
  a relative `media/avatars/<id>.webp` resolves against `/account` to
  `/account/media/avatars/…`, 404s, `AvatarImage` never mounts, initials show
  forever and nothing throws. Three rules follow:
  - **Writing** an avatar writes the file at `avatarFilePath(userId)` and
    `avatarUrlFor(userId)` to the column, in that order.
  - **Deleting** one must `unlink` the file as well as null the column. The
    route serves whatever is on disk and never reads `users.image`, so nulling
    the column alone leaves the old picture being served — to its owner only,
    but still served.
  - **Reading** goes through `safeAvatarSrc()` in `src/lib/avatar.ts`, never
    `user.image` directly. The column is **attacker-controlled**: Better Auth's
    `POST /api/auth/update-user` accepted an arbitrary `image` from any
    signed-in user (verified live), and `<UserAvatar>` renders in _other
    people's_ browsers — the sidebar footer, phase 5's user list — so a stored
    `https://evil.example.com/track.gif` is an IP/user-agent/referrer beacon
    firing from every viewer, routing around the entire session-gated route.
    `safeAvatarSrc()` accepts the column only when it **equals**
    `avatarUrlFor(user.id)` and otherwise renders initials — an equality test,
    not a prefix or protocol check, for the same reason the route handler
    compares rather than sanitises. `src/lib/auth/server.ts` closes the write
    side with `disabledPaths: ["/update-user"]` (see the comment there: `image`
    is a core field, so `input: false` cannot reach it), but the render-side
    check is the half that holds however a value got into the column —
    `/admin/update-user` is still routable to an administrator.

- **Uploads are re-encoded, never stored as received, and the limits live in
  `processAvatar()`.** It decodes to pixels and emits a 256×256 WebP
  (`.rotate()` before `.resize()`, so EXIF orientation is honoured before it is
  stripped). Serving an upload back untouched is how an "image" becomes stored
  HTML or an SVG carrying script; re-encoding is also what makes the handler's
  fixed `image/webp` a fact rather than a guess. It also carries
  `limitInputPixels: 25_000_000` and `.timeout({ seconds: 10 })` — **a byte cap
  on the upload does not bound either**, because a decompression bomb is small
  on the wire and enormous in memory (a 758 kB PNG decoding at 256 MP costs
  ~250 MB of RSS, and ten concurrent ones ~700 MB). sharp's own default is
  268 MP, which is no protection. Keep the limits in the function, never in the
  caller: a caller cannot forget what it never had to remember. `sharp` is
  pinned at the same version Next already resolves transitively (`0.34.5`) —
  bump both together. The _numbers_ (`AVATAR_MAX_MEGABYTES`,
  `AVATAR_MAX_MEGAPIXELS`, `AVATAR_SIZE`) live in `src/lib/avatar.ts` so the
  account page can **state** them — it is a client component and may not import
  `avatar-storage` — while `processAvatar()` still applies them. A rejection
  message must **name the megapixel limit**; "processing failed" is the message
  this arrangement exists to prevent.
- **An avatar upload is size-checked in three places, and none of them is
  redundant.** In order: the client (`profile-section.tsx`) refuses by
  `File.size` before the round trip; `uploadAvatar()` refuses by the _declared_
  size before it buffers anything; and then by the real `byteLength` after
  reading, which is the check that holds against a client that lies. On top of
  those, **`next.config.ts` must keep `experimental.serverActions.bodySizeLimit`
  above `AVATAR_MAX_BYTES`.** Next's default caps an action body at 1 MB and
  rejects it _before the action runs_, so with the default the 2 MB limit was
  unreachable and an oversized upload produced **no message at all** — found by
  uploading one, and pinned by a test that compares the two numbers.
- **`src/lib/avatar.ts` imports nothing, like `auth/roles.ts`.** `<UserAvatar>`
  is rendered from client components as well as the server, so anything
  reachable from it reaches the browser bundle. `sharp` and `node:path` live in
  `avatar-storage.ts`, and `src/components/**` importing that module is an
  ESLint `no-restricted-imports` error (`eslint.config.mjs`) rather than a
  comment — the failure would otherwise be an opaque bundler error.
  `<UserAvatar>` is deliberately not `"use client"`: it holds no state and
  next-intl's `useTranslations()` works in both contexts, so it adopts whichever
  one renders it. Two Base UI facts it is written around: `AvatarImage` renders
  **nothing** until a `new window.Image()` load resolves in the browser, so the
  server's first frame is always the initials fallback and jsdom never produces
  an `<img>` at all; and the accessible name lives on the root
  (`role="img"` + a translated `aria-label`) because the two children are never
  both present and the initials would otherwise be announced as the text "AL".
- **The fallback colour solves for contrast; it does not pick a lightness.**
  `colourFor()` hashes the id to a hue and then takes the lightest value that
  still clears 4.6:1 against white. The fixed `hsl(h 55% 45%)` it replaced was
  below AA 4.5:1 for **184 of 360 hues** and bottomed out at 2.26:1 near hue 60
  — with random ids, half of all users looking at an unreadable version of their
  own initials, permanently. Relative luminance is wildly non-uniform across hue
  (green carries 0.7152 of it, blue 0.0722), so no single lightness can serve
  every hue. `avatar.test.ts` asserts the ratio across **all 360 hues**;
  sampling a couple of ids is what let the first version ship.
- **`/login` is the whole unauthenticated UI, and five things about it are
  load-bearing.** It lives at `src/app/login/page.tsx`, deliberately outside
  `(app)`: that group's layout awaits `requireUser()`, so a login form inside it
  would redirect to itself. (1) **`?next=` is validated, never followed as
  given.** `safeNextPath()` in `src/lib/auth/next-path.ts` accepts only a path
  on this origin and falls back to `/`. **It validates the value it returns,
  not the value it received**, and that distinction is the whole guard: the
  first version tested the raw input for a leading `//` and shipped a working
  open redirect anyway, because `URL` normalization _creates_ one —
  `/.//evil.tld` and `/a/..//evil.tld` are single-slash inputs that come out as
  `//evil.tld`, which a browser follows off-site. A new guard therefore belongs
  _below_ the parse. `?next=/login` is refused too, not because it loops (it
  does not: `redirect(LOGIN_PATH)` carries no query, so the next hop reads no
  `next` and stops) but because one pointless hop back to the sign-in page is
  not a destination. The page reads `searchParams` on the **server** and passes the
  checked value to the client component, which is both Next's own advice for a
  Server Component page and the reason no `useSearchParams()` Suspense boundary
  is needed here. (2) **Failures become catalog keys, never Better Auth
  messages** — `passwordErrorKey()`/`passkeyErrorKey()` in
  `src/lib/auth/sign-in-errors.ts` map the library's `error.code` to a
  `NamespaceKey<"auth">`; `error.message` is an English constant baked into the
  library and must never reach a toast. Only the acted-on cases are
  distinguished (wrong credentials; a passkey that was cancelled or does not
  exist), everything else is `signInFailed`. (3) **Passkey is preferred, not
  required**: `window.PublicKeyCredential` is feature-detected in the click
  handler, and both the unsupported and the cancelled path reveal the password
  field rather than leaving a button that does nothing. **WebAuthn itself is
  untestable here** — no unit test can drive an authenticator, so
  `login-form.test.tsx` covers the password path and the _result handling_ of a
  passkey attempt, and the ceremony is only ever exercised by hand.
  (4) **Signed out, the locale comes from `Accept-Language`** — negotiated
  against `["en", "de"]` by `negotiateLocale()` in `src/i18n/locale.ts` and
  applied in `src/i18n/request.ts`'s fallback path, which is the only path a
  request with no session takes. A signed-in user's stored preference still
  wins outright; a header never overrides a choice made in the application.
  (5) **A rejected sign-in call is a caught error, not an escaped one.**
  `@better-fetch/fetch` turns HTTP failures into `{ data, error }` but leaves
  its own `await fetch(...)` unwrapped, so a restarting container _rejects_ —
  and an unhandled rejection there left the form on "Signing in" forever with
  no message, recoverable only by reloading. Both handlers go through
  `attempt()`, which maps a throw to `signInFailed` and clears `busy`.
  And one rule that falls out of (4): **a successful sign-in is a full document
  navigation** (`replaceLocation()` in `src/lib/browser-location.ts`), never
  `router.replace()`. The root layout owns `<html lang>`, the intl provider and
  the theme, and a soft navigation does not re-render it — so the user would
  land inside chrome built for the request _before_ they had an identity. That
  was visible the moment (4) shipped: a German-locale browser signing in to an
  English-preference account got a German sidebar around an English page until
  a manual reload.
- **The default admin: `admin@admin.com` / `admin`, created only when no admin
  exists.** Three things are load-bearing. The check is keyed on **"any user
  holds an admin role"** (`ADMIN_ROLES` from `auth/roles.ts`, the same list the
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
  `getSettings()` still throws. Two hazards live in that repair. It runs behind a
  single **in-flight promise** on `ensureAdminExists()` (cleared when it settles,
  so sequential calls still do real work): without it, two concurrent callers
  both read "no credential" while the first is inside scrypt and mint two
  `credential` rows — which disarms Better Auth's "cannot unlink your last
  account" guard and leaves a way back to the published password. And its
  "can this account sign in" test knows only `accounts.providerId = "credential"`
  and the `passkeys` table: **a phase adding a social provider must widen it**,
  or an admin whose only login is OAuth gets the default password minted back.
- **Theme has two stores:** `localStorage` is authoritative for what is
  _applied_ (next-themes resolves `localStorage.getItem(key) || defaultTheme`);
  the database column is the _portable_ preference that seeds a fresh browser.
  The settings control displays the applied value.
- **Testing: two vitest projects, and the file extension picks one.**
  `vitest.config.ts` declares `test.projects` (the vitest 4 mechanism; the
  `workspace` field is gone), both inheriting the `@` alias via `extends: true`:
  - **`node`** — `environment: "node"`, `include: ["src/**/*.test.ts"]`. The
    real-SQLite library tests above. Keep this glob `.ts`-only. It also carries
    the single `server.deps.inline` entry described under `nextCookies()`
    above — the one place a dependency module is transformed so `vi.mock()` can
    reach an import made inside it.
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
  no-driver-mocks convention above, which is about the database. The same goes
  for `next/headers` and for `@/lib/auth/session` in a `.tsx` test: they stand in
  for a request scope no unit test can boot. Stub the _session_, never the
  derivation — `src/app/(app)/layout.test.tsx` stubs `requireUser()` and then
  calls the real `isAdminRole()`, which is why `auth/roles.ts` is dependency-free.
  A **node** test needing cookies does the honest thing instead: sign in for real
  through `signInCookie()` (`src/lib/auth/test-support.ts`) against a real
  database, and put the result behind a `vi.hoisted()` box that a
  `vi.mock("next/headers", ...)` factory reads (a stub module imported inside the
  factory does not survive `vi.resetModules()`). Messages are never stubbed — a
  test carrying its own message objects would pass while the shipped catalogs
  were broken.

  **`async` server components cannot be rendered by testing-library** — that
  covers `settings/page.tsx` and the `Sections`/`LibrarySummary` data regions,
  which stay untested. Don't reshape production code to make them testable. The
  one case that works is an async component whose _output_ is synchronous:
  `src/app/(app)/layout.tsx` is awaited as a plain function and its result
  handed to `renderWithProviders()` (see `layout.test.tsx`). That is not a
  licence to split a data component in two so it fits.

  What is covered so far is exactly what phase 3's escaped defects needed: one
  `<main>` landmark, no `li` inside `li`, breadcrumbs translating nav segments
  while showing record ids verbatim, the Select trigger's translated label, and
  (phase 4) admin-only navigation hidden from a non-admin.
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
