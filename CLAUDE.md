# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all
differ from your training data. Read the relevant guide in
`node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

# Yana

Self-hosted RSS aggregator. **Next.js 16 / React 19 / TypeScript, SQLite via
Drizzle + better-sqlite3.** One language, one toolchain, one process.

This file is the only agent-instruction file in the repository. There is no
`AGENTS.md` and no per-directory `CLAUDE.md` — everything goes here.

The retired Django implementation that used to live at `old/` has been removed
from the tree entirely — the migration to Next.js is complete (all fifteen
phases; see "Where the work is planned" below) and there is nothing left to
port or cross-check against it. Its history is still in `git log` if a past
behavior ever needs to be reconstructed.

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
│   │       ├── integrations/page.tsx # /integrations — YouTube + Reddit credentials
│   │       ├── ai/page.tsx        # /ai — the active AI provider, its credentials,
│   │       │                      #   and the nine global tuning values
│   │       ├── settings/page.tsx
│   │       └── users/             # admin-only. page.tsx (list), new/, [id]/ (edit +
│   │                              #   delete); each awaits requireAdmin() first
│   ├── components/
│   │   ├── ui/                    # shadcn components (Base UI + Tailwind v4)
│   │   ├── auth/                   # login-form.tsx (passkey first), sign-out-button.tsx
│   │   ├── account/                # profile-, password-, passkey-section.tsx
│   │   ├── settings/               # general-, library-, about-section.tsx
│   │   ├── crud/                   # the reusable list kit phases 8–10 consume:
│   │   │                           #   data-table, pagination, search-filter-bar,
│   │   │                           #   bulk-action-bar, confirm-destructive,
│   │   │                           #   selection.ts, use-list-params.ts
│   │   ├── integrations/           # youtube-section.tsx, reddit-section.tsx and
│   │   │                           #   section-parts.tsx — the `integrations`
│   │   │                           #   binding of ../section-kit.tsx
│   │   ├── ai/                     # provider-section.tsx (the picker + one
│   │   │                           #   provider's credentials), advanced-section.tsx
│   │   │                           #   (the nine numbers, saved as one unit) and
│   │   │                           #   section-parts.tsx — the `ai` binding of
│   │   │                           #   ../section-kit.tsx
│   │   ├── users/                  # the kit, wired to users: users-table.tsx,
│   │   │                           #   user-form.tsx, delete-user-section.tsx,
│   │   │                           #   use-user-impact.ts
│   │   ├── section-kit.tsx         # the credential-card kit, namespace-agnostic:
│   │   │                           #   the keep-existing sentinel, the mask
│   │   │                           #   placeholder, statusBadgeIn(),
│   │   │                           #   reportOutcomeIn() — phase 7's second consumer
│   │   ├── user-avatar.tsx         # image, else initials on a colour from the id
│   │   ├── app-sidebar.tsx         # navigation, from src/lib/nav.ts
│   │   ├── route-breadcrumbs.tsx   # segment-derived breadcrumbs, overridable
│   │   │                           #   per-route by breadcrumb-title.tsx
│   │   ├── breadcrumb-title.tsx    # BreadcrumbTitleProvider/SetBreadcrumbTitle:
│   │   │                           #   lets a detail page register its record's
│   │   │                           #   title for the breadcrumb, replacing the
│   │   │                           #   raw id
│   │   ├── data-skeleton.tsx       # TableRowsSkeleton (a list's <tbody>) and
│   │   │                           #   TableSkeleton (/articles/[id]'s block
│   │   │                           #   tree). NOT a page fallback — see the
│   │   │                           #   streaming-pattern bullet
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
│   │   │   ├── roles.ts           # ADMIN_ROLE(S) + isAdminRole() — imports nothing (pinned)
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
│   │   ├── account/               # queries.ts (getAccountOverview), actions.ts (writes),
│   │   │                          #   result.ts (the account attempt() binding)
│   │   ├── crud/                  # params.ts — ListParams, parseListParams(),
│   │   │                          #   buildListHref(); the URL is the list state
│   │   ├── secrets.ts             # KEEP_EXISTING/mask/resolveSecret — imports nothing
│   │   ├── integrations/          # probe.ts (ProbeResult, the timeout, and the catch
│   │   │                          #   tail all five probes share), youtube.ts
│   │   │                          #   and reddit.ts (live probes), queries.ts
│   │   │                          #   (SERVER-ONLY, masked only), define.ts (the
│   │   │                          #   descriptor: one declaration -> save/test/remove),
│   │   │                          #   actions.ts (the two declarations + the exports),
│   │   │                          #   result.ts (attempt() binding + SaveResult)
│   │   ├── ai/                    # providers.ts (client-safe registry — imports
│   │   │                          #   nothing), bounds.ts (the nine tuning bounds,
│   │   │                          #   read by the form and the schema — likewise),
│   │   │                          #   columns.ts (provider -> columns, and
│   │   │                          #   resolveModel()'s hasDynamicModels split),
│   │   │                          #   probes.ts + openai/anthropic/gemini/mistral/
│   │   │                          #   qwen/deepseek/openrouter.ts (live probes,
│   │   │                          #   SERVER-ONLY by lint rule), queries.ts
│   │   │                          #   (SERVER-ONLY, masked only), actions.ts (seven
│   │   │                          #   defineIntegration() declarations, the active
│   │   │                          #   provider, the nine tuning values,
│   │   │                          #   listOpenrouterModels()), result.ts
│   │   ├── users/                 # fields.ts (client-safe constants — imports only
│   │   │                          #   auth/roles), queries.ts (SERVER-ONLY reads),
│   │   │                          #   actions.ts (writes), result.ts (attempt() binding)
│   │   ├── attempt.ts             # attemptCall() + attemptIn() — the one guard in front of
│   │   │                          #   every server action called from the browser; also
│   │   │                          #   ActionResult/ActionFailure/NoticeResult, the shapes
│   │   │                          #   an action resolves to
│   │   ├── avatar.ts              # initialsFor/colourFor/displayNameFor/avatarUrlFor/
│   │   │                          #   safeAvatarSrc + AVATAR_MAX_* — imports nothing
│   │   ├── avatar-storage.ts      # SERVER-ONLY: processAvatar() (sharp), avatarFilePath(), mediaRoot()
│   │   ├── browser-location.ts    # replaceLocation() — the one hard navigation, and its test seam
│   │   ├── nav.ts                 # NAV_ITEMS + breadcrumbsFor() — single source for both
│   │   ├── settings/               # queries.ts (getSettings + the re-exported currentUserId),
│   │   │                           #   actions.ts (server actions), result.ts (the
│   │   │                           #   settings attempt() binding)
│   │   └── utils.ts               # cn()
│   └── test/                      # TEST-ONLY: shared setup for BOTH vitest projects
│       ├── render.tsx             # jsdom: renderWithProviders() — real catalogs, optional theme
│       ├── next-navigation.ts     # jsdom: usePathname/useRouter stubs + the real unstable_rethrow
│       ├── next-headers.ts        # node: nextHeadersStub() — used by four .test.ts files
│       └── setup.ts               # jsdom: cleanup + matchMedia/localStorage/fetch repair
├── messages/                      # en.json, de.json — must define identical keys (enforced)
├── drizzle/                       # generated migrations + meta/_journal.json
├── drizzle.config.ts              # drizzle-kit config (schema in, drizzle/ out)
├── public/                        # static assets served at /
├── Dockerfile                     # multi-stage, standalone output, runs as uid 1001
├── docker-compose.yml             # dev container (prod build; use `npm run dev` to work)
├── docker-compose.production.yml  # target production shape — what CI redeploys against
├── data/                          # SQLite lives here (gitignored, starts empty)
├── media/                         # article images and feed logos (gitignored, starts empty)
└── docs/superpowers/              # direction records (specs/) and phase plans (plans/)
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

**Before pushing anything, run the same four checks CI runs** — CI fails the
build on any of them, `format:check` included (an unformatted file is a build
failure, not a warning):

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
  `better-sqlite3` in behind it — pinned now by `src/lib/auth/roles.test.ts`,
  not just asserted in a comment.

  Two rules that the phase-4 whole-branch review turned from theory into
  history, because together they could brick an instance permanently:

  - **`role` is a comma-separated _list_, and `isAdminRole()` splits it.** The
    plugin's `hasPermission()` does `(role || defaultRole).split(",")` and
    grants if any part matches, so `"user,admin"` is an administrator to Better
    Auth. Testing the whole string for equality made the application disagree —
    the sidebar hid `/users` from someone the library still let call
    `/admin/list-users`, and `adminExists()` reported "no admin" for an instance
    that had one, so the next boot tried to recreate `admin@admin.com`, hit
    `users_email_unique` and exited 1 **forever**. Parts are deliberately not
    trimmed, because the library does not trim either; agreeing exactly is the
    property, and the test proves it against `/admin/has-permission` rather than
    against a restatement of the rule.
  - **Every `/admin/*` endpoint is in `disabledPaths`** (`ADMIN_PLUGIN_PATHS` in
    `src/lib/auth/server.ts`), and adding one back needs a reason. No phase
    4–13 calls one. Open, `/admin/set-role` was the cheapest way to write that
    comma list; `/admin/create-user` produced users with no `user_settings` row,
    whose `/settings` then threw forever (`getSettings()` does not self-heal,
    and must not start); `/admin/update-user` passes `ctx.body.data`
    (`z.record(z.any(), z.any())`) straight to `internalAdapter.updateUser`,
    which is an arbitrary-column write. `disabledPaths` gates **HTTP routing
    only**, so `auth.api.*` from server code is unaffected — that is how the
    roles test still reaches the plugin's own permission check. The list is
    hand-written because the plugin exports no manifest of its paths, and
    `server.test.ts` compares it against the installed library's source so a
    version bump that adds an endpoint fails a test instead of mounting it.

  What remains is the `role` field and its server-side semantics, above all
  `input: false`, which makes Better Auth answer `FIELD_NOT_ALLOWED` to any
  request body carrying a role.

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
- **Tests:** Vitest, run with `npm test`. **The file extension picks the
  project** — `.test.ts` is the node/real-SQLite one and `.test.tsx` the
  jsdom/component one; the full rule is under "Testing: two vitest projects"
  below, and reading only this bullet is how a `.tsx` test gets written in the
  belief that it runs. New library code
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
  itself, as its first statement**, before any translation or data call. **This
  is a rule to apply, not a list to consult** — a fixed inventory here has
  already drifted twice (once when phase 13's `/api/v1` routes shipped without
  an entry, again when the dashboard's own route joined them), because nothing
  enforces that a new call site gets a new line.
  `grep -rl "await connection()" src/app` is how you find every route that
  currently makes the call — read its output rather than counting it, because
  not every hit is a call site: it also matches the `.test.ts` files that
  assert the call is first, and it matches
  `src/app/api/auth/[...all]/route.ts`, whose comment names the call in order
  to _explain why that route deliberately has none_ (its only segment is
  dynamic, so Next already treats it as dynamic — and the comment says to add
  the call if that ever changes). A new route that reads anything needs its own
  call, in the same commit that adds the read — unless it already awaits a
  Dynamic API, which opts the route out just as well; the routes below are
  exactly that second case, and are listed for the _reason_, not as inventory
  to keep in sync.
  `src/app/(app)/layout.tsx` is exempt because `requireUser()` awaits
  `headers()` before anything touches SQLite; so are
  `src/app/media/avatars/[userId]/route.ts` and
  `src/app/api/feeds/export/route.ts`, for the same reason;
  `src/app/(app)/jobs/[id]/page.tsx` and
  `src/app/api/jobs/[id]/log-stream/route.ts`, likewise (the job live-log
  feature's detail page and its SSE route, both gated by
  `requireUserFreshRole()` before anything else); and so are phase 5's three
  `/users` routes —
  `src/app/(app)/users/page.tsx`, `src/app/(app)/users/new/page.tsx`,
  `src/app/(app)/users/[id]/page.tsx` — where `requireAdmin()` does it. That
  exemption is only worth as much as the
  gate's **position**: it is the first statement of each of those three, ahead
  of `getTranslations()`, `parseListParams()` and every query, which is where
  it has to be anyway — inside a `<Suspense>` boundary its `notFound()` would
  arrive after the first byte and truncate a 200 instead of answering 404. A
  page that authorizes late has already opened the database, and then it needs
  its own `connection()` line like everything else.
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
  late is no longer a thing to remember: **`items` is a _required_ prop on this
  repository's `<Select>`** (`src/components/ui/select.tsx` re-declares Base
  UI's root type with `Required<Pick<…, "items">>`), so omitting it is a
  `npm run typecheck` failure rather than a wrong trigger discovered in a
  browser. The reason it is required has to outlive the guard, because the
  guard only makes you pass _something_: `<Select.Value>` resolves its label
  from `items` alone and never reads `<Select.ItemText>`, so the collapsed
  trigger prints the raw value — `dark`, `user,admin` — while the popup shows
  perfectly translated options, and a test that only opens the popup proves
  nothing about the trigger. Build the list once and render the
  `<SelectItem>`s from it, as `src/components/settings/general-section.tsx`
  and `src/components/users/user-form.tsx` do; assert against the trigger's
  `[data-slot="select-value"]` text, which is what
  `general-section.test.tsx` and `search-filter-bar.test.tsx` do.
  **An option whose value is `""` is legal and is used twice** — the
  filter-clearing entry in `src/components/crud/search-filter-bar.tsx` and
  "None (disabled)" in `src/components/ai/provider-section.tsx`, where it is the
  value `active_ai_provider` stores to switch the AI features off. It needs one
  piece of care, because Base UI's `hasSelectedValue` is
  `stringifyAsValue(value) !== ""` and therefore reads `""` as _nothing
  selected_: `<Select.Value>` prefers its own `placeholder` prop over resolving a
  label whenever nothing is selected, so **passing `placeholder` to a
  `<SelectValue>` whose list contains a `""` entry silently replaces that
  entry's label with it**. Neither call site passes one. (The trigger does get
  `data-placeholder` in that state, so the label renders muted — cosmetic, and
  arguably right for "none".)
  **Driving one from a jsdom test takes a `pointerDown` before the item's
  `click`.** Clicking the trigger opens the popup, as expected. It is the click
  on the _item_ that is dropped: Base UI refuses one it did not see a pointer
  press begin on (`allowMouseSelectionRef` in `select/item/SelectItem`), because
  opening with `alignItemWithTrigger` can place an item under the cursor. So
  `fireEvent.click(item)` alone selects nothing and fires no `onValueChange` —
  which reads as a component that ignored the choice rather than as a test
  driving it wrongly. See `choose()` in
  `src/components/ai/provider-section.test.tsx`.
- **Every user-facing string comes from `messages/en.json` + `messages/de.json`**,
  which must define identical, non-empty key sets. That parity is what
  `src/i18n/messages.test.ts` enforces, and it is **all** it enforces: no test
  can tell that a literal was typed into JSX instead of added to a catalog, and
  it does not check ICU placeholder parity either (a translation dropping
  `{minutes}` fails silently). The rule is a convention with a partial guard,
  not a checked invariant — a component test asserting against `de.json` is
  what actually catches a hard-coded English string.
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
- **The streaming pattern: a loading page shows the real controls, disabled and
  empty — never a grey bar standing in for one.** The rule this replaced was
  "chrome renders synchronously; data regions are async components inside
  `<Suspense>` with fallbacks from `src/components/data-skeleton.tsx`", and it
  drew the line in the wrong place. "Chrome" turned out to mean the heading and
  the card border, so every _control_ counted as data: `/settings` awaited its
  settings row above its JSX, the whole page suspended, and `loading.tsx`
  replaced the theme `<Select>`, the retention `<Input>` and Save with three
  `<Skeleton>` bars. Nothing about a `<Select>`'s existence, its label, its
  help text or its option list depends on the stored value — only which option
  is chosen does — so all of it was being hidden to wait for one number, and
  then the page visibly reflowed as bars turned into controls. The 2026-08-16
  streaming-controls migration moved the boundary from "the section" to "the
  value inside the control".

  **The shape is a triple, and the fallback is the same component as the
  resolved render.** The page calls its query **without `await`** and passes the
  promise down; the client module exports `…Form` (presentational, its value
  props optional, plus an optional `pending` defaulting to `false`), keeps a
  private `…Resolved` that calls `use(promise)` and renders `…Form` with the
  real values, and exports `…Section({ promise })` whose
  `<Suspense fallback={<…Form pending />}>` wraps it.
  `src/components/settings/library-section.tsx` is the smallest reference;
  `src/components/integrations/youtube-section.tsx` and
  `src/components/ai/provider-section.tsx` are the two that carry every hard
  case. Because the fallback and the resolved render are the _same component_,
  a control cannot appear or disappear across the transition — only its value
  fills in. That property is what the arrangement buys, and it is lost the
  moment the fallback is anything else.

  **A pending control passes `disabled` and omits `value` — never
  `defaultValue`.** `defaultValue` seeds an uncontrolled input once and is
  ignored on every later render, so the field would sit empty _forever_ after
  the real value arrived, looking exactly like a loaded-and-empty field; the
  operator then saves the blank over a stored setting. And on a Base UI
  `<Select>`, **do not reach for `value=""` either**: `""` is a legal,
  meaningful value here — it is `/ai`'s "None (disabled)" entry, the one
  `active_ai_provider` stores to switch the AI features off (see the Base UI
  bullet above) — so a pending picker showing `""` is not "nothing known yet",
  it is an assertion that AI is switched off, made before anything was read.
  Omit the prop and let the trigger render its placeholder state. The pending
  branch in `provider-section.tsx` is commented at exactly that line.

  **A `<Skeleton>` survives only where the _shape_ is unknowable, not merely the
  value, and the list is four places.** A table body's row count
  (`TableRowsSkeleton` in `src/components/data-skeleton.tsx`, the fallback under
  a real `<SearchFilterBar>`, a real bulk bar and a real `<thead>` on all five
  list routes); `/account`'s passkey list and its device list; the dashboard's
  stat _numbers_ (`src/components/dashboard/stat-cards.tsx` — a count has no
  honest empty state, `0` is a lie and blank is a layout jump). Each of those
  four is commented where it lives. The one remaining `TableSkeleton` call site
  is `/articles/[id]`'s "Content" section, whose block tree likewise has no form
  to mirror. `CardSkeleton` is gone: every card that used one now renders itself
  in a `pending` state.

  **Every route keeps its `loading.tsx`, rendering that same real chassis, and
  this is the part that looks redundant and is not.** Server-side streaming
  makes the _first_ paint of a route correct, but `loading.tsx` is what Next
  renders during a **client-side soft navigation**, while the destination
  segment's RSC payload is still crossing the network — no amount of server-side
  `<Suspense>` can remove that latency, because the browser has nothing from the
  new route yet. And a deleted `loading.tsx` does not mean "no fallback": Next
  walks up to the nearest ancestor's, so it means _somebody else's_ fallback.
  That is how `/feeds/new` used to show the feeds **table** while loading a
  feeds **form**. `src/app/(app)/loading.tsx` is now reachable only for `/`
  itself, and stays as the backstop for a segment that forgets one.

  **Testing a fallback:** `loading.tsx` is an async Server Component, which
  testing-library cannot render — but its _output_ is synchronous, so
  `renderWithProviders(await Loading())` works, the same narrow exception
  `src/app/(app)/layout.test.tsx` already uses (see "Testing: two vitest
  projects"; this is not a licence to split a data component so it fits). One
  stub is needed: under Vitest, `next-intl/server` resolves to next-intl's
  non-RSC build, where `getTranslations()` throws "not supported in Client
  Components" the instant it is called. Each `loading.test.tsx` therefore mocks
  that module with `createTranslator()` — the client-safe factory the real
  implementation is built on — pointed at the **real `messages/en.json`**. That
  does not violate "messages are never stubbed": the catalog is the shipped one,
  and only the request-scoped plumbing around it is replaced. The assertion that
  matters in each is `document.querySelector('[data-slot="skeleton"]')` being
  `null`, so a regression back to grey bars fails a test instead of being
  noticed in a browser.

  **A shared `<PageTitle>` was considered and rejected — do not re-attempt it.**
  Every page still opens with `await getTranslations()` for its heading, which
  is one per-request-cached read the page body genuinely waits on, and the
  obvious cleanup is a component that takes a namespace and a key. It cannot be
  typed: making the namespace a type parameter while keeping catalog keys
  compiler-checked hits the exact wall documented on
  `src/components/section-kit.tsx` — TypeScript cannot prove a literal is a
  member of `NamespaceKey<Namespace>` while `Namespace` is still a parameter —
  and the only way through is a cast at a `t()` call site, which is precisely
  what the `AppConfig` augmentation exists to prevent. A cast there would be
  invisible until a renamed key shipped as a raw string in the UI. So pages keep
  their own `await getTranslations()`, deliberately.

  All of the above still sits **inside an error boundary** — once the shell has
  flushed its first byte the response status is already 200 and cannot become a
  5xx, so a throw inside a Suspense boundary with no error boundary above it
  just truncates the stream. `(app)/error.tsx` is that boundary for every route
  in the group; a page adds a second one only if it wants a narrower blast
  radius. There are **three** documented exceptions to "chrome never waits on
  data", in two files:
  - **`src/app/layout.tsx`** resolves the locale (and the theme) through
    `getSettings()`. A cookie read that usually needs no query at all.
  - **`src/app/(app)/layout.tsx`** awaits `requireUser()` — cookie-cached, and
    the sidebar cannot render before it, because which items it contains
    depends on the answer. This is also the last point at which a `redirect()`
    can still change the response; after the first byte flushes it cannot.
  - **and then `currentUserRow()` in the same file**, which is a _genuine
    indexed read on every page render_, not a cookie read. It is here because
    the footer must show what the last server action wrote and the session
    cannot (see "Displaying a user's own columns" below). Do not describe the
    (app) layout as "a cookie read plus at most one indexed query" — it is a
    cookie read **and** one indexed query, unconditionally. A fourth exception
    needs the same argument made explicitly, not an appeal to this list.

  **Whatever decides the response _status_ is awaited in the page body, never
  inside a `<Suspense>`.** `notFound()`, `redirect()` and `forbidden()` can only
  produce their status while the response is still open; inside a boundary,
  after the shell has flushed, they truncate a 200 instead. So a detail route
  awaits its row at the top and has no data region at all —
  `src/app/(app)/users/[id]/page.tsx` is the precedent, and phases 9–11 each add
  one. Two things fall out of it. The `<Suspense>` a list page keeps is for rows
  whose _absence_ is an empty table rather than a 404
  (`src/app/(app)/users/page.tsx`), and its gate still sits above the boundary.
  And that same top-of-page `await` is what opts the route out of prerendering,
  so it needs no `connection()` call — see the `connection()` bullet, which
  lists it.

  **The streaming-controls migration made this rule _more_ load-bearing, not
  less, and it caught a live violation on the way.** Moving reads out of page
  bodies and into unawaited promises is exactly the refactor that tempts an
  agent to move the record read too — and `/articles/[id]` had already made
  that mistake before this migration found it: `getArticle()` was being awaited
  inside a `GeneralSection` that was itself wrapped in a `<Suspense>`, so
  `notFound()` for a missing (or someone else's) article fired _after_ the shell
  had flushed a 200 and truncated the stream instead of answering 404. **The
  record read that decides the status is the one thing that must stay awaited at
  the top of the page**, even though it is the read most worth streaming; the
  other reads on the same page (`/articles/[id]`'s feed list and block tree)
  decide nothing and are handed down unawaited. `src/app/(app)/*/[id]/page.test.ts`
  now pins all four detail routes — articles, feeds, tags, users — by driving a
  nonexistent and an unowned id through the page function and asserting it
  rejects with Next's `NEXT_HTTP_ERROR_FALLBACK;404` sentinel, which is the only
  externally visible trace `notFound()` leaves. A read that drifts back into a
  boundary fails those tests rather than silently serving a truncated 200.

  **A fallback is a Server Component, so it may not hand a Client Component a
  function — and getting this wrong fails only on a cold start.** Every
  `<Suspense fallback>` and every `loading.tsx` here renders a `"use client"`
  component — now the section's own `…Form` with `pending`, previously a
  separate `…Shell`. React has to serialize each prop across the RSC boundary
  and a closure is not serializable (only a Server Action is), so
  `onSubmit={(event) => event.preventDefault()}` throws
  `Event handlers cannot be passed to Client Component props` — replacing the
  whole page with `(app)/error.tsx`. It is invisible in normal use because a
  fallback is only committed when the read is slow enough to suspend: the first
  visit after a restart broke, every reload after it looked perfect. `/ai`,
  `/account` and `/integrations` all shipped it. **The fix is always the same:
  the client component declares `onSubmit` optional and defaults it to the
  no-op inside its own `"use client"` module, and the fallback omits the prop
  entirely** (`AdvancedSectionShell` in
  `src/components/ai/advanced-section.tsx` is the surviving reference — its
  `onSubmit = (event) => event.preventDefault()` default parameter, and
  `<AdvancedSectionForm>`'s `pending` branch passing `undefined`).
  `tsc` cannot see the hazard and no jsdom test can either —
  testing-library never runs the flight serializer — so the guard is
  `src/app/server-component-props.test.ts`, a specifier-style tripwire that
  fails on any `on[A-Z]…={` prop in a file under `src/app/` that is not itself
  a Client Component.

- **Identity comes from the session: `currentUser()`, `requireUser()`,
  `requireAdmin()`, `requireUserFreshRole()` and `currentUserId()` in
  `src/lib/auth/session.ts`.**
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

  **`requireUserFreshRole()` is a third category the rule above doesn't name on
  its own: fresh role, no admin-only gate.** `requireAdmin()` answers "is this
  an admin, yes or no, and refuse everyone else" — but `/jobs`, `/jobs/[id]` and
  the log-stream route need to keep serving a non-admin (filtered to their own
  rows) while still telling admin from non-admin correctly, right now, to decide
  _what_ to show. Reaching for `requireUser()` and then checking `isAdminRole()`
  on its result would silently reintroduce the exact bug `requireAdmin()`'s
  `disableCookieCache: true` already exists to prevent, because `requireUser()`
  answers from the five-minute session cookie cache: an administrator demoted
  through `/users` would keep cross-user job visibility for up to five minutes
  afterward. `requireUserFreshRole()` reads the session the same way
  `requireAdmin()` does — `disableCookieCache: true` — but returns the user
  instead of gating on their role, so a caller can branch on a role that is
  never stale. Use `requireUser()` for pure identity where staleness is
  harmless, `requireAdmin()` when a non-admin should be flatly refused (404),
  and `requireUserFreshRole()` when a non-admin is still owed a (filtered)
  response but the admin/non-admin distinction itself must be current.

- **`jobs.userId` is the ownership model for background jobs, and it is
  nullable on purpose.** Most jobs belong to the user who triggered them
  (`aggregate`, `feed.logo`, `feed.restore`, `article.reload`), but `retention`
  runs once per boot across every user in a single execution and owns none of
  them individually — for that kind, and that kind alone, `userId` is `null`.
  `/jobs`, `/jobs/[id]` and `src/app/api/jobs/[id]/log-stream/route.ts` all
  filter a non-admin to `jobs.userId = user.id` (via `requireUserFreshRole()`,
  above); an admin sees every row, ownerless ones included. `null` is not "no
  filter" from a non-admin's perspective — a non-admin who owns nothing simply
  sees an empty list, never someone else's job and never the ownerless one.
  `src/lib/jobs/log-bus.ts`'s pub/sub is deliberately not part of this: it is
  jobId-keyed, not user-keyed, and enforces no ownership of its own (see its
  module doc comment) — the filtering above is what stands between it and a
  non-admin subscribing to a job id that isn't theirs.
- **Each feed's own `updateIntervalMinutes`/`concurrency` columns replaced a
  global setting and a hard-coded constant, respectively.**
  `feeds.updateIntervalMinutes` (default `30`; `0` disables automatic updates
  for that feed) is read directly by `scheduler.ts`'s `tick()` — there is no
  longer a `userSettings` fallback or join. `feeds.concurrency` (default `4`)
  flows into `BaseAggregator.concurrency` via the same `feed.concurrency ?? 4`
  pattern `dailyLimit` already used, and is what the five
  `mapWithConcurrency(...)` call sites (`website.ts`, `youtube/aggregator.ts`,
  `reddit/aggregator.ts`) read instead of the retired
  `ARTICLE_ENRICHMENT_CONCURRENCY` constant. Both are pre-filled in the feed
  form from `AggregatorSpec.recommendedIntervalMinutes`/`recommendedConcurrency`
  (`src/lib/aggregators/specs.ts`) on create and on aggregator switch — a
  starting point, not an enforced limit, freely editable per feed afterward.
- **`feeds.maxArticleAgeDays` (default `30`) is an ingestion filter, not a
  retention policy — that's `userSettings.articleRetentionDays` (default
  `60`), a separate column enforced by the nightly `retention` job. This one
  is read by `BaseAggregator.filterArticles()` (`src/lib/aggregators/base.ts`)
  before an aggregation run's articles are ever enriched or saved: anything
  older than `this.maxArticleAgeDays` (`feed.maxArticleAgeDays ?? 30`, same
  pattern as `dailyLimit`/`concurrency`) is dropped up front. `0` disables the
  filter entirely, the same meaning `0` has on `updateIntervalMinutes` — a
  feed whose source is a deliberate backlog (a podcast's back-catalogue, a
  comic's archive) needs that escape hatch, or a first aggregation run would
  drop everything older than 30 days on the very fetch meant to backfill it.
  Unlike `updateIntervalMinutes`/`concurrency`, there's no per-aggregator
  recommendation in `specs.ts` — every aggregator starts at the same flat
  `30`, freely editable per feed afterward.
- **An aggregated article is only rewritten when its content actually changed**,
  decided by `articles.contentHash` (`articleContentHash()` in
  `src/lib/aggregators/content-hash.ts`). Three things about that hash are
  load-bearing and each was a real trap: it covers the feed's **own** `date`,
  never the stored one, because the handler's `raw.date || new Date()` fallback
  would otherwise make an undated feed re-hash on every run and never settle
  (which is why the update branch writes `rawDate ?? existing.date` rather than
  re-stamping `new Date()` — the column and the hash have to agree); it covers
  **both** `content || raw_content` (what the blocks are parsed from) and
  `raw_content || content` (what the column stores), which are two different
  expressions over the same item; and it is written **last**, in its own
  transaction after `writeBlocks()`, so a stored hash means the row _and_ its
  block tree are current, and a crash anywhere above leaves it stale or null so
  the next run redoes the work. The payoff is not only local I/O:
  `articles.updatedAt` carries `$onUpdate`, so an unconditional rewrite put
  every unchanged article back into `/api/v1`'s sync `updated` stream on every
  aggregation cycle. A `null` hash means "changed" — every row predating the
  column settles after one pass, and no backfill exists.

  **The invariant binds every writer, not just the aggregator: anything that
  changes an article's content must set `contentHash` to null** (or recompute
  it). A stale hash does not merely go out of date — it makes the aggregate
  handler skip that row _forever_, because the hash it computes from the
  unchanged feed item keeps matching. Two writers learned this in review and now
  null it explicitly: `src/lib/jobs/handlers/reload.ts` in **both** branches — a
  _failed_ reload writes an error notice, which without this would have been
  permanent, where it used to be replaced by the real article on the very next
  cycle — and `updateArticle()` in `src/lib/articles/actions.ts`, which writes
  `name` and `date` (both fingerprint inputs) and `feedId` (half the key the
  handler looks a row up by). Writers that only flip `read`/`starred` must leave
  it alone: nothing about the content changed, and nulling it would force a
  pointless full rewrite on the next cycle. The same trap waits for **any future
  change to `parseBlocks`/`plainTextOf`** — existing articles would never be
  re-parsed, where they used to be re-derived every cycle. The full statement is
  the `contentHash` comment in `src/lib/db/schema/articles.ts`; this is its
  summary, not a second version of it.

- **Article search goes through the `articles_fts` FTS5 external-content table,
  via `toFtsQuery()`** (`src/lib/articles/search-query.ts`). It replaced a
  `LIKE '%term%'` over `plainText` — the largest column on the table — which
  full-scanned once for the rows and again for the `count()`. Five things about
  it:
  - **Every token is quoted**, with any embedded quote doubled (FTS5's own
    escape), so nothing a user types reaches the FTS5 parser as syntax: `NOT`,
    `OR`, `name:`, `*` and `^` are all just text afterward. An unquoted term is
    not merely a possible syntax error — it is a way to steer the query, which a
    search box must never be.
  - **Control characters are stripped _before_ quoting, because quoting does not
    save them.** FTS5 parses the match expression as a C string, so a NUL inside
    quotes ends it early and raises `unterminated string` — a 500 from
    `?q=%00`, reachable by anyone who can type a URL. There is no escape for it.
    Found by fuzzing the search input, not by reasoning about it.
  - **The table is deliberately absent from `src/lib/db/schema.ts`.** Drizzle has
    no virtual-table support, and drizzle-kit diffs against its own snapshot, so
    a table it never knew about is never dropped. Its three triggers are what
    keep it current, and the `'delete'` command rows are mandatory for an
    external-content table — a plain `DELETE FROM articles_fts` corrupts the
    index rather than emptying it.
  - **The `AFTER UPDATE` trigger carries a `WHEN` guard, and it is
    load-bearing**: `WHEN old.name IS NOT new.name OR old.plain_text IS NOT
new.plain_text`. Without it the trigger fires on _every_ column write —
    `read`/`starred` toggles and the separate `content_hash` writes included —
    and each firing re-tokenizes the whole article body twice (the `'delete'`
    command row plus the reinsert). "Mark all read" over a few thousand articles
    became thousands of full-body reindexes. It is pinned by a test that
    fingerprints FTS5's `articles_fts_data` shadow table, because nothing
    visible through `articles_fts` itself can tell "not reindexed" from "deleted
    and reinserted identically".
  - **Two behaviour changes, neither of them a regression.** FTS5 matches token
    prefixes where `LIKE` matched mid-word: `wind` still finds `Windows`,
    `ndows` no longer does. And a multi-word query was an adjacency match within
    a single column (`LIKE '%hello world%'`) and is now an unordered AND across
    `name` and `plain_text` — which widens results rather than losing any, so
    nothing broke, but it is not what the prefix sentence describes and someone
    comparing the two will notice.

- **Error-notification email has two channels, and they answer different
  questions.** `notifyAdmins()` (`src/lib/email/error-notifications.ts`) is "is
  this instance healthy" — it fires from `src/lib/jobs/worker.ts` on a fatal
  worker-loop crash and from `src/lib/jobs/scheduler.ts` on a tick failure, and
  it mails **every user whose role satisfies `isAdminRole()`** — `flushAdmins()`
  filters on role alone and never reads `users.banned`/`banExpires`, so a
  banned admin still gets mailed, unlike `isUsableAdmin()` in
  `src/lib/auth/bootstrap.ts`'s admin-bootstrap check, a different path this
  feature does not call — because those failures have no single owner and
  every admin needs to know the whole instance may be stuck.
  `notifyJobFailure(userId, entry)`
  (called from `src/lib/jobs/queue.ts` on a job's terminal `failed` outcome) is
  "did my job fail" — it mails the **job's own owner** at `jobs.userId`, not
  the admin list, because a feed-aggregation or article-reload failure is that
  user's problem, not an instance-health signal; only when `userId` is `null`
  (an ownerless job, e.g. `retention`) does it fall back to the admin channel,
  for the same "no single owner" reason `notifyAdmins()` exists. Each recipient
  gets one locale-rendered digest via `renderDigest()`
  (`src/lib/email/digest.ts`), read from their own `userSettings.language`, not
  the caller's.
  **Every channel debounces and bundles for two minutes** (`ERROR_EMAIL_DEBOUNCE_MS`,
  default `120_000`) **before sending anything**, keyed per admin-vs-per-user
  channel (`"__admin__"` or the job owner's id) — a `setTimeout` starts only
  when an entry lands in an empty bucket; every entry that arrives before it
  fires just appends to the same bucket and rides the one send. Without this, a
  crash loop (the worker restarting and immediately re-crashing, or a burst of
  jobs failing for the same root cause) would mail one message per failure
  instead of one digest listing all of them. This bundles a _burst within one
  window_ into a single email; it is not cross-window suppression or backoff
  — a failure recurring every tick still sends one email per debounce window,
  indefinitely (720/day at the default 2-minute window). The timer is a
  bare `setTimeout` outside any request scope, so `flush` is wrapped in
  `.catch()` at the call site: an unhandled rejection there would be a Node
  warning with no request to attribute it to.
  **`SMTP_HOST` unset is the default, and it disables the feature rather than
  erroring** — `sendMail()` (`src/lib/email/client.ts`) logs
  `[email] SMTP not configured; would have sent to …` and returns instead of
  throwing, because this repo has no mail transport by default (see the
  self-registration bullet above) and a self-hosted instance that never set
  one up must keep running exactly as before, not fail its worker loop trying
  to report that the worker loop failed. The full env var list, all optional
  except the one that turns the feature on:
  `SMTP_HOST` (unset = feature off), `SMTP_PORT` (default `587`), `SMTP_SECURE`
  (`"true"` string check, default `false`), `SMTP_USER`/`SMTP_PASSWORD` (auth
  omitted entirely when `SMTP_USER` is unset, rather than sent empty),
  `EMAIL_FROM` (default `yana@localhost`), and `ERROR_EMAIL_DEBOUNCE_MS`
  (default `120000`, above). Design record:
  `docs/superpowers/specs/2026-08-05-error-notification-emails-design.md`.
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
  a TypeError it does not catch. Build the stub from
  `nextHeadersStub()` in `src/test/next-headers.ts` rather than typing it out
  again, which is what keeps that rule from being four copies of itself.
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
- **No server action is ever awaited bare from a client component.** An action
  can fail _without returning_ — Next refusing a body over `bodySizeLimit`, a
  dropped connection, the container restarting mid-request — and an unhandled
  rejection inside a `useTransition` scope escalates to the nearest error
  boundary, which on `/account` replaces the whole page (and the half-typed
  form) with "Something went wrong". Every call goes through `attempt()`, so
  treat a bare `await someAction(...)` in a client component as a defect on
  sight.

  **There is one implementation, in `src/lib/attempt.ts`, and it is
  namespace-parameterized.** Phase 5 unified what had become two copies with one
  name (`src/lib/account/result.ts` and `src/components/auth/login-form.tsx`,
  whose namesake exists because `@better-fetch/fetch` leaves its own `fetch`
  unwrapped) before phase 5's own three call sites made it five. Two layers:
  - **`attemptCall(call, { label, sessionProbe })`** knows no catalog. It runs
    the call, catches, and returns `{ status: "returned", result }` or
    `{ status: "rejected", sessionEnded }`. The CRUD kit's two backstops
    (`confirm-destructive.tsx`, `bulk-action-bar.tsx`) call it directly, because
    a generic component has no namespace to report a key in — and
    `login-form.tsx` calls it with **`sessionProbe: "skip"`**, the only place
    that does: `/login` is where a caller with no session is supposed to be, so
    probing there would point the sign-in page at itself.
  - **`attemptIn(namespace, { sessionEnded, requestFailed })`** binds that to
    one catalog and returns the `attempt()` components import — once per
    feature, in `result.ts` beside that feature's `actions.ts`. There are five:
    `account`, `users`, `integrations`, `ai` and `settings` — the last added
    late, because `/settings` predates `attempt()` and phase 3 shipped both of
    its sections calling their actions bare.
    The two keys are spelled out rather than derived because TypeScript cannot
    prove a literal is a member of `NamespaceKey<Namespace>` while `Namespace`
    is still a type parameter, and a cast there is exactly what this convention
    exists to avoid. `errorKey` therefore stays checked **per catalog**, and the
    failure arm's `ok` is the literal `false` so `if (result.ok)` narrows back
    to the action's own type — an action reporting an `id` or a `deleted` count
    does not lose it by being wrapped.

  Three things happen in that catch and the **order matters**:
  - **`unstable_rethrow(error)` first.** Next's action reducer rejects the
    promise with its own control-flow errors on purpose, so a `redirect()`,
    `notFound()` or `forbidden()` called _inside_ an action arrives here as a
    rejection. Caught, it became a stray "the server did not answer" toast
    riding out on a navigation that was working perfectly.
  - **Then "did the session end?", asked of the server.** The proxy answers a
    cookie-less action POST with a `307 → /login`, the browser follows it, the
    client gets HTML where an RSC payload should be, and the reducer throws —
    indistinguishable from a network failure, which is what the user used to be
    told while sitting on a signed-out page with Save re-toasting forever.
    `attempt()` probes `/api/auth/get-session` (public in the proxy, answers
    `null` when there is none) rather than pattern-matching a framework error
    string, and on "no session" navigates to `/login?next=…`. **`unstable_rethrow`
    does not cover this** — it is a parse failure, not one of Next's
    control-flow errors. A probe that cannot be answered still means the
    network.
  - **Otherwise `requestFailed`,** deliberately distinct from `saveFailed`:
    "the server said no" and "the server never answered" want different advice.

- **An action that enqueues background work reports the work, not the
  enqueueing.** `enqueueRun()` (`src/lib/jobs/queue.ts`) groups the jobs it
  inserts under one `runs` row and hands the caller its id; `getRunStatus()`
  (`src/lib/jobs/actions.ts`) is the session-authenticated poll target for it
  (unknown id and someone else's id both answer `null`, so it enumerates
  nothing); and **`waitForRun()` + `reportRunOutcome()`
  (`src/lib/jobs/`) are the pair every long-running dashboard action uses** — a
  spinner for as long as the run actually takes, then exactly one toast carrying
  the run's real `completedJobs`/`failedJobs`. The instant "N enqueued" toast
  they replaced was a lie about the only thing the operator wanted to know, and
  a count taken from the ids _submitted_ is the same lie (rows can vanish
  between the click and the insert) — read it from the outcome. Two call-site
  obligations: the poll is a bare `await` away from a defect, so `waitForRun()`
  goes through `attemptCall()` on every poll; and a bulk caller must **not**
  clear its selection until the outcome is reported, because `<BulkActionBar>`
  renders `null` at `count === 0` and would take the spinner with it.
  **The poll is unbounded on purpose** — no timeout, decided rather than
  overlooked. The worker claims one job at a time, so the runs most worth
  tracking are the long ones, and a poll that gives up produces silence for
  exactly those; navigating away unmounts the component and abandons the promise
  chain, which costs nothing. So `RunOutcome`'s failure arms are real failures
  only (`"request-failed"`, `"not-found"`) and every one of them toasts.

- **There is a way out, and it is a full document navigation.**
  `<SignOutButton>` (`src/components/auth/sign-out-button.tsx`) sits in the
  sidebar footer under the profile entry — the only chrome on every route in
  the group, and next to the identity it ends. It uses `replaceLocation()` for
  exactly the reason sign-_in_ does: the root layout owns `<html lang>`, the
  intl provider and the theme, identity changes at this moment and the locale
  changes with it (a signed-out request negotiates `Accept-Language`), and a
  soft navigation would land the user on `/login` inside chrome built for the
  person who just left. Both failure shapes clear `busy` — a dead sign-out
  button is the one failure that leaves a user with no way out at all.
- **A component gets the columns it renders, never the row.** `<AppSidebar>`
  and `<ProfileSection>` both take the five `AvatarUser` fields, not a `User`:
  the row also carries `role`, the three ban columns, `emailVerified` and the
  timestamps, and passing it whole serializes all of them into the RSC payload
  of every page that renders it.
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
    Turbopack). It is the first line of defence rather than the only one: CI
    now boots `next dev` and curls `/health`, `/login` and `/`, which is what
    catches the whole class at the cost of one job step — and `next build`
    never compiles the edge hook at all, so the image jobs would not.
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
- **`runStartupTasks()` sets `dns.setDefaultResultOrder("ipv4first")`
  process-wide, as its first statement.** Node's default DNS order is
  `verbatim`; inside Docker's default bridge network (no IPv6 route), a
  dual-stack source whose AAAA record sorts first makes every `fetch()` —
  including every aggregator's — pay for a failed IPv6 connection attempt
  before falling back to IPv4. This is a global Node setting, not scoped to
  any one caller.
- **`startWorker()` (`src/lib/jobs/worker.ts`) runs `WORKER_CONCURRENCY`
  independent `runWorkerLoop()` instances in this one process, default `4`.**
  `4` matches `feeds.concurrency`'s own default (`schema/feeds.ts`) — no
  reason job-level throughput should be more conservative than the per-feed
  article concurrency this same process already runs unattended. Each loop
  polls and executes jobs on its own; running several concurrently is safe
  only because `claim()`'s `UPDATE ... WHERE status = 'pending'` (inside
  `BEGIN IMMEDIATE` — see `queue.ts`) is a compare-and-swap, so two loops
  racing for the same row can never both win it. An invalid or unset
  `WORKER_CONCURRENCY` falls back to `4` rather than throwing, and a host that
  cannot sustain that (a single-core box) can set it lower. `resetOrphaned()`
  still runs exactly once per process, before any loop starts — correct
  because every loop this process spawns starts after that point, so there is
  no in-flight claim of this process's own for it to clobber. **This
  reasoning does not extend to running `startWorker()` from more than one
  process** (e.g. a second container/replica): `resetOrphaned(new Date())`
  resets every `running` row with `startedAt` at or before _now_, which is
  only safe when a `running` row can only mean "orphaned by a crashed prior
  process" — a second live process would have its own boot yank away a job
  the first process is legitimately still executing. Multi-process workers
  need that scoped (e.g. tagging claimed rows with an owning process/worker
  id) before they are safe; today there is exactly one app service in
  `docker-compose.yml`/`docker-compose.production.yml`, and that stays true.
- **`claim()` pre-checks for a pending job outside the write transaction, and
  the idle poll is jittered.** Those four loops at a 2s poll took the exclusive
  `BEGIN IMMEDIATE` lock twice a second on a completely idle instance, forever,
  purely to discover there was nothing to do — and all four woke in the same
  tick, because `startWorker()` launches them together and they slept identical
  amounts. The pre-check is **advisory only**: the transaction still re-selects
  and still guards its `UPDATE` on `status = 'pending'`, which is the
  compare-and-swap the bullet above rests on, so a row that appears in the
  pre-check and is won by another loop before this one gets the lock is handled
  exactly as it was before (`result.changes !== 1` → `null`). Do not "simplify"
  either half away: the pre-check is not a redundant duplicate of the
  transaction's select, and `POLL_JITTER` (a quarter either side of the poll
  interval, in `worker.ts`) is not decorative randomness. `progress()` likewise
  reads before writing and returns without a transaction when the clamped value
  already matches — the aggregate handler calls it once per article, but
  `80 + floor(i / total * 20)` takes only twenty distinct values, so on a
  200-article feed all but twenty of those calls were a write lock taken to
  store the number already sitting in the column. One index goes with this:
  `jobs_claim_idx` declares `desc(priority), asc(runAt), asc(id)` to mirror
  `claim()`'s `ORDER BY` exactly, because SQLite can only satisfy an ORDER BY
  from an index by walking it forwards or entirely backwards — an all-ascending
  index against a mixed-direction sort falls back to a temp B-tree. Change the
  sort and the index directions together, or the index silently stops serving
  it.
- **Route protection is `src/proxy.ts` — Next 16's rename of `middleware.ts`,
  and it is not cosmetic.** The old name still works but warns on every build,
  and a Proxy defaults to the **Node.js** runtime where middleware was compiled
  for the edge (the `runtime` segment config is rejected in this file). Both the
  file name and the exported function name (`proxy`, not `middleware`) have to
  change together: half a rename is a file Next silently never calls, which
  would leave every route unguarded with nothing failing. The doc is
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`.
  Four rules:
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
    exempted either, and the reason has since become concrete rather than
    pre-emptive: the exemption was written when nothing served the directory,
    and `src/app/media/avatars/[userId]/route.ts` (next bullet) now does — so
    keeping it would be a hole, not merely coverage removed in advance. Naming
    `public/`'s three files instead (`(?!file\.svg|globe\.svg|window\.svg)`)
    is legal — a matcher entry is a regex — and is rejected only because it
    needs editing every time a file is added there.
  - **`/api/v1` is in `PUBLIC_PREFIXES` too, and it is not exempt from
    authentication — it authenticates itself.** The native client sends a
    Bearer token, never a cookie, and this proxy's check is `getSessionCookie()`
    only: it structurally cannot evaluate a Bearer token, the same reason a
    proxy cannot reach the database. Every `/api/v1/**` route calls
    `requireApiUser()` (`@/lib/api/auth`) itself as its own real auth gate — the
    same "authenticates itself, nothing above it does" shape as the `media/`
    route handler below, except here the gate lives inside every route rather
    than in one shared handler. Without this entry a Bearer-only request has no
    session cookie by construction, so this proxy 307'd it to `/login` before
    its route handler ever ran, making the whole API unreachable — caught only
    because no request ever got far enough to hit the ownership checks and
    tests those routes carry. `PUBLIC_PREFIXES` is therefore no longer "the
    entire unauthenticated surface of the application" — it is every route that
    must reach its handler unblocked by this proxy's cookie check, whether
    because it is genuinely unauthenticated or because, like `/api/v1`, it
    checks a different credential entirely.
  - **`/webview-session` joined `PUBLIC_PREFIXES` for the same
    "authenticates itself" reason as `/api/v1`, not the "genuinely
    unauthenticated" reason `/login`/`/health` are.** See the webview session
    bootstrap bullet under "Beyond the fifteen phases" for the route itself;
    the proxy-specific trap is that this one shipped without the entry at
    first, since every task in that plan tested `GET()` directly and never
    went through `proxy()` at all. Without the exemption the request 307'd to
    `/login` before the handler ran, and — worse than the generic `/api/v1`
    case — that redirect clears `url.search`, so the one-time `?token=` the
    whole request exists to carry was silently discarded, with no way for
    even a manual retry to recover it. `src/proxy.test.ts`'s
    `it.each(...)("leaves %s reachable without a session", ...)` block now
    includes `/webview-session` precisely so a future regression here fails a
    proxy test instead of only failing in production.
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
  comment — the failure would otherwise be an opaque bundler error. The
  "imports nothing" half is pinned the same way, by the specifier tripwire in
  `src/lib/avatar.test.ts`; that ESLint rule does not cover it, because it
  forbids a **component** importing storage, not this module doing it on their
  behalf.
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
- **A stored provider credential leaves the server masked or not at all.** This
  is `/integrations`' whole contract, and it is a **protocol between three
  files**, not a habit: `getIntegrationStatus()` (`src/lib/integrations/queries.ts`)
  projects every secret through `mask()` and names the field `…Masked`; the
  section renders that mask as the input's **`placeholder`** with the value
  starting empty; and an empty submission means **keep what is stored**, which
  `resolveSecret()` (`src/lib/secrets.ts`) turns back into the real value on the
  server. Break any one part and the other two fail quietly. Two consequences a
  phase adding a provider inherits:
  - **The projection type is the boundary.** A client component's props are the
    page's RSC payload, which is plain text in a browser's network tab, so
    `IntegrationStatus` is typed to have no field that _could_ hold a secret.
    Add a `…Masked` field; never a raw one, and never "just for a moment".
  - **`KEEP_EXISTING` is a NUL byte plus `keep`, and binding it to an
    `<input value>` breaks it.** No legitimate key contains a NUL, which is what
    makes it a safe sentinel — but an HTML input strips or mangles one, so it
    survives only as an RSC-serialized _argument_. That is why a secret field
    renders empty rather than pre-filled with the sentinel, and why every
    submitted secret is `.trim()`ed _before_ `resolveSecret()` sees it: a NUL is
    not JS whitespace, so trimming leaves the sentinel intact
    (`secrets.test.ts` pins that) while stripping the trailing newline a paste
    from a console or a password manager brings with it. Untrimmed, that newline
    was **credential destruction**, not a bad message — see the write-on-rejection
    rule below. `src/lib/secrets.ts` **imports nothing**, like `auth/roles.ts`
    and `avatar.ts`, and is pinned by a specifier tripwire rather than a comment.
    **That is the standard for every dependency-free module here**, and the list
    is five: those three plus `src/lib/ai/providers.ts` and
    `src/lib/ai/bounds.ts`, each with the same regex test beside it — one that
    catches a static `from`, a dynamic `import()` and a `require()`, after
    stripping comments. A comment saying so is not the rule being kept:
    `bounds.ts` had only the comment until phase 7's fix wave, while feeding both
    the browser's `min`/`max` and the server's zod schema, and `avatar.ts` had
    only the comment for two phases after that — while **this list already
    claimed a test was beside it**. Adding the fifth is what made the sentence
    true. Check the list rather than trusting it:
    `grep -rl "imports nothing at all" src/` must return one test per module
    named here.
- **A probe never rejects, and its `detail` is log-only prose built from
  constants.** `ProbeResult` (`src/lib/integrations/probe.ts`) is the shape both
  live probes report and all seven AI providers report; every
  probe resolves to it for _every_ input, which is why URL building and Basic-auth
  encoding happen **inside** the `try` — the guarantee has to be structural, not
  an argument about which characters a credential can contain. `detail` is what
  an operator reads in the server log when the translated toast is not specific
  enough, and it must never interpolate a response body, an error message or a
  credential: a provider can echo the very key just submitted, and only a catalog
  key crosses the wire (`src/lib/integrations/result.ts`). A status _number_ is
  fine, and so is a platform error code (`ENOTFOUND`, `ECONNREFUSED`) — but that
  one is written straight to the log by `logUnreachable()` rather than returned,
  because a field on the result is a field something can render.
- **What a probe's verdict does to the row is `judge()`, and its three arms are
  not symmetric.** `src/lib/integrations/define.ts` (`Judgement`, and the `save`
  it feeds — `actions.ts` is the two declarations that parameterise it):
  - **`good`** — store the credential, switch the integration on.
  - **`bad`** (the provider refused it) — **store it anyway**, integration off,
    so the badge agrees with the toast and a typo is visible rather than silently
    producing empty feeds.
  - **`unknown`** (no answer: network, timeout, an unrecognised status) — **write
    nothing at all.** With no verdict there is nothing to derive the flag from,
    and both alternatives are worse: a momentary outage would either disable a
    working integration or leave `*Enabled = true`, earned by a _different_
    credential, vouching for one that was never tested.

  **Do not "fix" `bad` into a no-write arm for consistency.** The asymmetry was
  put to the human explicitly, next to the option of refusing the write, and
  storing was chosen: Save's contract is "what you typed is now what is stored",
  and the alternative leaves an operator reasoning about which of two invisible
  values the server kept. **Test** is what makes it safe (it writes nothing, so a
  replacement can be proved before it replaces anything) and **Remove** is the
  deliberate path back to "not configured" — an explicit action behind
  `<ConfirmDestructive>`, also a human ruling, because empty means keep and the
  flag is probe-derived, so nothing else could ever unconfigure an integration.

- **"A rate limit proves the credential was accepted" is a per-provider fact, and
  it has a name.** `quotaMeansVerified` on each provider's keys — a **required**
  field of `ProviderKeys` in `define.ts`, answered per declaration in
  `actions.ts` — `true` for YouTube, because Google validates the API key
  _before_ it accounts for quota, so a 403 carrying
  `quotaExceeded`/`dailyLimitExceeded`/`RESOURCE_EXHAUSTED` is only reachable
  with a key it accepted; `false` for Reddit, because a 429 from
  `/api/v1/access_token` is IP/edge-level load shedding returned _without_
  looking at the Basic auth header, and datacentre ranges — where a self-hosted
  aggregator lives — are throttled routinely. Sharing YouTube's answer meant a
  first-ever save of _wrong_ Reddit credentials from a throttled host stored them
  and set `reddit_enabled = 1`. It is a named, non-optional field rather than a
  branch inside `judge()` so that **adding a provider forces the decision**
  instead of inheriting one — omitting it is a `npm run typecheck` failure, not a
  comment somebody was supposed to read. The same reasoning splits the two
  success arms: a probe may
  require a field in the body (Reddit's `access_token` — a token endpoint answers
  `200 {"error":"unsupported_grant_type"}`, and its edge serves 200 HTML block
  pages) or judge the status alone (YouTube — `channels?forHandle=…` legitimately
  answers `200 {"items": []}`, so requiring a field would reject a good key).
  Both asymmetries are commented where they live; neither is sloppiness to tidy.
- **A credential provider is a _declaration_, never a copy of the sequence.**
  `defineIntegrationIn<Key>(…)` in `src/lib/integrations/define.ts` owns the
  whole path — parse, load the row, resolve each secret, guard the empty case,
  probe, log, judge, write — and returns one provider's `save`/`test`/`remove`.
  `src/lib/integrations/actions.ts` is then a table of two declarations plus six
  one-line exports (a `"use server"` module can export nothing but async
  functions, which is why the factory cannot live there — the same constraint
  that put `attempt` in `result.ts`). Phase 7's three AI providers were three
  more declarations; the 2026-08-04 AI provider expansion added Mistral, Qwen
  and DeepSeek as three more again, for six declarations total; OpenRouter
  added a seventh afterward, on the same branch that gave `run.ts` its
  `ProviderUnauthorizedError` (see the `/ai` bullets below).

  **Extracting it out of `"use server"` cost it a safety net, so the net is now
  a lint rule.** Inside `actions.ts` a stray client import was harmless by
  construction — Next replaces such a module with reference stubs — while the
  plain module imports `drizzle-orm`, `@/lib/db/client` and `next/cache` like
  anything else, and it exports five _types_, which is exactly what a component
  would reach for. `**/lib/*/define` is therefore the **third** group in
  `eslint.config.mjs`'s `no-restricted-imports` block, beside `**/avatar-storage`
  and `**/lib/*/queries`, with `allowTypeImports: true` so `import type` stays
  the preferred form. Any later extraction out of a `"use server"` module
  inherits the same hazard and belongs in that list.

  Five things make it a guard rather than a tidy-up, all checked by the
  compiler:
  - **`fields` is keyed by the name the zod schema parses**, and the two must
    agree _exactly_ — a schema field the declaration forgets would be probed and
    then silently never written, and a declared field the schema lacks would
    resolve to `undefined`. Both are type errors, in both directions.
  - **`secret: true | false` is one bit with two consequences**: a secret is
    resolved against the stored row by `resolveSecret()`, must be non-empty
    before anything is probed, and is wiped by Remove; a plain field
    (Reddit's `userAgent`, phase 7's `model` and `apiUrl`) is submitted in full,
    never resolved, and **deliberately survives Remove**. That one flag is what
    generalises "YouTube refuses when its one key is empty, Reddit when either of
    its two is".
  - **Column names are checked against the schema** (`TextColumn`/`FlagColumn`
    are derived from `userSettings.$inferInsert`), so a secret cannot be pointed
    at a boolean flag or the reverse.
  - **`TextColumn` excludes `userId` by hand**, and that one exception is not
    fussiness: it is the row's own key, so `column: "userId"` would emit
    `SET user_id = '<the submitted API key>' WHERE user_id = ?` on every save —
    tripping the foreign key, landing in `persist()`'s catch, and surfacing as a
    bare `{ ok: false }` whose real cause is only in a log. `theme` and
    `language` stay legal targets because an allow-list of the other twenty
    columns is a list a later phase forgets to extend.
  - **The four keys that belong to the _page_** — `unreachable`, `timedOut`,
    `unexpected`, `removeFailed` — are spelled out once at the binding site, for
    the reason `attemptIn()` takes its two there: with the namespace a literal,
    the compiler checks them against the real catalogs. An `ai` namespace binds
    its own; nothing in `define.ts` names a catalog — **including the log
    prefix**, which is a fifth binding field for the same reason. A hard-coded
    `[integrations]` would have the AI page reporting
    `[integrations] openai probe failed`, a wrong answer to the only question a
    prefix is asked. It is threaded through `logProbe()`, `logMissingRow()` and
    `persist()`'s catch. `logUnreachable()` in `probe.ts` is the one line the
    binding does not reach, and it therefore **carries no page tag at all** —
    only the provider name. It wrote `[integrations]` until the AI page made
    that visibly wrong: one unreachable OpenAI probe emitted
    `[integrations] openai probe could not reach the provider (ENOTFOUND)` and,
    on the next line, `[ai] openai probe failed (network): …`. Threading the
    prefix down there was rejected on cost — a probe is handed a credential and
    nothing else, so the page would have to be hard-coded in each of the five
    probe modules, five literals free to drift from the one `logPrefix` per
    binding. The provider name is unique across all five and appears in both
    lines, so `grep openai` is what joins them.

- **All five probes share one catch tail, and the shared probe module is
  `src/lib/integrations/probe.ts`.** It owns `ProbeResult`, `PROBE_TIMEOUT_MS`,
  `logUnreachable()`, **`transportFailure()`** (timeout → `timeout`, anything
  else → log the platform code, return `network`) and **`readJson()`** (a body,
  or `null` when it was not JSON — typed `unknown` so every read has to narrow).
  The last two arrived in phase 7 as `src/lib/ai/probe-support.ts`, serving the
  three AI probes and leaving _three_ copies of the same catch block where there
  had been two; they moved here and `youtube.ts` and `reddit.ts` were converted,
  so there is one implementation rather than a convention that five should
  agree. `transportFailure()`'s `unreachableDetail` **must be a string literal at
  the call site** — it is a parameter only so the sentence can name the provider,
  and `detail`'s no-echo rule is what stops a provider replaying a submitted key
  into it.

- **`/ai`'s OpenAI base URL is a deliberate SSRF capability, hardened at two
  edges — a human ruling, not an oversight to re-derive.** `openaiApiUrl` is an
  operator-supplied endpoint that the server then `fetch`es, so a signed-in user
  can aim the probe at `169.254.169.254`, at a container on the Docker network,
  or at anything else this host can reach, and read the answer through the
  probe's own `network`-versus-`unexpected` classification — a blind-SSRF
  oracle. **The capability is accepted**: an OpenAI-compatible gateway (LiteLLM,
  vLLM, a corporate proxy) _is_ an arbitrary host, that is the entire point of
  the field, and there is no self-registration — every account is admin-created,
  so the caller is already someone this instance trusts with the server. A policy
  gate, a host allow-list and an admin-only restriction were all considered and
  all rejected as taking the feature away. What was closed is the two cheap
  edges, both in phase 7's fix wave:
  - **`redirect: "error"` on the probe's `fetch`** (`src/lib/ai/openai.ts`).
    `fetch` follows redirects by default, so _any_ host validation a later phase
    adds is bypassable by a gateway answering `302` to the metadata endpoint —
    the check would pass on the URL that was validated and the request would land
    somewhere else. No legitimate API endpoint redirects a POST, so nothing real
    is lost; `undici` rejects, and the shared catch tail answers `network`.
    **Phase 12's summariser calls the same endpoint and needs the same flag.**
    The flag is per call, so remembering is the whole mechanism today; the
    direction record's "Carried forward from phase 7's review" carries the shape
    that makes it structural instead, and phase 12 is where that gets built.
  - **Userinfo in the URL is refused** — `url.username || url.password` — in
    both `isStorableBaseUrl()` (`src/lib/ai/actions.ts`, the save schema) and the
    probe, for the reason the scheme check is duplicated. `apiUrl` is declared
    `secret: false`, so `getAiStatus()` projects it **unmasked**, and a stored
    `https://user:pass@gateway/v1` puts a plaintext credential in the RSC payload
    of every render of `/ai` — plain text in a browser's network tab. It is the
    operator's own credential, so not an escalation; it does contradict the
    masked-or-not-at-all contract above, which is enough. Refused rather than
    stripped: stripping would send the probe to a gateway that answers 401, and
    the operator would be told their _API key_ was rejected. `openai.apiUrlInvalid`
    carries the widened wording that names the requirement and says a gateway's
    credentials go in the API key field; it is one key rather than two because
    `fieldErrorKeys` is keyed `field:code` and both refusals are zod `custom`, so
    splitting them would mean teaching `errorKeyFor()` a third key component for
    one message. That key now serves **four** refusals — unparseable, wrong
    scheme, userinfo, and `apiUrl:too_big` — and **deliberately says nothing
    about length**. Considered and rejected rather than overlooked:
    `toast.error(t(result.errorKey))` in `src/components/section-kit.tsx` passes
    no ICU values, so naming the real cap (`MAX_API_URL_LENGTH` in
    `src/lib/ai/actions.ts`) would mean threading a parameter through the shared
    reporter — the same restructuring that was ruled out above — while a
    numberless "and not too long" is a longer toast rather than advice. The
    string is already the longest in either catalog, it is a toast _title_, and
    the cases it does name are the ones an operator reaches. Revisit if that
    reporter ever takes values.

- **`/ai` has seven providers, not three.** The direction record's "Carried
  forward from phase 7's review" originally deferred provider expansion; the
  2026-08-04 AI provider expansion plan
  (`docs/superpowers/specs/2026-08-04-ai-provider-expansion-and-prompt-endpoint-design.md`)
  widened `AI_PROVIDERS` (`src/lib/ai/providers.ts`) from OpenAI/Anthropic/Gemini
  to add Mistral, Qwen and DeepSeek, following yana-ios's `AppSettings.swift`
  `AIProvider` enum — the same source this repo already cites for its default
  model ids. Apple Intelligence, the seventh entry in that enum, is
  **deliberately excluded**: it is on-device-only in iOS, with no API key and
  no network call, so there is nothing here for a server-side registry entry to
  represent. **All three new providers get fixed, non-configurable base
  URLs**, unlike OpenAI's operator-settable `openaiApiUrl` — a deliberate
  choice in the design spec, both because none of the three needs the SSRF
  hardening OpenAI's field carries (redirect refusal, userinfo rejection, URL
  validation — see the bullet above) and because a fixed endpoint is what lets
  `quotaMeansVerified: true` hold for all three, by the same reasoning already
  written for Anthropic and Gemini: nothing can shed load at an edge in front
  of a host that is never operator-supplied, so a 429 can only mean the key
  was already accepted. Two helpers, both extracted ahead of the new
  providers rather than pasted three more times, and both now used by
  OpenAI's own probe and call path too:
  - **`openaiCompatibleChatProbe()`** (`src/lib/integrations/probe.ts`) is the
    shared OpenAI-compatible `/chat/completions` probe body — the one-token
    completion, the 200/401/403/404/429/400 status classification, the
    `redirect: "error"` fetch — parameterized by provider name, endpoint,
    key and model. `testOpenaiKey()` (`src/lib/ai/openai.ts`) and the three
    new thin probe modules (`testMistralKey`, `testQwenKey`,
    `testDeepseekKey` in `src/lib/ai/{mistral,qwen,deepseek}.ts`) all call it;
    only OpenAI's caller resolves and validates a URL first; the other three
    pass a literal.
  - **`callOpenaiCompatible()`** is a private method on `AIClient`
    (`src/lib/ai/run.ts`) — the same `/chat/completions` request/response
    shape on the runtime-call side, taking a resolved base URL, key, model,
    prompt and JSON-mode flag. `callOpenai()` and the three new provider
    branches (`callMistral`, `callQwen`, `callDeepseek`) all call it rather
    than repeating the request-building and response-parsing block four
    times.

  **OpenRouter was added afterward, independently of the 2026-08-04 plan and
  of yana-ios parity — it has no yana-ios equivalent at all.** It reuses both
  helpers above (`openaiCompatibleChatProbe()` for its probe, a `callOpenrouter()`
  branch calling `callOpenaiCompatible()` for the runtime call) and is, like
  Mistral/Qwen/DeepSeek, a fixed, non-configurable endpoint
  (`OPENROUTER_API_URL` in `src/lib/ai/providers.ts`) — but its
  `quotaMeansVerified` is **`false`, not `true`**, the one place it does not
  follow those three's pattern. The three's `true` rests on "a fixed endpoint
  has nothing positioned to shed load before the provider's own auth check
  runs" — but OpenRouter's fixed endpoint is not a single vendor's API, it is
  an aggregator's own edge in front of hundreds of upstream providers, and that
  edge applies its own rate limiting (including extra throttling specific to
  free-tier `:free` models) independently of whether the submitted key is
  valid. So a 429 from it does not prove the credential was accepted — the same
  conclusion OpenAI's `false` reaches, but for a different underlying cause:
  OpenAI's is an operator-configurable gateway that can shed load in front of
  it, OpenRouter's own edge _is_ the gateway. Both `false` providers' `quota`
  answers land in the same "could not be verified" arm in
  `src/lib/ai/actions.ts`'s `PROVIDER_KEYS`, for the same reason.

  **`hasDynamicModels` is the other way OpenRouter breaks the six-provider
  pattern, and it is the more surprising one.** Every other provider's
  `models` array in `src/lib/ai/providers.ts` (`AiProvider`) _is_ the whole
  valid set — a fixed, hand-maintained list looked up against the vendor's own
  docs and refreshed by editing this file. OpenRouter aggregates hundreds of
  continuously-changing models (including a rotating set of free `:free`-tagged
  ones), so a static list would be wrong the day it shipped; `models` for this
  one entry is instead a **2-entry fallback** (`openrouter/free`,
  `openrouter/auto`, OpenRouter's own routing aliases, which cannot go stale
  the way a pinned model id can) shown before any refresh, and the real catalog
  is fetched on demand by `listOpenrouterModels()` (`src/lib/ai/actions.ts`)
  behind a manual "Refresh models" button in `provider-section.tsx` — never
  automatically, and never cached. This is why `resolveModel()`
  (`src/lib/ai/columns.ts`) has a special case keyed on
  `AiProvider.hasDynamicModels`: for the six fixed-catalog providers, a stored
  model id absent from `provider.models` really is stale (a retired id, a
  pre-migration default) and falls back to `provider.defaultModel` — but for
  OpenRouter that same absence is the _normal_ case for a perfectly valid,
  freshly-saved live id, because `provider.models` was never the full valid set
  to begin with. Checking a dynamic provider's stored id against its static
  fallback and reverting on a miss was a real, shipped bug: an operator would
  refresh, pick a real catalog model, save it successfully, and have the very
  next page load silently substitute `openrouter/free` back in — both
  mis-showing the picker and risking the next Save overwriting the real stored
  value with the default. `resolveModel()` therefore trusts a non-empty stored
  value outright for a `hasDynamicModels` provider, without checking it against
  `provider.models` at all: it already passed the permissive
  `openrouterModelField` schema (length only, no enum check — see
  `src/lib/ai/actions.ts`) and a live probe at save time, which together are
  the validation the static-list check performs for everyone else. An empty
  stored value is still not trusted and still falls back to the default, the
  same as every other provider's unconfigured case.

- **`aiDefaultDailyLimit`/`aiDefaultMonthlyLimit` went from decorative to
  enforced, at one chokepoint.** Both settings have existed among the nine
  tuning values (with bounds in `src/lib/ai/bounds.ts`) since phase 7, but
  nothing read them until the same 2026-08-04 plan added a new table,
  **`ai_requests`** (`src/lib/db/schema/ai.ts` — one row per attempted call,
  `(userId, createdAt)` indexed), and **`checkAndRecordAiUsage()`**
  (`src/lib/ai/usage.ts`). Neither `old/core/ai_client.py` nor yana-ios ever
  enforced these limits — confirmed by reading both — so there was no oracle
  to port from; this is new behaviour, not a port. It is called once, inside
  **`AIClient.generateResponse()`** (`src/lib/ai/run.ts`), before any outbound
  provider call — the same chokepoint `applyAiOptions()` (the background
  AI-post-processing path that has no live caller yet) already runs through,
  so wiring that path up later inherits enforcement for free rather than
  needing its own check. Three facts a caller cannot get right by guessing:
  **usage is recorded for every attempted call, not only successful ones** —
  the setting is documented as the most AI requests Yana makes, which is about
  outbound calls, and counting only successes would let a provider outage or a
  string of 500s bypass the limit entirely; **reset windows are calendar UTC
  day/month**, not a rolling window, matching this repo's existing
  `timeZone: "UTC"` convention, and `checkAndRecordAiUsage()` opportunistically
  deletes a user's rows older than the start of the current UTC month on every
  call (the daily window is a subset of the monthly one, so nothing needs a row
  older than that, and no separate cleanup job exists); and the read-then-write
  is **atomic under the caller's own `writeTransaction()`** (`BEGIN IMMEDIATE`),
  the same ordering guarantee `setActiveProvider()` already relies on, so two
  concurrent calls from the same user cannot both read "one under the limit"
  and both proceed. `generateResponse()`'s return type changed from
  `string | null` to `AiGenerationResult` —
  `{ ok: true; text } | { ok: false; reason }`, `reason` one of `noProvider` /
  `dailyLimitExceeded` / `monthlyLimitExceeded` / `providerUnauthorized` /
  `providerError` — so a caller can tell a rate limit from a provider failure
  instead of both collapsing to `null`. **`providerUnauthorized` is a fourth
  reason, added with OpenRouter rather than by the 2026-08-04 plan**: it is
  thrown as `ProviderUnauthorizedError` (`src/lib/ai/run.ts`) from
  `requestWithRetry()` on a 401 or 403 from the provider — the credential
  itself was rejected, not a transient failure — and caught in
  `generateResponse()`'s own catch, distinctly from every other failure, which
  still collapses to the generic `providerError`. The distinction exists for
  the same reason `/ai`'s own probes separate `rejected` from `unreachable`/
  `unexpected`: "your key is wrong" and "something went wrong" want different
  advice, and a native client polling this reason can tell someone to fix
  their OpenRouter key rather than just retry.
- **`POST /api/v1/ai/prompt`** (`src/app/api/v1/ai/prompt/route.ts`) is the
  native client's server-mediated "ask AI" call, added by the same plan: a
  free-form prompt run against the caller's active provider, using their
  stored global tuning values with **no per-request overrides**. It reads
  `user_settings` directly by `user.id` off `requireApiUser()`'s
  Bearer-authenticated caller, never through `getSettings()` — that helper is
  bound to the cookie-session-derived `currentUserId()` and would not resolve
  for a Bearer-token caller, the same reason
  `src/lib/jobs/handlers/retention.ts` reads a settings row directly outside a
  session context. Its failure modes are machine-readable `ApiError` codes
  (`invalid_prompt`, `prompt_too_long`, `no_active_provider`,
  `daily_limit_exceeded`, `monthly_limit_exceeded`, `provider_unauthorized`,
  `provider_error`) for the native client to branch on — never provider prose,
  per this API's existing no-echo convention. `provider_unauthorized` (502) is
  the `providerUnauthorized` reason above, given its own code rather than
  falling into the generic `provider_error` (502) — both answer 502 because
  neither is this API's own fault, but only one names a fixable cause.
- **`GET`/`PATCH /api/v1/reading-position`**
  (`src/app/api/v1/reading-position/route.ts`) is the native client's
  cross-device "current article" pointer, letting every paired device
  converge on the same article. It is **two columns on `user_settings`**
  (`readingPositionArticleId`/`readingPositionUpdatedAt` in
  `src/lib/db/schema/users.ts`), not a dedicated table: every user already has
  exactly one settings row, and this is the same shape as every other
  per-user preference already living there (`activeAiProvider`, `theme`).
  `readingPositionArticleId` deliberately carries **no `.references()` FK** —
  the same choice `articleTombstones.articleId` already made — so retention
  and feed-delete can hard-delete the pointed-at article without a constraint
  violation or a cascade that would clear the pointer; the client already
  falls back to its normal anchor when a synced id doesn't resolve locally,
  so a stale pointer is simply left in place rather than special-cased.
  `readingPositionUpdatedAt` is a **second, dedicated timestamp column**, not
  the row's shared `updatedAt` — that one's `$onUpdate` fires on _any_ write to
  the settings row (a theme change, an AI key save), which would misreport
  "just synced" for a write that never touched the reading position.
  `PATCH` validates ownership the same way `PATCH /api/v1/articles/[id]` does
  (`articles.feedId IN (SELECT id FROM feeds WHERE userId = ?)`) and answers
  the same `not_found` for an unowned or nonexistent id, never a 403;
  concurrent writes from two devices get no special handling, because
  last-write-wins is exactly what both the server and the client already
  assume. `GET` before any `PATCH` (or for a user whose pointer was never
  set) returns `{ articleId: null, updatedAt: null }`. `PATCH` also publishes
  a `readingPosition` event (`src/lib/api/events.ts`'s `ApiEvent` union,
  `publishUserEvent`) right after the commit, using the DB-round-tripped
  `updatedAt` rather than a fresh `new Date()` -- the column truncates to
  whole seconds, so a value stamped in-process would disagree with what a
  later `GET` returns for the same write. This rides the same per-user SSE
  bus `GET /api/v1/jobs/events` (`src/app/api/v1/jobs/events/route.ts`)
  already forwards job/run events on -- that route's generic `send(event.type,
event.payload)` needed no change at all to carry the new event type, since
  it never switches on which `ApiEvent` variant it's relaying. No extra
  broadcast-side throttling: the native client already debounces its own
  pushes to roughly one every two idle seconds, so the publish rate this
  route ever sees is already the rate worth broadcasting.

- **`syncArticles` selects a named column list, never `db.select()`.**
  `rawContent` is a whole fetched HTML page and `plainText` is the largest
  column on the table; neither appears in `ArticleSummaryWire`, so a bare select
  reads both off disk for every row in **both** streams and hands them to the
  serializer to throw away. `SUMMARY_COLUMNS` in `src/lib/api/sync.ts` is that
  list, and it stays honest by construction: `serializeArticleSummary` takes
  `ArticleSummarySource` — a `Pick` of the eleven columns it reads, not a whole
  `Article` — so a wire field that needs a twelfth is a `npm run typecheck`
  failure here, not a missing value discovered on a client. (A full `Article`
  still satisfies it, so the callers that already have one needed no change.)
  `listArticles` (`src/lib/articles/queries.ts`) documents the same rule for the
  same reason.
  `articles_updated_id_idx` on `(updatedAt, id)` is the `updated` stream's
  counterpart to `articles_created_id_idx`: the query orders by
  `updatedAt ASC, id ASC` under a `LIMIT`, and without the index it full-scans
  and builds a temp B-tree on every sync call.

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
  exists.** Three things are load-bearing. The check is keyed on **"any user is
  a _usable_ admin"** — `isAdminRole()` from `auth/roles.ts`, so a comma list
  counts, and **not banned**, because the plugin refuses to create a session for
  a banned user and an instance whose only administrator is banned has none in
  the sense that matters (an already-expired ban does count as unbanned; Better
  Auth lifts it on the next sign-in). Never keyed on the address — so a renamed
  or deleted default does not come back on the next boot.
  **When there is no usable admin _and_ `admin@admin.com` is already taken, the
  role is repaired rather than the account recreated**, and the failure is not
  allowed to propagate: `users.email` is unique, so rethrowing there means
  `register()` throws, `process.exit(1)`, and an instance that never boots again
  — with no self-registration, no mail transport and no CLI to recover with. A
  server that cannot boot is worse than one with a confused role, which is the
  same principle the last-passkey guard rests on. It fires only when no other
  usable admin exists, so an operator who demoted the default and promoted
  somebody else keeps that across every restart, and it warns loudly because in
  the odd case — `admin@admin.com` being an ordinary user phase 5 created — it
  is a promotion. The account is created
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

  **`testTimeout` is 20s at the root, and that is not a claim that the tests are
  slow.** They assert in milliseconds; what does not fit in Vitest's 5s default
  is the one-time _cold_ work in front of the assertion. Two kinds. Fifteen node
  tests call `vi.resetModules()` and then `await import(...)`, which
  re-transforms the graph through Vite and re-loads `better-sqlite3`'s native
  binding — aggregate import time across the 64 files is **34–44s**, so a single
  cold import is seconds (`src/instrumentation.test.ts > register > logs and
exits when startup fails` pays one _inside the test body_). And Better Auth's
  scrypt is expensive on purpose, so `users.test.ts`'s `listUsers` cases spend
  their budget seeding a dozen accounts before they assert. Both are wall-clock
  budgets against CPU-bound work, so the failure is **load-dependent, not
  branch-dependent**: green on an idle laptop, intermittent on CI, where
  `ubuntu-latest` is a 2-core shared runner. Reproducing it needs load — running
  the suite under 48 busy loops on 8 cores failed 8 tests, all
  `Test timed out in 5000ms`, and an idle run proves nothing. It is at the
  **root** so both projects inherit it through `extends: true`, deliberately not
  node-only: 4 of those 8 were `dom` tests, because building a jsdom environment
  and rendering React is its own cold cost. **`hookTimeout` is raised with it,
  to 30s, and finding out why is the cautionary part**: most node tests do
  strictly _more_ cold work in `beforeEach` (reset, a real `applyMigrationsAt()`,
  four to six cold imports) than in the body, so the hooks were always the larger
  exposure — Vitest's 2x-larger 10s default merely hid it behind the tests that
  were failing first. Raising `testTimeout` alone surfaced it immediately: the
  next run under identical load failed `settings.test.ts` with
  `Hook timed out in 10000ms`. Fix one and re-measure, because the second
  failure only becomes reachable once the first stops firing. **Never paper over
  any of this with `retry`**, which would hide a real regression along with the
  flake.

  Shared wrappers live in **`src/test/`**, and it serves **both** projects —
  `next-headers.ts` is used by four `.test.ts` files in the node one. Extend
  them rather than copy-pasting:
  - `render.tsx` — `renderWithProviders`, wrapping `NextIntlClientProvider` with
    the **real** `messages/*.json`, a pinned `UTC`, and optionally next-themes'
    provider.
  - `next-navigation.ts` — `usePathname`/`setPathname`, `useRouter`/`setRouter`,
    and the **real** `unstable_rethrow`, registered per file with
    `vi.mock("next/navigation", () => import(...))`. **Never write an inline
    `vi.mock("next/navigation", () => ({ useRouter: … }))`:** `vi.mock` replaces
    the whole module, so the file dies with `No "x" export is defined on the
mock` the moment anything in the tree reaches an export it did not think to
    declare — which is precisely what happened when `attempt()` started calling
    `unstable_rethrow`. And `unstable_rethrow` is re-exported for real rather
    than stubbed: it is a predicate over Next's control-flow errors, and faking
    it would make a test prove the opposite of what it claims.
  - `next-headers.ts` — `nextHeadersStub()` for the node project; see the
    `nextCookies()` rule above for why `cookies` is mandatory in it.
  - `setup.ts` — testing-library cleanup, plus repair for three APIs:
    `window.matchMedia`, which jsdom declares but leaves `undefined`;
    `localStorage`, which Node 25 shadows with a method-less object that makes
    next-themes silently fall back to `defaultTheme`; and `fetch`, stubbed to
    answer `attempt()`'s session probe so **no jsdom test reaches the network**
    (before it, one rejection test spent a second on a connection refusal and
    then failed its `waitFor`). A test that is _about_ the probe overrides it.

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
  while showing record ids verbatim -- and, since the breadcrumb-title
  registry, a registered record title overriding that id (truncated, with a
  tooltip) and never overriding a translated nav segment -- the Select
  trigger's translated label, and (phase 4) admin-only navigation hidden from
  a non-admin.
  Assert against `de.json` where English is too close to the raw value to prove
  anything ("Dark" vs. `dark`). New structural assertions are worth checking
  against the defect they describe — reintroduce it, watch the test fail, revert
  — because a `.tsx` test used to be ignored outright and a green test proves
  nothing on its own.

## Where the work is planned

`docs/superpowers/specs/2026-07-30-nextjs-migration-direction.md` is the
direction record — the decisions every phase builds on (multi-tenant, real tags,
greenfield data, SQLite `jobs` table with an in-process worker). Per-phase plans
are `docs/superpowers/plans/nextjs-*.md`, executed in order. All fifteen
phases are done: phase 1 (scaffold),
phase 2 (schema, migration `0000` and the bootstrap user — that seeder is gone,
retired by phase 4's admin bootstrap), phase 3 (app shell —
i18n/theme, sidebar/breadcrumbs, streaming skeletons, the settings page and
`/health`), phase 4 (auth — Better Auth with passkeys, `role` as the
authorization model, the startup admin bootstrap, `src/proxy.ts`, `/login`,
`/account` and avatars), phase 5 (the admin-only users tab at `/users`, and
the reusable CRUD kit under it — `src/lib/crud/params.ts` plus
`src/components/crud/`, which phases 8, 9 and 10 consume for tags, feeds and
articles), phase 6 (the integrations tab at `/integrations` — the per-user
credential store, `src/lib/secrets.ts`, and the live YouTube and Reddit probes
whose verdict derives the `*Enabled` flags), phase 7 (the AI tab at `/ai` —
`src/lib/ai/` and `src/components/ai/`: a client-safe provider registry, three
live probes reusing phase 6's `defineIntegration()` descriptor, the
`active_ai_provider` preference and the nine global tuning values), phases 8–10
(the tags, feeds and articles CRUD tabs, built on phase 5's kit), phase 11
(a–c: extraction core, embeds/media, and the per-site aggregators), phase 12
(scheduling and the `jobs` table's in-process worker), phase 13 (the
`/api/v1` client API — Bearer auth, sync, aggregation, SSE job/run events),
the folder swap (phase 14, which at the time kept the retired Django app
around as `old/` — since removed entirely, see the top of this file), and
phase 15 (the
installable `@fa-krug/yana` npm package). The direction record's last sections carry the
decisions phases 2's, 3's, 4's, 5's, 6's and 7's reviews left to those phases;
**"Carried forward from phase 6's review" is the one a phase-7 agent has to
read**, because the two generalisations it records — namespace-parameterising
`section-parts.tsx` and a `defineIntegration()` descriptor — are exactly what a
third, fourth and fifth provider earn. **Both are now built**, ahead of the third
provider as that section demands: the UI half is
`src/components/section-kit.tsx` and the actions half is
`src/lib/integrations/define.ts` (see the two bullets above them), and phase 7
consumed both. Its third item — deciding each AI provider's two probe answers
rather than copying a neighbour's — is `quotaMeansVerified` in
`src/lib/ai/providers.ts`, where all seven answers differ in reasoning even
though the three added by the 2026-08-04 AI provider expansion (see the `/ai`
bullets above) all resolve to `true`, for the fixed-endpoint reason Anthropic's
and Gemini's already state — and OpenRouter, added afterward, resolves to
`false` for its own separate reason (an aggregator's own edge, not an
operator-configurable gateway; see the `/ai` bullets above). **"Carried
forward from phase 7's review" holds one item that gates a release rather than
a phase**: no live call has ever been made to OpenAI, Anthropic or Gemini, so
nothing proves those three probes send request shapes those providers accept —
and a shape one of them refuses lands in `judge()`'s write-nothing arm, which
leaves that provider unconfigurable from the UI. **The same gap applied to
Mistral, Qwen and DeepSeek too** — the 2026-08-04 plan added them and their
shared `openaiCompatibleChatProbe()` helper without a live call against any of
the three, for the identical reason: nothing but documentation says they
accept the shape the shared probe sends. `/ai` must not reach a user before
one manual pass per provider — all seven now, not three. **OpenRouter's pass
has been completed**: a real API key was used during this branch's development
to confirm `testOpenrouterKey()` returns `{ ok: true }` against it and that
`listOpenrouterModels()` returns real catalog data, both verified working
against the live OpenRouter API. OpenAI, Anthropic, Gemini, Mistral, Qwen and
DeepSeek remain unverified live and still gate a release; the section lists
what each pass covers. Phase 12 reads the same section for `redirect: "error"`.
Phase 8 still starts from "Carried
forward from phase 5's review", where the CRUD kit's contracts are.

**Beyond the fifteen phases**, a 2026-08-04 plan
(`docs/superpowers/plans/2026-08-04-ai-provider-expansion-and-prompt-endpoint.md`,
design at
`docs/superpowers/specs/2026-08-04-ai-provider-expansion-and-prompt-endpoint-design.md`)
shipped the provider expansion to six (openai/anthropic/gemini/mistral/qwen/deepseek),
the first real enforcement of the daily/monthly AI request limits, and the new
`POST /api/v1/ai/prompt` mobile endpoint — see the `/ai` bullets above for what
changed and why. **OpenRouter was added on a later, separate branch**, taking
the total to seven: a seventh `defineIntegration()` declaration, the
`hasDynamicModels`/live-catalog machinery, and `ProviderUnauthorizedError` /
`providerUnauthorized` / `provider_unauthorized` threaded from `run.ts` through
to `POST /api/v1/ai/prompt` — see the `/ai` bullets above for all of it.

**A separate webview-session-bootstrap plan** added a second way for the
native client to reach `ManagementWebView`'s cookie session, without ever
handling a password or passkey inside a `WKWebView`. **`POST
/api/v1/auth/webview-session-token`** (`src/app/api/v1/auth/webview-session-token/route.ts`)
is a Bearer-authenticated route — `requireApiBearerSession()`, not the
`requireApiUser()` every other `/api/v1/**` route uses, because it must
refuse the cookie fallback `requireApiUser()` allows: the minted token has
to bind to the exact device session the Bearer token names, not whatever
session a stray browser cookie on the request happens to carry — that
mints a short-lived, single-use token scoped to the
_calling device's own session_, via a hand-written wrapper
(`src/lib/auth/webview-session.ts`) around Better Auth's `oneTimeToken`
plugin rather than the plugin's own mint endpoint, because that endpoint
reads the session from a cookie and this caller only ever has a Bearer
token — the same "authenticates itself" mismatch `/api/v1` as a whole
exists to cover. **`GET /webview-session`** (`src/app/webview-session/route.ts`)
is the other half: it takes that token plus a `next` path in its query
string and calls `auth.api.verifyOneTimeToken()` — the plugin's _verify_
side is reused unmodified, since the trust boundary there is a token, not a
cookie, so the built-in handler needs no adjustment — which sets a real
session cookie and redirects to `next`, exactly the cookie `ManagementWebView`
already expects. `next` is validated via `next-path.ts`'s `safeNextPath()`,
the same hardened helper `/login` uses (see the `/login` bullet below),
rather than a route-local reimplementation: resolved and checked by origin,
not by a string-prefix heuristic, because a prefix check alone is exactly
what let `/login`'s original `next` guard ship a working open redirect
(WHATWG URL normalization turns `/\evil.com`-shaped input into an
off-origin URL after parsing). Any missing, invalid, expired or
already-used token falls back to `/login`, indistinguishable from a plain
signed-out visit. **This route is public in `src/proxy.ts`'s
`PUBLIC_PREFIXES`** — see the proxy bullet above for why: the whole point
is that the caller has no session cookie yet, so gating it behind one is a
contradiction, not an oversight. **Its `Location` header is a _relative_
reference (`/feeds`, `/login?next=…`), never an absolute URL, and that is
load-bearing.** It originally built one with `new URL(path, request.url)`,
which reads the origin off the incoming request — but in production this is
a standalone Next server listening on `0.0.0.0:3000` behind a reverse
proxy, so `request.url` is that internal address rather than the public
origin the client dialled. `ManagementWebView` was therefore redirected to
`http://0.0.0.0:3000/feeds`, which WebKit refuses outright as restricted
network access (`WebKitErrorDomain 103`), killing the bootstrap _after_ the
one-time token had been minted and burned. A relative `Location` is
resolved by the client against the origin it actually requested (RFC 9110
§10.2.2), so nothing depends on `Host`/`X-Forwarded-Proto` surviving the
proxy — which is why the fix is here and not in the proxy config.
`safeNextPath()` already guarantees the path never starts with `//`, so it
cannot re-parse as a network-path reference and escape the origin; that
guarantee is what makes emitting it raw safe, and
`route.test.ts`'s "never derives the redirect origin from the request URL"
case drives a `http://0.0.0.0:3000/...` request through `GET()` so a
regression fails a test instead of only failing on a phone.
**The redirect response itself is built with
`new Response(null, { status, headers })`, never `Response.redirect()`**,
because that helper requires an absolute URL _and_ returns immutable
headers, so a `Set-Cookie` could not be appended onto one afterward either.
Revoking a device's session invalidates its web session too, but not
instantly: Better Auth's 5-minute signed session-cookie cache (see the
`cookieCache` comment in `src/lib/auth/server.ts`) can keep serving a
just-revoked session without a database read for up to that long.

**Four plans are amended, not authoritative.**
`docs/superpowers/plans/nextjs-04-auth.md` was written before three human
rulings and one framework rename, and its task bodies still show
`users.isAdmin` and `src/middleware.ts`.
`docs/superpowers/plans/nextjs-05-users-crud.md` was written before five, and
still specifies `error?: string` results, a `role === "admin"` filter and a
confirmation dialog whose `run` fetches its own copy.
`docs/superpowers/plans/nextjs-06-integrations.md` was written before nine
controller rulings and two human rulings, and still has a save returning
`{ ok: false, error: probe.detail }` — English provider prose into a toast,
the exact mistake the first of those rulings exists to prevent — `ProbeResult`
defined inside `youtube.ts`, no path back to "not configured", and
`enabled = ok || quota` for both providers.
`docs/superpowers/plans/nextjs-07-ai.md` was written before nine human rulings,
and still has `{ ok: boolean; error?: string }` results (with an
`expect(result.error).toMatch(/monthly/i)` assertion to match), Task 2 test
bodies that cannot run as written, `ProbeResult` imported from `youtube.ts`, an
`apiUrl` on every provider rather than only where `hasCustomUrl`, a `probe` on
the client-safe registry, and a `clearActiveIfDisabled` that no longer exists
because `active_ai_provider` is a preference the read side derives from.
All four headers now say so;
read this file for what those phases actually shipped.

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
