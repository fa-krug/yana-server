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
│   │       │                      #   (no loading.tsx anywhere: no page body
│   │       │                      #   awaits, so none can suspend)
│   │       ├── page.tsx           # dashboard
│   │       ├── error.tsx          # error boundary for every route in the group
│   │       ├── account/page.tsx   # /account — profile, password, passkeys
│   │       ├── integrations/page.tsx # /integrations — YouTube + Reddit credentials
│   │       ├── ai/page.tsx        # /ai — the active AI provider, its credentials,
│   │       │                      #   and the five global tuning values
│   │       ├── settings/page.tsx
│   │       └── users/             # admin-only. page.tsx (list), new/, [id]/ (edit +
│   │                              #   delete). The gate lives in the users
│   │                              #   queries/actions now; only new/ still
│   │                              #   awaits requireAdmin() in its page body
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
│   │   │                           #   (the five numbers, saved as one unit) and
│   │   │                           #   section-parts.tsx — the `ai` binding of
│   │   │                           #   ../section-kit.tsx
│   │   ├── users/                  # the kit, wired to users: users-table.tsx,
│   │   │                           #   user-form.tsx, delete-user-section.tsx,
│   │   │                           #   use-user-impact.ts
│   │   ├── section-kit.tsx         # the credential-card kit, namespace-agnostic:
│   │   │                           #   the keep-existing sentinel, the mask
│   │   │                           #   placeholder, statusBadgeIn(),
│   │   │                           #   reportOutcomeIn() — phase 7's second consumer
│   │   ├── record-not-found.tsx    # what all five [id] routes render when the
│   │   │                           #   record promise resolves to null — one
│   │   │                           #   message for every reason it can be
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
│   │   │                          #   nothing), bounds.ts (the five tuning bounds,
│   │   │                          #   read by the form and the schema — likewise),
│   │   │                          #   columns.ts (provider -> columns, and
│   │   │                          #   resolveModel()'s hasDynamicModels split),
│   │   │                          #   probes.ts + openai/anthropic/gemini/mistral/
│   │   │                          #   qwen/deepseek/openrouter.ts (live probes,
│   │   │                          #   SERVER-ONLY by lint rule), queries.ts
│   │   │                          #   (SERVER-ONLY, masked only), actions.ts (seven
│   │   │                          #   defineIntegration() declarations, the active
│   │   │                          #   provider, the five tuning values,
│   │   │                          #   listOpenrouterModels()), result.ts,
│   │   │                          #   run.ts (AIClient + applyAiToBlocks: the AI
│   │   │                          #   stage, which works on the block tree),
│   │   │                          #   block-text.ts (the blocks <-> prose codec
│   │   │                          #   that stage sends; URLs and non-prose
│   │   │                          #   blocks cross as opaque indices)
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
- **Opt a route out of prerendering with `connection()` from `next/server` —
  **called, not awaited** — never `export const dynamic = "force-dynamic"`.**
  `better-sqlite3` is synchronous, so its queries complete during prerendering,
  and without this a production build would bake a page against `data/` — which
  is gitignored and does not exist until the server's startup hook migrates it.
  Next 16 removes `dynamic` once Cache Components is enabled, so `connection()`
  is the form that keeps working; the local doc is
  `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md`,
  section "Synchronous database drivers", which names `better-sqlite3`
  explicitly.

  **The missing `await` is deliberate, and it rests on a precondition that is
  config-dependent — so it is written down here rather than left to be
  rediscovered.** Page bodies await nothing now (see the streaming-pattern
  bullet), so awaiting this one call would reintroduce the single await that
  whole migration exists to remove: one `await` in the body makes the page
  function async again, and an async page can suspend. Calling it is enough
  today because `connection()` is a **non-async function** that inspects the
  work store and returns or throws immediately
  (`next/dist/server/request/connection.js`, Next 16.2.12). With no
  `cacheComponents` and no PPR configured — `next.config.ts` carries only
  `experimental.serverActions` — a `next build` prerender lands in that
  function's `prerender-legacy` branch, which calls
  `throwToInterruptStaticGeneration()`: a **synchronous throw**, which
  propagates out of the (now synchronous) page function exactly as it would if
  awaited. At real request time the same call takes the `request` branch,
  resolves to `undefined`, and is never observed. **Under `cacheComponents` the
  branch taken instead is `prerender`/`prerender-client`/`prerender-runtime`,
  which `return makeHangingPromise(...)` and never throw** — an unawaited call
  there would interrupt nothing, and a route could be statically prerendered
  against a `data/` that does not exist. Enabling Cache Components therefore
  means revisiting every one of these call sites, not just this bullet.

  **The thing to re-run is the check, not the mechanism.**
  `rm -rf data/ && npm run build && ls data/` must end in
  `ls: data: No such file or directory`, and the build's route table must show
  `ƒ` (Dynamic) beside every route — measured on this branch, all routes
  dynamic, `data/` not recreated. A mechanism argument that survives a Next
  upgrade is worth less than that command, which does not.

  **It is per route, and a layout does not cover its pages.** The root layout's
  call does _not_ keep a page off the database: layout and page are sibling
  render scopes, React starts the page before the layout's interrupt lands, and
  a single `getTranslations()` there resolves the next-intl request config →
  `getSettings()` → `getDb()`. That is measured, not theoretical — until phase
  4's task 2 it left an empty, unmigrated `data/yana.db` behind on every
  `npm run build`. So **every route that can reach the database calls it
  itself, as its first statement**, before any query. **This is a rule to apply,
  not a list to consult** — a fixed inventory here has already drifted twice
  (once when phase 13's `/api/v1` routes shipped without an entry, again when
  the dashboard's own route joined them), because nothing enforces that a new
  call site gets a new line. `grep -rn "connection()" src/app` is how you find
  every route that currently makes the call — read its output rather than
  counting it, because not every hit is a call site: it also matches the test
  files that assert the call is there, and it matches
  `src/app/api/auth/[...all]/route.ts`, whose comment names the call in order to
  _explain why that route deliberately has none_ (its only segment is dynamic,
  so Next already treats it as dynamic — and the comment says to add the call if
  that ever changes). **Do not assume `await connection()` is rare** — after
  the instant-render-no-fallback migration it survives in fourteen non-test
  files, not two: every `(app)` page body still calls the bare, unawaited
  `connection();` form (an `await` there would make the page function async
  again, which is exactly what that migration removes), but `await
connection()` is correct wherever the function is already async for its own
  reasons and an extra `await` costs nothing — `src/app/layout.tsx`,
  `src/app/health/route.ts`, `src/app/login/page.tsx` (outside the
  instant-render page set), `src/app/(app)/api-docs/route.ts`, and eleven
  `/api/v1` route handlers that reach the database with no earlier awaited
  Dynamic API to opt them out already (`articles/[id]/content`,
  `articles/sync`, `auth/webview-session-token`, `feeds`, `images/[hash]`,
  `jobs/[id]`, `jobs/events`, `openapi.json`, `reading-position`, `runs/[id]`,
  `tags` — eleven routes, not thirteen). `grep -rl "await connection()" src --include="*.ts"
--include="*.tsx" | grep -v test` is how to re-count; it also matches two
  comment-only mentions that name the call without making it
  (`src/app/api/auth/[...all]/route.ts`, `src/components/crud/use-list-params.ts`),
  so subtract those two from its file count.

  A route that already **awaits a Dynamic API** is opted out just as well and
  needs no call. The instant-render migration shrank that category sharply,
  because the awaits it removed from page bodies were mostly the ones doing this
  job — so the routes listed here are listed for the _reason_, never as
  inventory to keep in sync. `src/app/(app)/layout.tsx` is exempt because
  `requireUser()` awaits `headers()` before anything touches SQLite; so are the
  route handlers, which are async by construction and await their own gate —
  `src/app/media/avatars/[userId]/route.ts`,
  `src/app/media/images/[hash]/route.ts`, `src/app/api/feeds/export/route.ts`
  and `src/app/api/jobs/[id]/log-stream/route.ts`. **`/users/new`
  (`src/app/(app)/users/new/page.tsx`) is the one _page_ still in this
  category**, and for a reason worth keeping straight: it is also the one page
  that still awaits an authorization gate in its body, because it calls no data
  function and so had nothing to carry the gate into (see the streaming-pattern
  bullet's authorization section). Its `await requireAdmin()` reads `headers()`,
  which opts the route out. Everything that gate used to cover on
  `/users`, `/users/[id]` and `/jobs/*` moved into the data layer, so those
  routes call `connection()` like everyone else. The three list routes
  `/articles`, `/feeds` and `/tags` are the remaining exception and the least
  obvious one: their page bodies call nothing at all synchronously — every read
  is inside an async data region within a `<Suspense>` boundary, and each of
  those awaits `currentUserId()` → `headers()` before it can reach `getDb()`,
  which is what marks the route dynamic. Verified by the build check above, not
  by reading this paragraph.

  The health route calls it _outside_ its `try`, because inside it the prerender
  bail-out (itself a thrown error) would be caught and turned into a 503,
  silently reinstating a static `{"status":"ok"}`.

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
- **The streaming pattern: a page body awaits nothing, renders its real
  controls immediately, and there is no `loading.tsx` anywhere in the tree.**
  `find src/app -name "loading.tsx"` returns nothing, and that emptiness _is_
  the invariant — not a leftover of the migration that produced it. A page
  function that awaits nothing cannot suspend; a page that cannot suspend has no
  route-level fallback to show; and a route fallback that does exist is a
  `<Suspense>` boundary **above** the page, which is far more destructive than
  it looks (Finding 1, below).

  Two migrations got here, and the second only makes sense on top of the first.
  The 2026-08-16 streaming-controls migration moved the boundary from "the
  section" to "the value inside the control". The rule before it was "chrome
  renders synchronously; data regions are async components inside `<Suspense>`
  with fallbacks from `src/components/data-skeleton.tsx`", and it drew the line
  in the wrong place: "chrome" turned out to mean the heading and the card
  border, so every _control_ counted as data — `/settings` awaited its settings
  row above its JSX, the whole page suspended, and `loading.tsx` replaced the
  theme `<Select>`, the retention `<Input>` and Save with three `<Skeleton>`
  bars. Nothing about a `<Select>`'s existence, its label, its help text or its
  option list depends on the stored value; only which option is chosen does. The
  2026-08-17 instant-render-no-fallback migration then took the last awaits out
  of the page bodies themselves, at which point every `loading.tsx` was both
  unreachable and — as it turned out — the cause of three defects nobody had
  attributed to it.

  **This is server-side fetching, streamed. It is not client-side fetching and
  it adds no request waterfall.** The page calls its query **without `await`**
  and hands the promise to a Client Component that consumes it with React 19's
  `use()`. The query still runs on the server, in the same render pass, against
  the same `getDb()` singleton; only the _await_ crossed the RSC boundary. A
  `useEffect` + `fetch` rewrite would be a different architecture and is not
  what any of this describes — reading it that way is the one misunderstanding
  that would undo the whole thing.

  **Section-level `<Suspense>` stays; the route-level one is what went away, and
  its fallback is the real form in a `pending` state — never a `<Skeleton>`.**
  The shape is a triple: the client module exports `…Form` (presentational, its
  value props optional, plus an optional `pending` defaulting to `false`), keeps
  a private `…Resolved` that calls `use(promise)` and renders `…Form` with the
  real values, and exports `…Section({ promise })` whose
  `<Suspense fallback={<…Form pending />}>` wraps it. Because the fallback and
  the resolved render are the _same component_, a control cannot appear or
  disappear across the transition — only its value fills in. That property is
  what the arrangement buys, and it is lost the moment the fallback is anything
  else. `src/components/settings/library-section.tsx` is the smallest
  reference; `src/components/integrations/youtube-section.tsx` and
  `src/components/ai/provider-section.tsx` carry every hard case.

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
  value, and the list is six places — each kept for its own reason, because the
  reason is what makes the rule reusable:**
  - **A table body's rows** — `TableRowsSkeleton` in
    `src/components/data-skeleton.tsx`, the fallback under a real chrome row and
    a real `<thead>` on all five list routes (`src/components/*/…-list-region.tsx`
    for articles, feeds, tags, users and jobs). How many rows come back is
    unknown until the query returns, so there is no row count to render
    disabled.
  - **`/account`'s passkey list** (`src/components/account/passkey-section.tsx`)
    — the same: a credential list's length is unknown, and it can legitimately
    be empty.
  - **`/account`'s device list** (`src/components/account/device-section.tsx`) —
    likewise.
  - **The dashboard's stat _numbers_** —
    `src/components/dashboard/stat-cards.tsx`. A bare number has no meaningful
    empty rendering: `0` is a lie, and blank collapses the card and jumps the
    layout when the real figure lands. The card's frame, icon and title all
    render for real; only the number is a bar.
  - **The dashboard's "latest unread" list body** —
    `src/components/dashboard/recent-articles.tsx`, the sixth and the newest.
    The card frame and heading render always; the list's _length_ is a shape,
    not a value, so the same reasoning as the two `/account` lists applies. It
    joined this list on the instant-render branch, when that card stopped being
    an awaited async region.
  - **`/articles/[id]`'s "Content" section** — the block tree. The _number and
    kind_ of blocks are unknown until the article is read, so there is no form
    shape to mirror the way every other card on that page has one. It is also
    the only remaining `TableSkeleton` call site in the repository;
    `CardSkeleton` is gone entirely.

  Each of the six is commented where it lives.

  **The three awaits that had to leave every page body, and where each went.**
  - **`await getTranslations(...)` for the heading → deleted along with the
    heading itself.** No page in `(app)` renders its own `<h1>` any more: the
    breadcrumb already names every page (and, on the `[id]` detail routes,
    the record itself via `SetBreadcrumbTitle`), so the per-page heading was
    a duplicate and was removed everywhere — the page tests assert
    `container.querySelector("h1")` is `null`. The intermediate step this
    replaced was a per-page title Client Component with a _literal_ namespace
    (`settings-title.tsx` and friends, all deleted); the two survivors of
    that technique are `src/components/ai/ai-description.tsx` and
    `src/components/integrations/integrations-description.tsx`, which render
    those pages' description line the same way: `useTranslations()` off the
    `NextIntlClientProvider` the root layout already renders, so nothing
    crosses the RSC boundary and nothing suspends. **A generic component with
    a namespace prop was attempted twice and rejected twice — do not attempt
    it a third time.** Making the namespace a type parameter while keeping
    catalog keys compiler-checked hits the exact wall documented on
    `src/components/section-kit.tsx`: TypeScript cannot prove a literal is a
    member of `NamespaceKey<Namespace>` while `Namespace` is still a parameter,
    and the only way through is a cast at a `t()` call site — precisely what the
    `AppConfig` augmentation exists to prevent, and invisible until a renamed
    key ships as a raw string in the UI. A literal namespace needs no generics
    and no cast.
  - **Authorization → into the data layer. `requireAdmin()` inside the `users`
    queries and actions, `requireUserFreshRole()` inside
    `src/lib/jobs/queries.ts`.** State it plainly, because it is the one thing
    in this migration that could have leaked every account on an instance: **a
    page rendering instantly is not permission to render data the caller may not
    see.** A gate that lived in a page body and was simply deleted with the rest
    of the awaits would take the authorization with it, silently, with every
    test still green — so the gate moves to where the rows are _read_, and stays
    there. Every exported function in `src/lib/users/queries.ts` and
    `src/lib/users/actions.ts` that a page or action calls directly calls
    `requireAdmin()` first -- with two internal-helper exceptions,
    `countUsableAdmins()` and `countUserImpact()`, gated by their `./actions`
    callers rather than themselves (each says so on its own doc comment, and a
    new caller of either has to gate itself); `listJobsForCurrentUser()` and
    `getJobForCurrentUser()` call `requireUserFreshRole()` and decide the owner
    filter themselves, which is also why nothing in that module may be `cache()`d
    across requests. **`/users/new` is the one route that keeps a page-body
    gate**, and the reason is mechanical rather than principled: it calls no data
    function at all — an empty create form — so there was nothing to carry the
    gate into. Its `await requireAdmin()` is therefore also the thing that opts
    that route out of prerendering (see the `connection()` bullet).
  - **The deciding record read on a detail route → into a promise, and those
    routes now render a not-found _state_ instead of answering 404.** All five
    (`/articles/[id]`, `/feeds/[id]`, `/tags/[id]`, `/users/[id]`, `/jobs/[id]`)
    hand an unawaited record promise to a section that consumes it with `use()`
    and renders `<RecordNotFound>` (`src/components/record-not-found.tsx`) when
    it resolves to `null`. **This was an explicit user decision**, taken with
    the trade-off on the table — instant rendering everywhere, against a real
    404 on five routes — and Finding 1 below is why it cost less than it
    appears: four of those five had not been answering 404 for some time
    already. The copy is deliberately identical for every reason a record can be
    missing (gone, never existed, someone else's, an ownerless job a non-admin
    may not see), the same "every refusal is indistinguishable" principle the
    avatar route states; `getJobForCurrentUser()` collapses all of its cases to
    one `null` and `RecordNotFound` must not reintroduce a distinction on top of
    it. `/users/[id]` additionally catches the `notFound()` its own
    `getUser()` gate throws for a non-admin and folds it into the same `null`
    (`isNotFoundError()` in `src/lib/auth/session.ts`) — left uncaught, that
    rejection surfaces through `use()` after the shell has flushed and stacks
    the group's `error.tsx` on top of the not-found page, measured live as
    "Something went wrong" above "This page could not be found".

  **Finding 1: a `loading.tsx` creates a `<Suspense>` boundary _above_ the
  page, and therefore flushes a 200 before any page-body gate resolves.** This
  file already warned that an inline `<Suspense>` swallows a `notFound()`; it
  never said that a route-level fallback does exactly the same thing, one level
  higher, to the page's own body. It does. Two measured consequences, both
  reproduced against real production builds:
  - **`/users/new` was answering 200 instead of 404 to a non-admin.** Its
    `await requireAdmin()` is the first statement of the page body and throws
    the not-found sentinel correctly — but the fallback above it had already
    flushed the shell, so the status was fixed at 200 and the throw only
    truncated the stream. Deleting that one `loading.tsx` restored the 404
    (200 → 404, curled before and after). The file had been **added by an
    earlier migration in this repository**, to a route whose entire
    authorization answer depended on not having one. Nothing failed; nobody
    looked.
  - **All four `[id]` detail routes were already returning 200, not 404**, for
    the same reason — verified by building the commit _before_ this branch and
    curling nonexistent ids: the response was a 200 whose `<h1>` read
    `Edit article`, a pending chassis that then never resolved. The 404
    guarantee those routes documented had never actually worked in a running
    app. That is the context in which "detail routes render a not-found state
    now" is a smaller change than it sounds.

  **Finding 2, and it is the one to carry into every future test: a
  `notFound()` test that renders the page function proves only that the sentinel
  was thrown — never that the response was a 404.** Four `page.test.ts` files
  (articles, feeds, tags, users `[id]`; since rewritten as `.test.tsx`) asserted
  `rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/)`. They passed. They were even
  mutation-tested and judged real guards — and they _were_ real guards, **of the
  throw**. Meanwhile the running application returned 200 on every one of those
  routes, because a boundary above the page had already flushed the shell. **A
  green suite asserted a guarantee the application had never provided, for the
  entire life of those routes.** The lesson generalises past this migration:
  `notFound()`, `redirect()` and `forbidden()` are _requests_ for a status, and
  whether the request is honoured depends on what is rendering above the caller
  — which no unit test that invokes the page function can see. **Only an
  end-to-end status check proves a status** (`npm run build && npm start`, then
  `curl -o /dev/null -w "%{http_code}"` against a bad id), and any boundary
  above the page invalidates it again. If a future phase wants a real 404 back
  on a route, that curl is the acceptance criterion, and a passing
  `rejects.toThrow` is not evidence of anything but a throw.

  **Finding 3: a promise handed to a Client Component is serialized whole — pass
  a projection, never a row.** React serializes a promise's **resolved value**,
  not the type its prop is annotated with, so
  `promise: Promise<{ theme: string; language: string }>` is structurally
  satisfied by a promise that resolves to the entire database row, and the whole
  row crosses into the page's RSC payload — plain text in a browser's network
  tab. Narrowing inside the consumer's own `use(promise)` happens _after_
  serialization and buys nothing. This is the same "a component gets the columns
  it renders, never the row" rule stated elsewhere in this file for an
  already-awaited prop: **it does not stop applying because the value arrives
  late.** This branch shipped the defect, not merely risked it — `/settings`
  passed `getSettings()` (the whole `UserSettings` row) straight to
  `GeneralSection`/`LibrarySection`, putting `openaiApiKey`,
  `redditClientSecret`, `youtubeApiKey` and six more stored credentials into
  `/settings`'s flight payload in plaintext. It typechecked, passed the full
  suite, and passed **seven task reviews** before a whole-branch review caught it
  by planting canary values and grepping the payload. Three things came out of
  the fix and all three are the convention now:
  - **Narrow on the server, in a named exported function.**
    `getSettingsSummary()` in `src/lib/settings/queries.ts` is the corrected
    shape — `getSettings()` reduced to the three fields the two cards render,
    still backed by the same `cache()`d read. An inline `.then()` in the page was
    tried and rejected: it leaves no shared symbol for a test to import.
  - **Reduce as far as the consumer's actual need.** The dashboard's admin gate
    crosses as a `Promise<boolean>` — `requireUserFreshRole().then((user) =>
isAdminRole(user.role))` in `src/app/(app)/page.tsx` — not a `Promise<User>`
    whose `.role` is read on the other side, which would serialize the email,
    the ban columns and the timestamps.
  - **Pin it to the real call site.** `src/lib/settings/settings.test.ts` reads
    `src/app/(app)/settings/page.tsx` and asserts it contains
    `const settings = getSettingsSummary()` and _not_
    `const settings = getSettings()` — a specifier tripwire bound to the page's
    own source, because a test that re-typed the narrowing locally kept passing
    against a page that had reverted. That is not a hypothetical: it is what the
    first version of this test did.

  All of the above still sits **inside an error boundary** — once the shell has
  flushed its first byte the response status is already 200 and cannot become a
  5xx, so a throw inside a Suspense boundary with no error boundary above it
  just truncates the stream. `(app)/error.tsx` is that boundary for every route
  in the group; a page adds a second one only if it wants a narrower blast
  radius. There are **three** documented exceptions to "nothing above the page
  waits on data", all in two layout files, and a page body is no longer among
  them at all:
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

  **A fallback is a Server Component, so it may not hand a Client Component a
  function — and getting this wrong fails only on a cold start.** Every
  `<Suspense fallback>` here renders a `"use client"` component — the section's
  own `…Form` with `pending`. React has to serialize each prop across the RSC
  boundary and a closure is not serializable (only a Server Action is), so
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
  `<AdvancedSectionForm>`'s `pending` branch passing `undefined`). `tsc` cannot
  see the hazard and no jsdom test can either — testing-library never runs the
  flight serializer — so the guard is `src/app/server-component-props.test.ts`,
  a specifier-style tripwire that fails on any `on[A-Z]…={` prop in a file under
  `src/app/` that is not itself a Client Component. The `loading.tsx` half of
  that hazard is gone with the files, but the rule is unchanged for every
  section fallback, which is where all of them live now.

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
  - **`requireAdmin()` throws a 404, not a 403 — and "throws" is the honest
    verb, because the HTTP status depends on what is rendering above it.** A 403
    would confirm the route exists, which a non-admin has no reason to learn, so
    `notFound()` is what the gate calls. Whether the caller _receives_ a 404 is a
    separate question with a separate answer: `notFound()` can only set a status
    while the response is still open, so any `<Suspense>` boundary above the
    caller — an inline one, or a route-level `loading.tsx`, or the section
    boundary a page hands its promise into — has already flushed a 200 and the
    throw merely truncates the stream. That is not theoretical: `/users/new`
    answered 200 to a non-admin for as long as it had a `loading.tsx` (see
    Finding 1 in the streaming-pattern bullet). Today the gate lives inside the
    `users` queries and actions, which run inside section boundaries, so
    `/users` and `/users/[id]` answer 200 and render nothing — the rows never
    arrive, which is the guarantee that actually matters — while `/users/new`,
    whose gate is still in the page body with no boundary above it, answers a
    real 404. Never assert a status from a test that renders the page function;
    only an end-to-end check can see it (Finding 2, same bullet).

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
  (`aggregate`, `feed.logo`, `feed.update`, `article.reload`), but `retention`
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
- **`feeds.lastAggregationStartedAt` is the scheduler's own clock, and it
  exists because `feeds.updatedAt` cannot be trusted as one.** `updatedAt`
  carries `$onUpdate` (see that convention above), so it is bumped by _any_
  Drizzle write to the row — a `/feeds` name edit, `storeLogo()` writing
  `logoImageHash`, `refreshLogos()` touching every feed at once — none of
  which means "this feed was just aggregated". `scheduler.ts`'s `tick()` used
  to read `updatedAt` as "last aggregation time" regardless, so any of those
  unrelated writes silently postponed the feed's next scheduled run by a full
  interval; `refreshLogos()` did this to every feed in the instance at once.
  `lastAggregationStartedAt` is a separate, nullable column, stamped by
  `claim()` (`src/lib/jobs/queue.ts`) — not `handleAggregateJob()` on
  completion — at the moment a job that runs the aggregate handler
  (`"aggregate"` or `"feed.update"`, i.e. `AGGREGATE_HANDLER_JOB_KINDS`) is
  claimed for that feed. Claim time, not completion, is what makes the
  scheduler's non-terminal-status dedupe (`NON_TERMINAL_JOB_STATUSES`, widened
  to cover a `running` job) actually hold: a long-running aggregation's feed
  reads as "just started" for its whole run, not merely "not yet finished".
  `NULL` means "never aggregated by this mechanism" — true for a brand-new
  feed and for every row that predates the column — and the scheduler treats
  a `NULL` the same as an aggregation from the epoch, so such a feed is picked
  up on the very next tick rather than skipped or, if it had been defaulted to
  "now" instead, stampeded into lining up with every other feed's next run.
  `handleAggregateJob()` no longer touches `feeds` at all on completion — the
  `set({ updatedAt: new Date() })` it used to run in both its empty-result and
  success paths existed only to bump this row for the scheduler's old,
  overloaded read, and nothing else reads `feeds.updatedAt` as a signal that
  aggregation happened (the `/api/v1/feeds` wire form serializes whatever
  `updatedAt` holds, but as an ordinary "row last modified" field, the same
  meaning every other REST resource on this API gives it — not as evidence of
  a completed aggregation).
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
- **`feeds.dailyLimit` (default `20`) paces collection across the day rather
  than spending it all on the first run — `BaseAggregator.getCurrentRunLimit()`
  (private, `src/lib/aggregators/base.ts`) computes how many entries _this run_
  may collect from `dailyLimit`, the real time of day and `collectedToday`, and
  `aggregate()` passes that number down as an ordinary parameter to
  `fetchSourceData(limit)` and `parseToRawArticles(sourceData, limit)`. Every
  override **must** slice or fetch by the value it is given and must never
  recompute its own via `getCurrentRunLimit()` — that was exactly the 2026-09-03
  pipeline-review bug: `RssAggregator`/`PodcastAggregator`'s
  `parseToRawArticles()` (14 of 16 registered aggregators) silently recomputed
  with `collectedToday = 0`, discarding the pacing `aggregate()` had already
  worked out, and a feed on `dailyLimit: 20` could store roughly 3x that in a
  day. **This is a real behaviour change for existing installs, not just a bug
  fix**: a fast feed on a small `dailyLimit` now genuinely caps at that number
  per day, and any entries beyond it are simply lost once the source's own
  window rolls past them — there is no backfill. `limit === 0` means zero
  articles, never "unbounded"; treat it as `?? `, not `||`, wherever it is read,
  since an explicit `0` is a valid paced value, not "no limit given".
- **`filterArticles()` has a second half now: an article whose source labels it
  as advertising is dropped, not stored.** The vocabulary and the matching are
  `src/lib/aggregators/promotional.ts`, the drop is
  `BaseAggregator.filterArticles()` beside the age filter above, and the switch
  is the `skip_ads` option — read `!== false`, so it is on for every feed
  including the ones created before it existed, and now declared in
  `COMMON_OPTIONS` in `specs.ts` (i.e. for every aggregator) rather than only on
  `caschys_blog`, whose title-only `(Anzeige)` test this generalises. Four
  things about it, three of them measured against live feeds rather than
  reasoned about:

  - **It reads _declared_ labels only — the publisher's own categories
    (`<category>Anzeige</category>` on a Mein-MMO deal article,
    `<category>Advertorial</category>` on a WinFuture one) and a delimited label
    in the title (`(Anzeige)`, `Anzeige:`, `… | Advertorial`). Reading the
    _body_ for monetization markers was tried and rejected**, and the reason is
    worth keeping because it looks so promising: `rel="sponsored"` links, an
    affiliate-commission disclosure and affiliate-network hosts separate ads
    from editorial _cleanly_ on the sample (0 markers on six editorial
    Mein-MMO/heise/Verge articles, 6–35 on the paid ones) — but only when
    measured inside the extracted article body. Measured on the **fetched
    page**, an ordinary editorial article scores 10–13, because the chrome
    around it (sidebar deal widgets, footer disclosures) carries them. And even
    body-scoped there is a real grey zone: a Caschy's Blog news post about a TV
    carries ten `rel="sponsored"` links because the CMS dropped an AAWP product
    box into the body — editorial content with an affiliate widget, which this
    filter must not delete. (That aggregator's `selectorsToRemove` already
    strips `.aawp`, which is why _its_ stored articles come out clean.)
  - **Whole-string matching against a vocabulary of labels, never a substring
    scan.** WinFuture ships a real `<category>werbefrei</category>` — "ad-free"
    — which a `/werbe/` prefix match reads as advertising, the exact inversion
    of its meaning. That was the only false positive of the first draft across
    419 live feed entries, and it is the reason the module takes whole strings.
  - **A topic is not a label, and three words that look like labels are
    deliberately out of the vocabulary.** `Deals`, `Angebote`, `Schnäppchen`,
    `Blitzangebote` and `Top Deals` are ordinary categories on articles nobody
    was paid for. Out for their own reasons: bare `werbung` (also the ad-industry
    trade press's _topic_), `promotion` (a doctorate, in German) and `ad`/`ads`
    (usually a section about ad platforms). `#werbung`/`#ad` are in, because the
    hashtag form is only ever a disclosure. The asymmetry deciding every one of
    those calls: a false positive **deletes** an article the reader wanted,
    while a false negative leaves one labelled ad in the list where the reader
    can see it — so an ambiguous word stays out.
  - **Every drop is logged to the triggering job's output**, with the label that
    caused it. The age filter beside it is silent on purpose: "older than the
    feed's cutoff" is arithmetic an operator can redo, "this looked like an ad"
    is a judgement they cannot. This is the one pipeline stage whose mistakes
    leave nothing behind to inspect, so the log line is part of the feature, not
    decoration.

  Two consequences elsewhere. `FeedEntry.categories` in
  `src/lib/aggregators/rss-parser.ts` exists for this and nothing else — the
  parser dropped `<category>` entirely before, so no downstream consumer could
  have worked — and it is **not** mapped onto this app's `tags` table: those are
  per-feed and user-owned, where these are per-entry and the publisher's. And
  only the RSS-derived aggregators carry categories at all (`rss.ts`,
  `sites/podcast.ts` and everything built on `FullWebsiteAggregator`); YouTube
  and Reddit produce none, so for those feeds the title channel is the whole
  check — which is not nothing, since a sponsored YouTube video is labelled in
  its title.

- **An aggregated article is only rewritten when its content actually changed**,
  decided by `articles.contentHash` (`articleContentHash()` in
  `src/lib/aggregators/content-hash.ts`). Three things about that hash are
  load-bearing and each was a real trap: it covers the feed's **own** `date`,
  never the stored one, because the handler's `raw.date || new Date()` fallback
  would otherwise make an undated feed re-hash on every run and never settle
  (which is why the update branch writes `rawDate ?? existing.date` rather than
  re-stamping `new Date()` — the column and the hash have to agree); **a
  comment is not the article, so neither the rendered comment section nor the
  raw page is an input** (next paragraph); and it is written **last, inside the
  one `writeTransaction()` that also writes the row and the block tree**, so a
  stored hash means the row _and_ its block tree are current for that content.
  That last ordering used to be enforced by hand and is now structural:
  `aggregate.ts` wrote the row, then the blocks, then the hash as three separate
  top-level transactions, and `reload.ts` did the same work in the opposite
  order — so an article became visible in stages, and a crash between two of
  them could leave a row with zero blocks and no hash, self-healing only while
  the feed still lists that entry, and reachable through `/api/v1` sync's `new`
  stream bodyless while that cursor advanced past it.
  `writeBlocksIn(tx, …)` (`src/lib/aggregators/blocks/storage.ts`) is the
  transaction-less body both handlers fold into their own single transaction;
  `writeBlocks()` is the thin wrapper for a caller with no row write of its own
  to join. The payoff is not only local I/O:
  `articles.updatedAt` carries `$onUpdate`, so an unconditional rewrite put
  every unchanged article back into `/api/v1`'s sync `updated` stream on every
  aggregation cycle. A `null` hash means "changed" — every row predating the
  column settles after one pass, and no backfill exists.

  **Both sides of the block store chunk on the same constant, and the inserted
  ids are paired by key rather than by position.** `SQL_VARIABLE_BATCH_SIZE`
  (100, in `blocks/storage.ts`) bounds every bulk insert _and_ every
  `inArray(...)` read-back against `SQLITE_MAX_VARIABLE_NUMBER` — 32766 by
  default, but as low as 999 on a differently-compiled SQLite. Only the writes
  were chunked at first, so on exactly the build that made batching necessary a
  long-form article could be written successfully and then throw "too many SQL
  variables" reading itself back; one constant in both directions is what keeps
  the two halves from disagreeing about the limit. And within a level's insert,
  each node is matched to its new id through a `(parentId, position)` lookup
  built from `RETURNING`, never through `insertedRows[i]`: SQLite documents
  RETURNING row order as **undefined**, and a positional pairing that was ever
  reordered would scramble the block tree with no error anywhere, so
  "simplifying" that map back into an array index reintroduces a
  silent-corruption path rather than removing a lookup. `writeBlocks`,
  `loadBlocksForArticles` and `readBlocks` are all synchronous and must stay
  so — better-sqlite3 has no async driver, and an `async` here is precisely
  what would stop a block write from being folded into a `writeTransaction()`
  callback (the case `NotPromise<T>` rejects).

  **The fingerprint is computed from the article _as fetched_, and the ordering
  that makes that true is load-bearing.** `rawArticleContentHash()` (same
  module) is the one derivation, called by `handleAggregateJob()` before it
  touches the row — and **AI post-processing runs below that check**, so nothing
  in the value can depend on model output. It did once: the AI stage rewrote
  `raw.name`/`raw.content` **in place** inside the aggregator pipeline, upstream
  of the handler, so for any feed with an AI option enabled the fingerprint was
  a hash of a non-deterministic answer — a different string on every run at the
  default `ai_temperature` of 0.3. Everything this hash exists to prevent was
  therefore happening every cycle for exactly those feeds: full rewrite, block
  tree deleted and reinserted, `updatedAt` bumped, article back in `/api/v1`'s
  sync `updated` stream. And the far larger cost, because the skip sat
  downstream of the provider request it should have prevented: every article
  sent to the provider again on every run, for a result discarded moments later.

  **A change that moves AI back above this call re-breaks both at once.** That
  is one of the two reasons the AI stage lives in the job handlers rather than
  in `finalizeArticles()`; the other is independent and structural — blocks only
  exist once `parseBlocks()` has run, and AI works on blocks now (see the
  `applyAiToBlocks()` bullet below). `handlers.test.ts`'s "calls AI for a new
  article and never again while it stays unchanged" and "calls AI again once the
  source article really changes" are the pair that fails if either half slips.

  **The hash still does not cover `finalizeArticles()`'s own stages** — the
  `processContent()` step the YouTube and Reddit aggregators run. Same trap
  already stated below for `parseBlocks`/`plainTextOf`, widened: a change there
  will not re-derive existing articles. Those stages are deterministic functions
  of the fetched article, which is what makes fingerprinting the input sound.
  Hashes for YouTube and Reddit articles therefore changed once on deploy and
  settled after one pass, the same settlement a `null` hash gets.

  **A comment changing is not the article changing, and two exclusions are
  needed to mean it.** `formatArticleContent()`
  (`src/lib/aggregators/extract/format.ts`) renders comments into the same body
  the block tree is parsed from, so a busy thread used to rewrite the row on
  every cycle — deleting and reinserting the block tree, spending an AI request,
  and pushing the article back into `/api/v1`'s sync `updated` stream — for text
  nobody edited. So the fingerprint cuts that section off, matched with
  **`ARTICLE_COMMENTS_CLASS`, exported from `extract/format.ts` and imported by
  `content-hash.ts`, so the wrapper has one definition rather than being written
  in one file and restated in the other** — a test drives real
  `formatArticleContent()` output through the fingerprint, so renaming the value
  cannot silently end the exclusion. **Every commenting site must thread its
  comment markup through `formatArticleContent()`'s `commentsContent`
  parameter rather than concatenating it into the block-source html itself** —
  Reddit and YouTube used to do the latter, building a bare, unwrapped comment
  section straight into `content`, so a busy Reddit thread or a YouTube
  video's comments changing gave every active one of those articles a new
  fingerprint on every aggregation cycle. `buildPostContent()`
  (`sites/reddit/content.ts`) and `YouTubeAggregator.enrichArticles()`
  (`sites/youtube/aggregator.ts`) now keep the comment section separate
  (`RedditPostContent.comments` / `_youtube_comments_html`) until
  `processContent()` hands it to `formatArticleContent()` as `commentsContent`
  — five commenting sites in total now comply: heise, mactechnews, mein_mmo,
  reddit, youtube (four of which build the section itself through the one
  `buildCommentsSection()` declaration — see its own bullet below). And it
  **ignores the raw page**: `mactechnews`, `mein_mmo` and `heise` scrape their
  comments out of the very page they fetched, so
  hashing it would let a comment rewrite the article through the back door.
  Three details:
  - **The cut is a string operation, not a parse.** A parser would mean
    `cheerio` in this module's graph, which the aggregate handler imports before
    it has decided to do any work — the same reason `3d949a9a` kept cheerio out
    of the AI prompt endpoint's graph. It is safe because the comment section is
    appended _last_; `lastIndexOf` handles the one hazard, which is that
    `sanitizeClassNames()` rewrites every `class` into `data-sanitized-class`,
    so a source page carrying `class="article-comments"` arrives looking like
    our own wrapper.
  - **The result is trimmed.** Sections are joined with `\n\n`, so removing the
    last one leaves that separator dangling, and a body plus trailing whitespace
    does not hash equal to the same body without it — precisely the case the
    exclusion exists to make equal.
  - **It governs what _triggers_ a rewrite, not what gets stored.** When the
    article's own content does change, the current comment section rides along
    into the row as before.

  **Reddit and YouTube now store comments differently depending on which path
  produced the article, and that divergence is new.** `processContent()` on
  both aggregators only wraps `commentsContent` in the `ARTICLE_COMMENTS_CLASS`
  section when `_reddit_comments_html`/`_youtube_comments_html` is set —
  which only `enrichArticles()` (the aggregation path) does. `reload.ts` never
  runs `enrichArticles()`, so on that path the two sites' own content-building
  code concatenates comments straight into the body, unmarked, exactly as
  aggregation itself used to before this fix. The stored block tree is
  therefore not the same shape depending on whether an article arrived via
  aggregation or a manual reload, on the same feed, for the same post. **The
  2026-09-03 "unify the parallel paths" plan did not close this**, so read it as
  an open gap rather than a closed one: that plan unified the scraped sites'
  enrichment (`enrichOne()`) and the comment-section builder, but `reload.ts`
  still never runs `enrichArticles()`, which is the only thing that sets those
  two fields. It is Reddit and YouTube alone — the scraped commenting sites
  (heise, mactechnews, mein_mmo) extract their comments inside
  `processContent()`, which both paths run, so their section is marked either
  way.

  **Excluding the raw page is what left `articles.raw_content` with no reader,
  and it is now gone.** It held the whole fetched page, justified as "the
  debugging surface, and what the reload action re-runs against" — the second
  half was never true (`article.reload` always re-fetches; that is the point of
  a reload), and once the page stopped being a fingerprint input, nothing about
  a row depended on it being current either. `raw_content` on the in-memory
  `RawArticle` stays: aggregators pass the fetched page between their own stages
  through it, and it is still the fallback for the block source when an
  aggregator distilled no `content`.

  **An article whose AI stage did not complete is skipped whole — nothing is
  written for it at all.** The feed asked for that article to be summarized,
  translated or rewritten and it wasn't, so what the handler has in hand is not
  the article the feed is configured to have. Storing it anyway was wrong in
  both directions: a _new_ article appeared in its original language and stayed
  that way until its source happened to change, and an article already stored —
  possibly the successfully processed version of this very item — was
  overwritten with the un-processed one over a transient 503. Skipping costs a
  cycle's delay and nothing else: no row write means no fingerprint either, so
  the next run treats the item as outstanding and adds it whole. An earlier
  version stored the row and merely withheld the fingerprint, which retried but
  left the half-done article visible in the meantime. The count reaches the
  job's summary line (`N skipped (AI: reason)`) so a run that stored fewer
  articles than the feed listed says why rather than looking like a quiet feed.

  **A _degraded_ result is the one exception to skipping whole, and it is a
  fourth arm rather than a footnote on `failed`.** `ApplyAiOutcome`
  (`src/lib/ai/run.ts`) is `skipped` / `applied` / `degraded` / `failed`:
  `failed` means `blocks` and `title` are the input verbatim and nothing should
  be written, where `degraded` means the rewrite genuinely came back and only a
  secondary part of the request did not — today only `missingSummary`, and only
  when a rewrite was asked for as well (a summarize-only request has nothing to
  keep, so that case still reports `failed`). That distinction used to live only
  in a comment, which is exactly how both callers came to disagree with it and
  with each other: `handleAggregateJob()` discarded `ai.blocks` on _any_
  non-applied outcome, throwing away the "a missing summary keeps the rewrite"
  asymmetry this file documents, while `reload.ts` wrote blocks, title and
  `plainText` _before_ inspecting the outcome and then threw — so a missing
  summary over a good rewrite stored correctly, marked the job **failed**, and
  mailed its owner a failure notice (`notifyJobFailure()`) for a run that was
  ninety per cent a success. Both branch on the arm now: aggregation stores it
  and counts it, adding `, N stored degraded (AI: reasons)` beside the skip
  count on the summary line, and reload stores it, logs the caveat and leaves
  the job green.

  **A successful manual reload and `updateArticle()` both keep the fingerprint,
  so a deliberate local change stands.** Both used to null it, which made every
  manual action provisional until the next cycle discarded what an operator had
  just asked for. The fingerprint is taken over the article as fetched from
  _source_ rather than over the bytes stored, so leaving it is correct in both
  directions: while the source is unchanged the next run computes the same
  value, matches and skips, and when the source really does change the values no
  longer match and the fresh upstream article correctly replaces the local one.
  A **failed** reload still nulls it — an error notice is not a complete
  article, and the next run replacing it is the only thing that heals it — and
  the empty-body branch already reasoned this way for the case where it writes
  nothing. The one case a reload cannot make stick is a row whose fingerprint is
  already null: the value has to be one the _aggregator_ would compute over the
  feed's own article rather than the page reload fetched, so such a row is
  reprocessed once and settles.

  **There is one exception to "a successful reload keeps the fingerprint", and
  it is the AI stage dropping media.** "Leave it" rests on the stored blocks
  being the best available version of the article; a rewrite that lost a
  media/code placeholder is not that. So when `applyAiToBlocks()` reports
  `droppedMedia`, `reload.ts` nulls the hash explicitly and
  `handleAggregateJob()` withholds its own hash write — the same decision from
  the two ends: leaving a still-matching hash in place would let the next
  aggregation run compare against the (unchanged) source, match, skip, and lose
  the dropped image for the life of that source article. See "What the model
  dropped is counted and reported" in the `applyAiToBlocks()` bullet for the
  cost this accepts in exchange.

  **The invariant binds every writer, not just the aggregator: anything that
  changes an article's content must set `contentHash` to null** (or recompute
  it). A stale hash does not merely go out of date — it makes the aggregate
  handler skip that row _forever_, because the hash it computes from the
  unchanged feed item keeps matching. One writer learned this in review and now
  nulls it explicitly: `src/lib/jobs/handlers/reload.ts`, where a _failed_
  refetch writes an error notice that without this would have been permanent,
  and where a successful reload whose AI stage dropped media nulls it for the
  reason the exception above gives. (Its third failure mode, an empty body,
  writes nothing at all and therefore has nothing to null — see the
  `hasBodyContent()` bullet.) `updateArticle()` in `src/lib/articles/actions.ts`
  writes `name` and `date` (both fingerprint inputs) _without_ nulling
  anything — see "A
  successful manual reload and `updateArticle()` both keep the fingerprint"
  above — and forbids changing `feedId` (half the key the handler looks a row
  up by) outright, returning a catalog `errorKey`, rather than nulling the hash
  on every move: `feedId` is a lookup key, not a fingerprint input, so no hash
  value could stand in for the original feed simply forgetting the row exists.
  Writers that only flip `read`/`starred` must leave
  it alone: nothing about the content changed, and nulling it would force a
  pointless full rewrite on the next cycle. The same trap waits for **any future
  change to `parseBlocks`/`plainTextOf`** — existing articles would never be
  re-parsed, where they used to be re-derived every cycle. The full statement is
  the `contentHash` comment in `src/lib/db/schema/articles.ts`; this is its
  summary, not a second version of it.

  **That trap has already been paid once, and knowing how is the point.** The
  `inlineContext()` fix in `parseBlocks()` (see the bullet below) corrected
  styling and hrefs that were being dropped, but it does **not** re-derive an
  article already stored: its fingerprint still matches, so the skip fires and
  the old, lossy block tree stays. Articles fixed themselves only as their
  source changed. Nulling every `contentHash` to force a re-parse was considered
  and rejected: it would put every article back through the full write path
  _and_ through a fresh provider request, which is the exact cost the rest of
  this branch exists to remove. A parser fix that has to reach stored rows needs
  a re-parse path that re-fetches or re-extracts and rewrites blocks **without**
  calling AI; there is no such job today, and `articles.raw_content` — which
  would have been the cheap way to do it — is gone (see the fingerprint bullet).

- **`convert()` must hand `inlineRuns()` an element's own inline context —
  `inlineContext()` in `src/lib/aggregators/blocks/parser.ts`.** `inlineRuns()`
  reads a tag only while descending _into_ it, so an inline element that is a
  **direct child** of a converted container needs its own tag applied before the
  descent. `convert()` did not do that: its `INLINE_TAGS` branch called
  `inlineRuns($, node, baseUrl)` with no styles and no link, and the element's
  own `<b>`/`<i>`/`<a href>` contributed nothing.

  It looked fine because the case everyone tests worked: `<p>a <b>x</b></p>`
  keeps its styling, since the `p` branch hands the _paragraph_ to
  `inlineRuns()` and the `b` is therefore a child. Every other container lost
  it — `<li>`, a bare `<blockquote>`, any `<div>` whose text is not wrapped in a
  `<p>`. And the styling was the mild half: **a link in that position lost its
  href entirely**, so every bulleted list of links in every article stored plain
  text with no URL. Measured, not theorised — the same markup in a `<p>` and in
  an `<li>` gave one link and none.

  So **a new container branch in `convert()` has to pass `inlineContext()`'s
  result**, not call `inlineRuns()` bare. `parser.test.ts`'s "inline styling and
  links survive as a direct child of any container" block covers a list item, an
  ordered list item, a bare blockquote, a bare div and a paragraph together,
  precisely because passing for one container proved nothing about the others.

- **An article with no body is skipped, never stored — `hasBodyContent()` in
  `src/lib/aggregators/website.ts` is the one predicate, and "no body" means no
  text _and_ no media.** A selector miss is not the only way to extract nothing:
  a site's own `selectorsToRemove` can match every child of a container that
  _was_ found — Heise strips a blanket `section` and puts body paragraphs inside
  `<section>` on some templates — so `extractContent()` reports no error and
  returns markup with no article in it. `formatArticleContent()` then prepends
  the header image unconditionally, and what reached the database was a header
  image above an empty `<section>`: a real, shipped article, and it survived a
  week before anyone noticed. Four things about the rule:
  - **The check is in `enrichOne()`** (`src/lib/aggregators/website.ts`),
    between `extractContent()` and `processContent()`, and answers through the
    caller's `EnrichmentPolicy` rather than deciding for itself — for
    `FullWebsiteAggregator.enrichArticles()` that answer is the existing
    `return null` skip path, so the article never reaches `aggregate.ts` at
    all. It therefore covers that class and its subclasses (heise, merkur,
    caschys, mein_mmo, mactechnews, tagesschau, the three comics, plus
    `RssSummaryFallbackAggregator`'s verge and ars). YouTube, Reddit, Podcast
    and plain "Feed Content" feeds extend `RssAggregator`/`BaseAggregator` and
    are deliberately outside it: they assemble a body from a description plus an
    embed rather than by scraping a page, so an empty extraction is not a thing
    that happens to them. Heise is the only subclass overriding
    `enrichArticles`, and it delegates to `super`.
  - **Text _or_ media, and the `or` is load-bearing.** Oglaf, Explosm and Dark
    Legacy build their entire body from `extractContent()`'s output and it is
    legitimately a bare `<img>` with no text at all — a text-only check skips
    every comic article in the tree.
  - **Skipping is the point, not merely refusing the write.** An aggregation run
    only ever sees the entries the feed currently lists, and that window is
    short (heise.rdf holds ~150 undated items, roughly two days), so a stored
    stub is permanent: nothing refetches an entry that has aged out, and the
    `contentHash` update branch can only repair a row while the entry is still
    listed. Dropping it leaves the next run free to create it properly — which
    is the case this exists for, a site that publishes a stub and fills in the
    prose later.
  - **The skip logs** (`console.warn` + `onLog`, so it lands in the job output).
    Silence at ingestion is half of why the original case went unnoticed; the
    other half was that `reload.ts` logged the empty case and wrote it anyway.

  **`reload.ts` answers the same condition the opposite way, the asymmetry is
  the decision, and it is now _stated_ rather than implied.** Both paths run one
  `enrichOne(article, policy)` — extractHeaderElement → fetchArticleContent →
  extractContent → `hasBodyContent()` — and each supplies its own
  `EnrichmentPolicy`: two named hooks, `onFetchFailed` and `onEmptyBody`, whose
  return value is "keep this article as it is", `null` ("dropped or handled, the
  side effect is already done") or a throw ("fail the job"). Reload used to
  reimplement those five steps with four different failure policies spread
  across two files, so the divergence had to be reconstructed from the shape of
  four try/catch blocks; the divergence itself is unchanged and is a decision,
  not drift. `processContent()` is deliberately _outside_ the shared function,
  because reload reports job progress between "content extracted" and "content
  processed" and that boundary has to stay visible to the caller. So does the
  outer catch: `enrichOne()` wraps only `fetchArticleContent()`, and
  `enrichArticles()` restores its own wider "anything in these four steps
  counts" catch around its call, routing it to the same `onFetchFailed` hook —
  reload adds no such wrapper and still lets those exceptions propagate,
  exactly as each did before. Reload's two failure modes are not variants of one
  branch:
  - **The page will not fetch** → the content is replaced with a short error
    notice and `contentHash` nulled. Unchanged, and correct — the page is gone,
    so the stored copy is worthless.
  - **The page fetches but has no body** → **nothing is written at all** and the
    job is failed. The page still exists, so the stored article is the best copy
    anyone has, and `processContent()`'s output would put the header image over
    an empty body — the very shape the ingestion rule refuses. `contentHash` is
    left alone too, deliberately: nulling it would make the next aggregation run
    rewrite a row this reload explicitly declined to change. Reload cannot skip
    the way aggregation does, because the row already exists; failing the job is
    the equivalent, and it is what puts the reason in front of the operator —
    `jobs.error` is rendered **verbatim** in the job list
    (`src/components/jobs/jobs-table.tsx`), so the thrown message is
    user-facing English prose rather than a catalog key, the same convention the
    AI-failure throw at the bottom of that handler already follows. The check
    sits ahead of `processContent()`, so the AI stage below it is never reached:
    there is no point spending a provider request on a body that is not there.
  - **A fetch that _returns_ nothing is a fetch failure, not an empty body**,
    and only reload says so: it wraps its aggregator so a `""` from
    `fetchArticleContent()` throws, landing on `onFetchFailed` (write the error
    notice) instead of falling through to `onEmptyBody` (fail the job). "The
    feed no longer lists this entry" is the same condition as "the page would
    not load". Aggregation deliberately does not get that treatment — there, an
    empty fetch should fall through to extraction and, ordinarily, to the skip —
    which is why the wrapper lives at reload's call site rather than inside
    `enrichOne()`.

  **"The selector found nothing" also has one answer now, and one site's
  behaviour changed with it.** `extractContentWithFallback()` is the three-tier
  ladder every `FullWebsiteAggregator` subclass shares — the site's own
  selector when it has real body content, then a generic content guess gated on
  a minimum text length so a sidebar snippet cannot win, then the RSS entry's
  own summary — replacing four sites' separate answers. **Never `<body>`:**
  `MerkurAggregator` used to recurse into `super.extractContent()`, which fell
  back to the whole document, so a selector miss there could surface site
  navigation, cookie banners and related-article rails _as the article_. A miss
  now degrades to _less_ content rather than _wrong_ content.
  `keepPrimaryRegardless` is the one escape hatch, for `TagesschauAggregator`,
  whose primary extraction can legitimately carry no text or media of its own
  (an audio/video report whose body is a media header `processContent()`
  splices in later, which `hasBodyContent()` cannot see because it is not in
  the extraction at all).

- **There is one sanitizer for untrusted HTML that gets stored:
  `sanitizeUntrustedFragment()` in `src/lib/aggregators/extract/clean.ts`.**
  Scraped comment markup, a Reddit post's converted Markdown and a podcast's
  show notes all pass through it on the way to the database, and
  `GET /api/v1/articles/[id]/content` serves what was stored — so this is the
  last line of defence, not tidying. It strips HTML comments, removes
  `script`/`object`/`embed`/`style`/`iframe` outright, deletes every `on*`
  attribute, and refuses any `href`/`src` whose scheme `isSafeUrl()` rejects
  (an unsafe link loses its `href` and keeps its text; an unsafe `<img>` is
  removed, because an image has no safe fallback rendering). Two things about
  it are worth knowing before changing it:
  - **The rename-then-delete of `class`/`style`/`id`/`data-*` is not
    redundant.** `sanitizeHtmlAttributes()` converts them to
    `data-sanitized-*` and `removeSanitizedAttributes()` then strips those, and
    that two-step is what stops a fragment carrying a literal
    `class="article-comments"` from forging the marker
    `formatArticleContent()` wraps the real comment section in — the marker
    `content-hash.ts` cuts on by `lastIndexOf` (see the comment exclusion in
    the `contentHash` bullet above). A forged second marker _inside_ the real
    wrapper would make that `lastIndexOf` find the wrong one and defeat the
    comment exclusion permanently for that article.
  - **It existed six times, byte-identical, before it existed once**
    (`sites/mactechnews/comments.ts`, `sites/mein_mmo/comments.ts`,
    `sites/heise.ts`, `sites/youtube/aggregator.ts`,
    `sites/reddit/markdown.ts`, `sites/podcast.ts`), which is why it
    deliberately takes **no options and no site parameter**: every call site's
    needs turned out identical, and a parameter nothing uses is the seam the
    next divergence drifts back through. A hardening applied here now reaches
    all six at once instead of whichever one someone remembered.
    `selectAllIncludingSelf()` in the same module is the other half of that
    de-duplication — the `.addBack("*")` "walk every element including the
    selection itself" ternary that four functions in that file each wrote out.

- **A comments section is a _declaration_, never a fourth copy of "emit a
  heading and N blockquotes": `CommentSpec` + `buildCommentsSection()` in
  `src/lib/aggregators/comments/section.ts`**, in the shape
  `defineIntegration()` already established for credentials. The builder owns
  the sequence — list, slice to `max`, render each comment, wrap, empty state —
  and every comment body goes through `sanitizeUntrustedFragment()` **inside
  the builder**, which is the structural point of the extraction: a fifth
  comment source cannot forget it. (Reddit's markdown converter already
  sanitizes on the way to HTML, so that pass runs twice for Reddit; it is
  idempotent, and an unconditional call is worth more than a saved pass.) What
  survives as descriptor _data_ is real, observed per-site difference, kept
  rather than normalised away: mactechnews and mein_mmo wrap the section in a
  bare `<section>`, YouTube in a `div.youtube-comments`, and Reddit in
  **nothing at all** — its heading rides bare inside
  `formatArticleContent()`'s own `ARTICLE_COMMENTS_CLASS` wrapper, so a
  wrapper here would be a second nesting level nobody asked for. The four
  empty states are one optional field: `emptyLabel` unset means drop the whole
  section, heading included (mactechnews, mein_mmo, YouTube), against Reddit's
  three status messages, which is a real difference in what an empty thread
  means on each site. The author and timestamp reads, and whether the source
  link carries `target="_blank" rel="noopener"`, differ the same way.
  **`heise.ts` is not
  on the builder** — four sites on the builder, five commenting sites in
  total — but not for a uniform reason, and one of its two renderers really
  is a remaining duplicate rather than a structurally different case.
  `processListItemComment()` (heise.ts:101-106) is the genuine exception: its
  per-comment body is the posting's _subject line_ rather than markup, which
  the builder has no shape for. `processFullViewComment()` (heise.ts:151-158)
  is not — it emits the exact same
  `<blockquote><p><strong>author</strong> | link</p><div>{sanitized
markup}</div></blockquote>` shape the builder's non-`multiline` branch
  produces, under the same `<section><h3><a>Comments</a></h3>` wrapper
  (heise.ts:465-466). Converting it was not attempted: heise's two-renderer
  dispatch and its nested-reply handling are real complexity that a
  three-value `CommentSpec` field cannot express cleanly, so the second
  duplicate was left in place rather than forced onto the builder for its
  own sake. **And the failures log now.** This is the most
  selector-fragile code in the tree, and every implementation of it used to end
  in `catch { /* ignore */ }` — heise had two — so a site that quietly stopped
  yielding comments looked exactly like a site whose readers had stopped
  commenting. A failure inside `spec.list()` or one comment's render is caught,
  logged through `onLog` (so it reaches `/jobs/<id>`) and degrades to `null`:
  the same "skip rather than break the article" behaviour, minus the silence.

- **A paginated article is fetched by one function, and it hands back _two_
  things because one of them is the page a comment extractor needs.**
  `fetchAllPages()` in `src/lib/aggregators/multipage.ts` returns
  `{ combined, firstPage }` — `combined` being every page's matched content
  container joined in page order, which is what the site's own
  `extractContent()` selector runs against next, and `firstPage` being page 1
  raw and un-truncated. Both are needed because a comment section can live
  _outside_ the content selectors: MacTechNews' `div.MtnCommentScroll` is a
  sibling of the `.MtnArticle` containers `combined` is built from, so a
  comment extractor handed `combined` finds nothing — and found nothing.
  **Every multi-page MacTechNews article lost all of its comments**, on
  aggregation and on reload, for as long as that site replaced its fetched page
  with the combined output. Mein-MMO had already hit this and carried a private
  `firstPageHtmlByUrl` workaround; the fix was one shared `FirstPageStash` used
  identically by both sites rather than a second copy, and Mein-MMO's map was
  deleted. **The stash is keyed by URL and `take()` deletes on read**, and it
  cannot be collapsed into a single instance field:
  `fetchArticleContent(url)` is handed no article to attach state to, and
  `FullWebsiteAggregator.enrichArticles()` runs it for up to
  `this.concurrency` articles _concurrently_ on one aggregator instance, so one
  field would hold a sibling article's page while this article's own
  `processContent()` was still awaiting — exactly the race Mein-MMO's original
  field hit. `detectPagination()` stays per-site, because how a pagination
  widget looks in the DOM legitimately differs where the fetch loop did not.

- **Every "is this YouTube, and which video is it" question is answered by one
  module: `src/lib/aggregators/embeds/youtube-url.ts`** — `youtubeIdFrom()`,
  `isYoutubeUrl()`, the domain list and the thumbnail builder. **It imports
  nothing, and must stay that way**, for the same reason `src/lib/secrets.ts`
  does: `src/components/articles/block-node.tsx` is a **client component** and
  needs `youtubeIdFrom()` to turn a stored embed's `externalUrl` back into an
  iframe `src`, while `embeds/youtube.ts` — the rest of that provider — imports
  `storeImageRefFromUrl` (node `fs`) and re-exports from `website.ts`, so a
  client component structurally cannot import from it. The URL half is split
  out for the browser and `embeds/youtube.ts` re-exports it unchanged, so every
  server-side caller is untouched; it carries the same specifier tripwire test
  as the other dependency-free modules (see that list under `/integrations`).

  **Six copies disagreed about which URL forms count, and the disagreement was
  a live bug rather than untidiness.** `website.ts` gated on `isYoutubeUrl()`,
  which accepts `youtube-nocookie.com`, and then called an extractor with no
  nocookie pattern — so a privacy-embedded video yielded `null`, was left
  untouched, and heise/merkur/mein_mmo's `selectorsToRemove` then **deleted it
  outright**. `youtube.com/live/<id>` went the same way. Fixing it took two
  halves and the second is the non-obvious one: the deletion happens inside
  `extractContent()`, one stage _before_ `processContent()` proxies embeds, so
  a complete extractor is not enough on its own. The three sites' literal
  `iframe:not([src*='youtube.com']):not([src*='youtu.be'])` copies are now one
  shared `YOUTUBE_IFRAME_KEEP_SELECTOR` in the same module, which does name the
  nocookie domain — so **a new URL form has to be added to the patterns _and_
  be survivable by that selector**, or it is recognised one stage too late to
  matter. Two inline extractors stay deliberately separate —
  `blocks/parser.ts`'s `YOUTUBE_PATTERNS` and `sites/mein_mmo/embeds.ts`, each
  applying its own tighter constraint on the captured id's length — but both
  read `YOUTUBE_EMBED_DOMAIN_ALTERNATION` from here instead of hand-maintaining
  a domain list, which is how one of them fell behind in the first place.

  `isTwitterUrl()` had the same shape of bug and is only **partly** unified.
  `extract/format.ts` now parses the hostname and `images/strategies.ts`
  imports it, because the `url.includes(domain)` version they shared read
  `https://evil.example.com/?ref=twitter.com` as Twitter. `embeds/twitter.ts`
  still carries its own substring copy, used only inside that module: a third
  copy with the original bug still in it, left alone rather than quietly
  widened into, and worth knowing about before anything new starts calling it.

- **The article-image store is content-addressed and refcount-free, so nothing
  ever deletes "one article's images" — the only thing that removes a row is
  `sweepUnreferencedImages()` in `src/lib/aggregators/images/store.ts`, mark-
  and-sweep GC that the nightly `retention` job (`src/lib/jobs/handlers/
retention.ts`) runs once per run, after that run's own article deletions,
  never per user.** There are exactly three reference roots —
  `articleBlocks.imageRef`, `articleBlocks.embedThumbnailRef` and
  `feeds.logoImageHash` — verified against the schema rather than assumed, and
  they are the same three `GET /api/v1/images/[hash]`'s `ownsHash()` checks.
  **Adding a fourth place a `yana-img://` hash can live obliges you to add it
  to this sweep's reference scan** — an image root the sweep doesn't know
  about is an image root it will happily delete out from under, silently,
  since nothing else in the schema tracks a refcount for it. Two things about
  it are easy to get backwards:
  - **The two encodings are not the same, and conflating them deletes every
    image on the instance.** The two `articleBlocks` columns store the _full_
    `yana-img://<hash>` ref; `feeds.logoImageHash` stores the _bare_ hash, the
    same encoding `articleImages.contentHash` itself uses. The sweep strips
    `IMAGE_REF_SCHEME` off the block columns before joining the referenced
    set — compare an un-stripped ref against a bare hash and it matches
    nothing, and "matches nothing" here means every row in the table reads as
    unreferenced.
  - **Delete the database row before the file, never the reverse**, the same
    ordering `removeAvatar()` already uses and for the same reason: the two
    writes can't be one atomic operation (better-sqlite3 has no async driver,
    so the `fs.rm` can't live inside the same synchronous `writeTransaction()`
    callback as the delete), so a crash between them is possible, and
    row-then-file means a crash there only leaks an orphaned file — harmless,
    and exactly the state a later sweep would have produced anyway. File-then-
    row would instead risk a database row surviving with no file behind it,
    which `GET /api/v1/images/[hash]` cannot serve and throws on.
  - **A row younger than 24 hours is never swept, no matter what the
    reference scan finds** — the grace window closes a real race, not a
    theoretical one. An image is stored (`storeImageRefFromUrl()`, called from
    roughly fifteen aggregator/embed modules) _during_ the aggregator's own
    `aggregate()` run, while the `article_blocks` row that will reference it
    is written much later — one article at a time, in `handleAggregateJob()`'s loop, behind AI
    calls and a per-article `aiRequestDelay` sleep. On a large feed with AI on
    that gap is tens of minutes to hours, and `scheduler.ts` enqueues
    `aggregate` and `retention` in the same tick while `startWorker()` runs
    several worker loops concurrently — so retention routinely runs while
    another loop is mid-aggregation. Without the window, the sweep would
    delete a just-fetched image's row and file before the block referencing it
    exists; the article then gets a `yana-img://` ref pointing at a deleted
    file, and because its `contentHash` _is_ written, the row is skipped on
    every later aggregation run forever — a permanently broken image with no
    repair path. 24 hours is sized against the sweep's own cadence (nightly),
    not picked arbitrarily: a true orphan is just collected on the next run,
    at the cost of one extra day of leaked storage, the same "prefer leaking
    to breaking" trade-off the row-then-file ordering above already makes. Do
    not tune it toward zero.

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
    is a user-id enumeration oracle. (`requireAdmin()` throws a 404 for the same
    reason — this route handler has no boundary above it, so unlike a page it
    really does answer one; see the `requireAdmin()` bullet.)
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
    is six: those three plus `src/lib/ai/providers.ts`, `src/lib/ai/bounds.ts`
    and `src/lib/aggregators/embeds/youtube-url.ts` (whose client-component
    consumer is named in its own bullet above), each with the same regex test
    beside it — one that catches a static `from`, a dynamic `import()` and a
    `require()`, after stripping comments. A comment saying so is not the rule
    being kept: `bounds.ts` had only the comment until phase 7's fix wave,
    while feeding both the browser's `min`/`max` and the server's zod schema,
    and `avatar.ts` had only the comment for two phases after that — while
    **this list already claimed a test was beside it**. Adding the fifth is
    what made the sentence true. Check the list rather than trusting it:
    `grep -rl "imports nothing at all" src/` must return one test per module
    named here — plus exactly two files that mention the convention without
    being one of its tests (`src/app/server-component-props.test.ts` and
    `src/lib/aggregators/specs.ts`, both of which name it in a comment), so
    subtract those two before counting. Other modules in the tree happen to
    import nothing — `src/lib/aggregators/blocks/types.ts` is one — but they
    are not on this list, because a module is only on it once the tripwire
    exists.
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
    prompt and JSON-mode flag. It replaced four copies of the
    request-building and response-parsing block, and the per-provider
    `callOpenai()`/`callMistral()`/`callQwen()`/`callDeepseek()` methods that
    used to call it are themselves gone: dispatch is a table now, keyed by
    provider — see the `PROVIDER_REQUESTS` bullet below.

  **OpenRouter was added afterward, independently of the 2026-08-04 plan and
  of yana-ios parity — it has no yana-ios equivalent at all.** It reuses both
  helpers above (`openaiCompatibleChatProbe()` for its probe, and an
  `openai-compatible` row in `PROVIDER_REQUESTS` for the runtime call) and is,
  like Mistral/Qwen/DeepSeek, a fixed, non-configurable endpoint
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

  **`resolveModel()` is not a display-only substitution — `src/lib/ai/run.ts`
  calls it too, on every one of the seven provider branches, so its answer is
  the model id actually sent to the provider and billed.** It used to read the
  raw `user_settings` column directly in `run.ts` while `/ai`'s own status read
  went through `resolveModel()`, so a row written before a registry refresh
  (still holding a retired id like `gpt-4o-mini`) showed the _substituted_
  current model on `/ai` with a green badge while every real aggregation
  request sent the retired id and failed outright — the only trace a per-article
  `AI processing did not complete (providerError)` job-log line. Fixed by
  routing `run.ts` (and `POST /api/v1/ai/prompt`'s reported model) through the
  same `resolveModel()` call `getAiStatus()` already made, so the id shown, the
  id sent and the id billed cannot again disagree.

- **There is no per-user AI request cap and no output-token cap, and the
  absence of both is a decision.** The
  2026-08-04 plan added one — `aiDefaultDailyLimit`/`aiDefaultMonthlyLimit`
  among the tuning values, an `ai_requests` table
  (`src/lib/db/schema/ai.ts`), and `checkAndRecordAiUsage()`
  (`src/lib/ai/usage.ts`) gating `AIClient.generateResponse()`. All of it was
  **removed on the owner's explicit instruction**: with AI switched on it is
  expected to run without a quota refusing it. Gone with it are both settings
  and their two `bounds.ts` entries, the
  `monthlyLimit >= dailyLimit` `.superRefine()` in `src/lib/ai/actions.ts`
  (the only cross-field rule that schema ever had, and the reason
  `advanced-section.tsx` submits the card as one unit — it still does, but now
  only because the knobs are one group, not because the server needs the pair),
  the `dailyLimitExceeded`/`monthlyLimitExceeded` arms of
  `AiGenerationResult`, the `bypassUsageLimit` parameter that `reload.ts`
  passed to opt a hand-triggered reload out of the caps, the
  `daily_limit_exceeded`/`monthly_limit_exceeded` codes on
  `POST /api/v1/ai/prompt` (which can no longer answer 429 at all), and seven
  catalog keys per locale. Migration `0019_drop_ai_request_limits` drops the
  table and the two columns — drops only, so `drizzle-kit generate` produced it
  non-interactively, exactly as the split-migration rule above predicts.

  **`aiMaxTokens` went the same way, on the same instruction, and it was the
  more damaging of the two.** `0020_drop_ai_max_tokens` drops the column; the
  `maxTokens` bound, the `advanced.maxTokens*` catalog keys and the field's
  place in `AI_ADVANCED_FIELDS` went with it, taking the tuning values from
  seven to six. (A later removal took it to **five**: `aiMaxPromptLength` —
  the last Yana-imposed AI limit, enforced only by `POST /api/v1/ai/prompt` —
  went with the request caps for the same reason, along with that route's
  `prompt_too_long` code; see the `aiMaxPromptLength` bullet below for the
  detail.) A request cap only ever refused work; this one
  _corrupted_ it. Its default of 2000 was below what a rewritten article needs, so a longer
  one came back truncated mid-JSON, failed to parse, and spent the whole paid
  request on an `invalidJson` failure — and no correct value exists to set it
  to, because it is the length of an answer nobody has seen yet. So
  `src/lib/ai/run.ts` now sends **no output cap at all**: no `max_tokens` on any
  OpenAI-compatible provider, no `maxOutputTokens` on Gemini. The one exception
  is Anthropic, whose Messages API declares `max_tokens` **required** — that
  branch sends the `ANTHROPIC_MAX_TOKENS` constant (16000, chosen well above any
  article this stage sends and below what a non-streaming request can return
  before the API's own timeout), which is a safety limit rather than a
  truncation point. `run.test.ts`'s per-provider sweep asserts the absence on
  every other provider, so a reintroduced cap fails a test rather than only
  failing on a long article. **The probes are unaffected and must stay that
  way**: every `max_tokens: 1` in `src/lib/ai/*.ts` and
  `src/lib/integrations/probe.ts` is a deliberate one-token credential check,
  not a user-facing ceiling.

  **What replaced it is structural, not a ceiling, and that is the whole
  point.** A cap only ever refused work already decided to be worth doing,
  while the two real sources of waste were requests nobody wanted in the first
  place: an article the feed already had (now skipped by the handler's
  `contentHash` check, which AI runs below — see the `contentHash` bullet) and
  fields nothing
  reads (now not asked for — see `wantsRewrite` below). Neither costs anything
  when the work _is_ wanted, which a quota cannot say. **Do not reintroduce a
  cap without that decision being revisited**; `run.test.ts`'s "no request cap
  in front of a call" block is what fails if one appears, including a check
  that `aiRequests` is absent from the schema barrel so nothing can quietly
  start counting again. That block is also why that file needs no database
  fixture: with the counter gone `run.ts` reaches no database at all, so the
  temp-database-plus-`vi.resetModules()` shape it used to carry — fifteen cold
  dynamic imports for a dependency the module no longer has — was removed and
  the import is static.

  `generateResponse()` still returns `AiGenerationResult` —
  `{ ok: true; text } | { ok: false; reason }` — rather than the
  `string | null` it began as, with `reason` now one of `noProvider` /
  `providerUnauthorized` / `providerError`. **`providerUnauthorized` is the one
  worth keeping straight**: thrown as `ProviderUnauthorizedError`
  (`src/lib/ai/run.ts`) from `requestWithRetry()` on a 401 or 403 — the
  credential itself was rejected, not a transient failure — and caught in
  `generateResponse()`'s own catch, distinctly from every other failure, which
  still collapses to the generic `providerError`. The distinction exists for
  the same reason `/ai`'s own probes separate `rejected` from `unreachable`/
  `unexpected`: "your key is wrong" and "something went wrong" want different
  advice, and a native client polling this reason can tell someone to fix
  their OpenRouter key rather than just retry.

- **`run.ts` dispatches on a table, not a chain of seven branches:
  `PROVIDER_REQUESTS` in `src/lib/ai/run.ts` is one `{ url, shape }` row per
  provider, keyed by `AiProviderKey` so an eighth provider is a compile error**
  — the same shape `AI_COLUMNS` (`src/lib/ai/columns.ts`) and
  `src/lib/ai/probes.ts` already have, for the same reason: the registry and
  the runtime path cannot disagree about a provider if neither is allowed to
  omit one. Five of the seven `callXxx()` methods it replaced were the same
  twelve lines — read the enabled flag, read the key, warn and return, read the
  model, read the timeout, call `callOpenaiCompatible()` with a base URL —
  differing only in which columns and which constant they named. `url` is a
  function for OpenAI alone, whose base URL is the one operator-configurable
  endpoint, and it reads `?.trim() || DEFAULT` to match the probe: `??` alone
  does not catch an _emptied_ `openaiApiUrl`, which would send every request to
  a bare `https://`. Anthropic and Gemini keep request envelopes of their own —
  neither speaks `/chat/completions` — but read their columns and base URL out
  of this same table, so a provider cannot end up with its enabled flag checked
  against one column and its API key read from another's. Four more things
  landed with it, each its own defect:
  - **Which provider is active is decided in one place, `activeProvider()`**,
    which moved from `ai/queries.ts` to `ai/columns.ts` (re-exported from
    `queries.ts`, so `/ai` and `POST /api/v1/ai/prompt` were untouched)
    precisely so `run.ts` could share that decision _without_ importing
    `getSettings()` and dragging `getDb()` into its graph. Before that, `run.ts`
    read the raw `activeAiProvider` column: with `activeAiProvider = "openai"`
    and `openaiEnabled = false` — the state a re-probe classifying the key as
    unauthorized, or a Remove, deliberately leaves behind — `/ai` correctly
    reported no active provider while `applyAiToBlocks()` passed its guard,
    dispatched, hit the provider's own `!enabled` check and reported
    `providerError`: "the provider failed" for a request that was never sent.
  - **The timeout is `AbortSignal.timeout()`, and it now covers the body.** The
    hand-rolled `AbortController` + `setTimeout` pair it replaced skipped
    `clearTimeout` whenever `fetch` threw, leaving an armed timer behind on
    every failed attempt, and cleared it the moment `fetch()` resolved — before
    any of the three shapes reads `response.json()` — so a provider that sent
    headers and then stalled the body hung the job indefinitely. A
    self-expiring signal fixes both halves at once.
  - **`MAX_RETRY_TIME_SECONDS = 60` is a named constant, not a knob.**
    `aiMaxRetryTime` was read from settings in two spellings and had a column
    in neither, so the default was the only value it ever took. It is a fixed
    safety budget on 429 back-off; promoting it to a tuning value would reverse
    the owner's instruction that AI runs without knobs that refuse work (see
    the no-request-cap bullet above).
  - **The seven "not enabled or configured" warnings go through
    `this.warn()`**, so they reach the triggering job's own log instead of only
    the server console — the same reason every failure arm in this file logs.

  Two removals worth knowing about, because both looked load-bearing.
  `AiRuntimeSettings` carried a parallel **snake_case** surface — 29 fields,
  read through 38 `?? this.settings.xxx_yyy` fallbacks — for settings objects
  that never existed: all three production callers pass a Drizzle row. And the
  `catch`'s 429 branch is gone because it was unreachable: a `fetch()` rejection
  is a `TypeError` (undici's `"fetch failed"`) or a `DOMException` from the
  timeout signal, and neither carries a `.status`, which only exists on a
  `Response` — that branch was a literal port of Python `requests`'
  `raise_for_status()` idiom, where a non-2xx response _is_ a raised exception.
  `GEMINI_API_BASE_URL` also moved into `providers.ts` beside the other base
  URLs, so `callGemini()`, the table and `ai/gemini.ts`'s probe read one
  constant rather than each carrying the host string.

- **`plainTextOf()` lives in `src/lib/aggregators/blocks/plain-text.ts`, not in
  `parser.ts`** — and `parser.ts` re-exports it, so the callers that already have
  cheerio in their graph keep one import. It is a pure walk over the block tree
  and touches no HTML, but from inside `parser.ts` its module-level
  `import * as cheerio` reached every importer: `src/lib/ai/run.ts` is one (for
  the plain-text prompt a summarize-only request sends), so
  `POST /api/v1/ai/prompt` was pulling the whole HTML parser into its graph for a
  function that never uses it. Nothing reachable from `run.ts` imports cheerio
  now. A future block-tree helper that needs no HTML belongs beside it rather
  than in `parser.ts`, for the same reason.
- **The AI stage works on the block tree, not HTML: `applyAiToBlocks()` in
  `src/lib/ai/run.ts`, with the codec in `src/lib/ai/block-text.ts`.** The block
  tree is what gets stored — there is no `articles.content` column — so HTML was
  only ever transport, and expensive transport: every tag, every
  `data-sanitized-*` attribute and every URL was billed on the way in and, since
  the prompt demanded the document back verbatim, again on the way out. Measured
  on real pages the block notation is **12–19% the size of the HTML it
  replaces**, in and out.

  **Where it runs is not a free choice.** `parseBlocks()` is a one-way
  HTML → blocks conversion with **no inverse**, so the stage has to sit
  downstream of it — which means the job handlers (`aggregate.ts`,
  `reload.ts`), not `BaseAggregator.finalizeArticles()`. Putting it back in the
  pipeline would mean inventing a blocks → HTML serializer for the handler to
  re-parse, _and_ would move AI above the `contentHash` check again (see that
  bullet for what that broke). Two consequences already banked: the aggregator
  no longer receives the owner's `userSettings` at all — `aggregate()` dropped
  the parameter, since AI was its only consumer, and an aggregator has no
  business holding a user's AI credentials — and both call paths finally run the
  same order (extract, process, parse, then AI).

  **What the model can do:** merge, split and reorder blocks freely. The answer
  is read on its own terms rather than checked against the shape that went out,
  which is what makes "improve clarity and flow" an honest instruction; the HTML
  form forbade restructuring in the prompt ("the exact same structure as the
  input") and had no way to enforce it.

  **What it cannot even see, and therefore cannot break:**
  - **Every URL.** A link is `[label](L3)`, an index into a side table. It cannot
    corrupt an href, add a tracking parameter or translate one — and URLs are a
    large share of the bytes on a link-dense page.
  - **Every non-prose block.** Images, embeds, code blocks and dividers are
    `[[M7]]` placeholders. Movable, never editable, so a `yana-img://` ref, an
    embed provider or a line of code cannot come back altered. Code is not sent
    at all, which is both cheaper and the only correct answer for a translation.
  - An image's **caption** does ride along after its placeholder, because that
    is prose a rewrite should reach. An embed's `title` does not: it is the
    provider's own title for someone else's video.

  **The lead media stays the lead media.** Restructuring is prose freedom, not
  licence to move the article's thumbnail: clients hoist block 0 when it is an
  image (`ArticleBlockView.leadImageRef`), so a relocated or dropped lead image
  silently changes what a timeline shows. If the input led with one, the output
  does too — which also replaced the old `takeLeadHeaderHtml()` detach-and-restore
  dance, needed only because the model used to be able to rewrite media markup.

  **Three properties of the codec are what let the stage trust an answer it did
  not build**, all pinned in `block-text.test.ts`:
  - **`textToBlocks(blocksToText(b))` is `canonicalBlocks(b)`.** That exported
    normal form _is_ the specification, not a tidy-up: the notation is
    line-oriented and cannot carry a newline **inside** a paragraph, and
    `parseBlocks()` does emit those (HTML source line breaks, and its own table
    flattening). Serialized raw, such a run came back as two paragraphs — found
    by running the round trip over live pages, where a 7-block article read back
    as 9. `canonicalBlocks()` collapses whitespace (except inside a `code` run,
    where it is content), merges adjacent identically-styled runs, trims
    paragraph edges, clamps a heading to 1–6 (see `clampHeadingLevel()` below)
    and **drops a block that canonicalizes to nothing**. That last one agrees
    with `textToBlocks()`,
    whose line-oriented parse never records an empty paragraph, an empty
    heading, a quote with nothing left in it or a list with no items — so
    leaving one in destabilised the round trip three different ways (an empty
    heading came back as the literal paragraph `"##"`, having lost the trailing
    space that made the line a heading; a list whose first item was empty came
    back as a stray paragraph _plus_ a shorter list). `isEmptyBlock()` cannot
    reach an image, embed, code block or divider, each of which always carries
    a reference no amount of missing prose can take away, so **no media block
    is ever dropped by this rule**. `blocksToText()` canonicalizes once, up
    front, and `serializeBlocks()` relies on that rather than repeating it,
    which is also what keeps the side table's `opaque` entries and the
    serialized `text` from describing two different versions of the same image.

    **And it is idempotent now, which it was not while this file and that
    module's own doc comment both said it was.** `canonicalRuns()` trimmed
    before dropping empty runs, so an empty run between two identically-styled
    ones kept them apart on the first pass and let them merge on the second:
    329 of 20,000 fuzzed trees changed under a second application. That is not
    cosmetic — `run.ts`'s echo detection (`documentUnchanged`, below) compares
    serialized forms and rests on this being a normal form, so a
    non-idempotent canonicalization is a wrong answer about whether the model
    rewrote anything. The fix is ordering (drop empties, then merge, then
    collapse the merged text) plus a second, subtler cross-run whitespace case
    that the new test found on its own — a **seeded fuzz** (mulberry32, seed
    20260903, 3,000 random trees) asserting round-trip text stability and
    structural equality, which fails when either bug is reintroduced.
    Hand-written cases had already failed to catch it twice.

  - **The parser is total.** An unrecognised sequence stays literal text rather
    than throwing, so a mangled answer degrades to plain prose instead of
    failing the article — and a truncated one cannot produce "unparseable
    markup" at all, which was a real failure arm of the HTML form.
  - **Inline styles are tags (`<b>`, `<i>`, `<s>`, `<code>`), not Markdown
    emphasis.** Two adjacent styled runs serialize to `**bold***italic*` — five
    asterisks no reader can split the same way twice — and prose is full of
    asterisks and tildes that would each need escaping. Tags cannot run together
    ambiguously, carry no attributes, and a model handles them more reliably
    than any notation invented here. Only `\`, `<`, `[` and `]` are escaped.

  **How much is asked for still depends on which options are on
  (`wantsRewrite`).** Only `ai_improve_writing`, `ai_translate` and a custom
  instruction (free-form, so assumed to) rewrite the body. `ai_summarize` alone
  sends **plain text** and asks for `summary` alone — no notation spec, no
  document coming back. The echo it replaced was the single most expensive thing
  this stage did: the model was told to reproduce the whole document, so a
  summarize-only article was billed for roughly as many **output** tokens as
  input ones to hand back a string this process already held. It was also what
  made `aiMaxTokens` (default 2000) a live hazard rather than a cap — a longer
  article came back truncated, the JSON failed to parse, and the whole request
  was spent on an `invalidJson` failure. That setting is gone entirely now (see
  the no-cap bullet above); this is the failure that made removing it the fix
  rather than raising it. A volunteered `title` or `document` is
  ignored on that path, so the missing-summary arm leaves a summarize-only
  article completely untouched while a summarize-plus-rewrite one keeps the
  rewrite.

  **What the model dropped is counted and reported, not swallowed.**
  `textToBlocks()` returns `droppedOpaque`, `duplicatedOpaque` and
  `clearedCaptions`, and the stage logs each to the triggering job's own
  output: silently losing an article's image looks exactly like an article that
  never had one. Three failures made the counting necessary rather than nice,
  and all three came from `OPAQUE_LINE` having required the `[[M<n>]]`
  placeholder to be the whole line while `state.seen` was a Set with no count —
  a `[[M0]]` returned with its caption omitted **deleted the caption**
  silently; `As shown in [[M0]] …` lost the image _and_ stored the literal
  placeholder as prose; and a repeated `[[M0]]` stored one image twice while
  losing another. A placeholder that survives into prose is now stripped rather
  than thrown on, because the parser has to stay total (above), and every case
  is counted.

  **A real media loss withholds the content fingerprint, in both handlers.**
  `AiBlockResult.droppedMedia` is what `handleAggregateJob()` reads to store the
  article and its (possibly degraded) blocks while skipping the `contentHash`
  write, and what `reload.ts` reads to null a stored one. Without it the loss
  was permanent: the stage logged the drop and reported `applied`, so the hash
  was written — and being a fingerprint of the unchanged _source_ it kept
  matching, so the dropped image was gone for the life of that source article.
  The accepted cost is its mirror image, and it is a decision rather than an
  oversight: an article whose model reliably drops the same placeholder is
  re-sent to the provider on every cycle, indefinitely. **The lead media counts
  as neither a drop nor a caption loss**, because `pinLeadMedia()`
  unconditionally throws away whatever came back for that slot and substitutes
  the input's own block verbatim, caption included — nothing the model did to it
  survives into what is stored. One `leadIndex`, computed once, is excluded from
  both reports; counting it would withhold the fingerprint for an article that
  is not missing anything and log a caption loss for a caption that is intact.

  **Superseded by this, and gone:** `stripUnparsedAttributes()`/`PARSED_ATTRS`
  (the attribute strip that made the HTML prompt cheaper — moot once no HTML is
  sent), `takeLeadHeaderHtml()`, `summarySectionHtml()` and the
  `yana-ai-summary` marker class on the _write_ side. `parseBlocks()` still
  recognises that class, because it is how the aggregation path's stored HTML
  used to encode a summary; the stage now builds a `summary` block directly.

- **An AI-processed article's document has a fixed order: the lead media first,
  the summary second, the article after them — both optional, neither allowed
  anywhere else.** `applyAiToBlocks()` (`src/lib/ai/run.ts`) holds it, and each
  half was a real defect before something held it:
  - **The lead media survives.** It used to be an HTML `<header>` that the
    prompt-building code had to _detach and restore_, because the model's answer
    replaced the whole document and a header merely stripped was a header gone —
    which it was: any feed with an AI option on lost its lead image from the
    stored block tree, taking the client's lead image and timeline thumbnail
    with it (`ArticleBlockView.leadImageRef` hoists the first block only when it
    is an image). None of that machinery is needed now: media are opaque
    `[[M<n>]]` placeholders the model cannot edit, so the only remaining rule is
    positional — if the input led with an image or embed, `applyAiToBlocks()`
    puts that same block back at index 0, whether the model moved it or dropped
    it. That also retired the reload-path asymmetry the old mechanism had
    (`reload.ts` ran AI _before_ `processContent()`, which rebuilt the header
    afterwards, so a reloaded article kept its header while an aggregated one
    did not — same content, two orders, two outcomes). Both paths now run
    extract → process → parse → AI.
  - **The summary is its own field and its own block; it does not replace the
    article.** `ai_summarize` once asked for the summary _in_ `content`, which
    both destroyed the body and contradicted the prompt's own closing paragraph
    ("the exact same structure as the input") — the model was told to summarize
    and to preserve, in one request. It is a separate `summary` key now, present
    in the prompt and in Gemini's `responseSchema` **only** when summarization
    was asked for, and the stage builds a `summary` **block** directly rather
    than emitting a `<section data-sanitized-class="yana-ai-summary">` marker for
    `parseBlocks()` to recognise. (The parser still recognises that class — it is
    how stored HTML from before this encoded a summary — so removing it from the
    parser would strand those articles.) A requested summary that does not come
    back is reported rather than swallowed, because a silent no-summary is
    indistinguishable from AI never having run — as
    `{ status: "degraded", reason: "missingSummary" }` when a rewrite was also
    asked for and _did_ come back (the tree is that applied rewrite, so it is
    stored; see the `degraded` paragraph in the `contentHash` bullet), and as
    `{ status: "failed", reason: "missingSummary" }` for a summarize-only
    request, which has nothing else to keep and is returned untouched.
  - **A requested rewrite whose document comes back _unchanged_ is caught
    too, and for a translation that is a failure**
    (`{ status: "failed", reason: "documentUnchanged" }`). The check is
    `blocksToText(answer) === document.text` — byte-identical exactly when the
    answer is the input echoed back, which the notation's round-trip normal form
    is what makes exact. Serialized forms are compared rather than trees on
    purpose: a deep compare would have to know that `canonicalBlocks()` and
    `textToBlocks()` build their objects with different key order, and would
    miss an echo whose whitespace differed. An echo parses perfectly, so nothing
    downstream could tell — it was stored over the article with the title
    stored translated and the job green, which is the second half of the
    "reload only translates the title" report. For `ai_improve_writing` or a
    custom instruction it is a **log note, not a failure**: "this reads fine as
    it is" is a legitimate answer to those. For `ai_translate` it cannot be —
    a document identical to the one sent is by definition not translated — and
    the one false positive (a feed whose source is _already_ in the target
    language) is named in the message, because the fix there is to turn
    translation off for that feed rather than to make this quieter.
  - **A requested rewrite whose `document` did not come back is
    `{ status: "failed", reason: "missingDocument" }`, and the answer's `title`
    is _not_ applied on its own.** This arm used to fall through: the title was
    taken, the source blocks were stored beside it, and the outcome said
    `applied` — a translated title over an untranslated body, written silently
    on a green job with nothing in its log. It is what a user saw as "reloading
    a Reddit post only translates the title", and the reload path's own
    contribution to that is the bullet below; this half is why it could not be
    noticed. A title and a body are one answer to one rewrite request, so half
    of it is not partial success: the article stays wholly as the source has it,
    the job reports the failure, and `handleAggregateJob()` stores no
    `contentHash`, so the next cycle tries again. **Deliberately not symmetrical
    with `missingSummary`**, which keeps the rewrite it got: a summary is an
    addition an article reads fine without, where a rewritten title over an
    untouched body is a visibly broken article. Four cases collapse into this
    one arm — absent, not a string, empty, and notation that reads as no blocks
    at all — because none of them is a document.

  **The applied path logs one line per article, and its absence is what made
  this bug a guessing game.** Every failure arm in `applyAiToBlocks()` logs;
  success logged nothing at all — so a reload whose job log read
  `reloaded article content` and nothing else was indistinguishable between
  "this feed never asked for AI", "the provider was never called" and "the model
  answered and its answer changed nothing". The line names what was asked for
  and what changed
  (`AI (translate) applied to 'X': document 12 -> 11 blocks, title rewritten`),
  which is the one question a job log has to be able to answer about this stage.
  It goes to `onLog` only, not `console` — a success is not a warning, and the
  operator reads it on `/jobs/<id>`.

  **The translate instruction is spelled out to the point of redundancy, and
  every clause of it is load-bearing.** The short version — "Translate the
  title and document to X" — produced answers that translated the title and
  handed the document back untouched, on articles whose title and body were both
  in the source language, which is the defect a user reported for Reddit
  reloads. Two things make that answer easy for a model to reach: the notation
  spec above it is seven lines of "reproduce this exactly" (and read "Return the
  same notation, nothing else" until this branch reworded it to "Answer in the
  same notation"), and a Reddit article's document is long and mostly quoted
  comments — the shape a model shortcuts on. So the instruction now names the
  parts that get skipped (headings, list items, **quoted lines**, image
  captions — a quoted line reads as a citation to leave alone), says the whole
  document must come back in the target language, and says outright that
  returning it in the original language is not an acceptable answer.
  `run.test.ts` asserts those phrases against the real request body, because a
  prompt is only a prompt: the `documentUnchanged` arm above is what happens
  when a model ignores it anyway.

  **The AI stage is never handed its own previous output as input, and the
  reload path is where that had to be enforced.** `articles.name` is not source
  text on a feed with an AI option on — it is the model's answer — so
  `reload.ts`, which re-derives everything else from source, used to hand it
  back as "the article's title". Two consequences, the second reported from a
  running instance: a repeated reload asked for a rewrite of a rewrite (a title
  drifting further on every reload), and a **translate** request arrived
  self-contradictory — `{"title": "<already German>", "document": "<English>"}`
  under "translate this to German" — which a model can read as "already
  translated" and answer with the document echoed back unchanged. An unchanged
  document still parses, so before the `missingDocument` arm above existed the
  article was stored with a translated title over an untranslated body, on a job
  that reported success. The seam is **`noteSourceTitle()`/`sourceTitle` on
  `BaseAggregator`** (`src/lib/aggregators/base.ts`): an aggregator that sees
  the source's own title while refetching says so, and `reload.ts` prefers it
  over the stored name — for the AI request _and_ for the `name` it writes, so a
  reload with AI off now also picks up a title the source has changed, the same
  thing an aggregation run does with every content change. Three report it from
  data they already hold: Reddit (the post's title, off `effectivePostData`, so
  a crosspost reports the original's — exactly what `parseToRawArticles()`
  stores), YouTube (the video's title) and plain RSS (the entry's,
  `unescapeEntities()`'d the same way `parseToRawArticles()` does it). The
  `FullWebsiteAggregator` family reports it through **`sourceTitleFrom($)`, a
  `protected` hook on that class** (`src/lib/aggregators/website.ts`, default
  `null`), called once from its own `fetchArticleContent()` on the page it has
  just fetched — free, since the parse is thrown away and the page is parsed
  again downstream regardless.

  **Only four of fifteen aggregators noted a title at first, and the cause was
  one line rather than eleven decisions.**
  `FullWebsiteAggregator.fetchArticleContent()` overrode `RssAggregator`'s
  **without calling it**, so the noting was silently dropped for every site
  built on that class — which is most of them. Selectors are supplied for
  heise, merkur, tagesschau, caschys_blog, mein_mmo and mactechnews;
  ars_technica and the_verge read `og:title` off the already-fetched page,
  because they are `RssSummaryFallbackAggregator`s and never reach
  `RssAggregator.fetchArticleContent()` (which refetches the whole _feed_ and
  looks the entry up by link), so "just stop dropping the noting" was not
  available to them and `og:title` costs no extra request. The three comics
  stay `null`: they have no headline distinct from the feed's. **A selector
  miss returns `null` and the stored name stands**, so a wrong selector
  degrades to the old behaviour instead of storing a site's branding as the
  article's title — which is the half of the original objection that still
  holds: a page's raw `<title>` is the headline _plus_ the site's branding, so
  there is no generic fallback here, only per-site selectors. The other half,
  concurrency, never applied on the path that matters. It is true that
  `fetchArticleContent()` runs _concurrently, per article_ inside
  `enrichArticles()`, where one instance-level value could only be the last
  writer's — but `sourceTitle` has exactly one consumer, `reload.ts`, whose
  shape is a single article on a single instance, and nothing reads the field
  during an aggregation run at all. That is the same "only meaningful after a
  single `fetchArticleContent()` call" restriction Reddit's `_lastReloaded*`
  stash already carried. `noteSourceTitle()` is additionally **sticky** — an
  empty or whitespace title leaves a previously-noted one in place rather than
  resetting it — because Mein-MMO and MacTechNews fetch several pages inside
  one `fetchArticleContent()` call, and a headline selector that matches on
  page 1 but not on page 2 must not blank out what page 1 found.

  **`aiMaxPromptLength` is gone too, and the asymmetry it used to guard against
  is gone with it.** It used to bound exactly one thing — `POST
/api/v1/ai/prompt`, refusing an over-long prompt from the native client —
  while the article path had always sent whole articles with no length bound
  at all, deliberately: a length cap is the same kind of ceiling as the
  removed request caps, refusing work already decided to be worth doing. That
  made the field's name misleading on its own (it bounded a mobile prompt, not
  "articles" in general), and it was dropped in the same wave that took the
  tuning values from six to five (see above) — the column, the `bounds.ts`
  entry and the route's `prompt_too_long` code all went together.
  `POST /api/v1/ai/prompt` now sends the caller's trimmed prompt straight
  through with no length check at all (`route.ts`'s `if (!prompt)` only
  refuses an _empty_ one), so the two paths finally agree: neither bounds
  length, on the same "do not refuse work already decided worth doing"
  reasoning, and nothing should reintroduce a cap on either without revisiting
  that decision.

  **The summary has a block kind of its own; the header does not, and that
  asymmetry is deliberate.** `summary` is the tenth entry in `BLOCK_KINDS` —
  declared in **both** copies of that list (`src/lib/db/schema/enums.ts` and
  `src/lib/aggregators/blocks/types.ts`, pinned equal by `enums.test.ts`,
  because a kind missing from either side is a row the other half cannot read)
  — and it wraps blocks the way `blockquote` does rather than carrying runs the
  way `paragraph` does: a model answering in two paragraphs then produces two,
  _inside_ the one summary block, instead of silently pushing the article down
  the document. The parser keys on the class (`classNames()` reads
  `data-sanitized-class` and `class`, which is what makes it work on both call
  paths) and `convert()` discards the wrapper's attributes as usual, so the kind
  is the only thing that survives into the tree — which is the point: a client
  can style, collapse or skip the summary without counting blocks. The **header**
  is still positional, because it has no kind: it reaches a client as an ordinary
  `image` or `embed` block that happens to be first, exactly as a lead image
  always has. So block 0 is the lead media, block 1 the summary — each shifting
  up when the one before it is absent — and `run.test.ts`'s "the summary" and
  "the lead media" blocks pin the finished document position by position. There
  is no second pass through `parseBlocks()` to pin any more: the stage is handed
  a tree and returns a tree, so the parser is upstream of it rather than on
  both sides.

  **The 1–6 heading bound is computed in one place as well:
  `clampHeadingLevel()` in `src/lib/aggregators/blocks/types.ts`**, the
  plain-data module every consumer of the block format already imports. Four
  paths reach it and each needs it for its own reason — the codec
  (`ai/block-text.ts`, because `"#".repeat(level)` is the only range the
  notation can write), the storage **write** path, the storage **read** path,
  and the wire decode (`blocks/schema.ts`'s `clampLevel`, which keeps its own
  unknown/NaN coercion and delegates only the bound). The read path is the
  addition worth naming: `article_blocks.level` carries only a `level >= 0`
  CHECK, so a row written before any of this can legitimately hold a 7, and a
  clamp applied on the way in alone would not catch it. The other thing four
  hand-written copies of `Math.min(6, Math.max(1, …))` cost was a missing
  fifth: `serializeBlocks()` relies on `canonicalBlocks()` having applied the
  bound rather than repeating it, which is what let a `level: 7` heading
  round-trip to 6 while `canonicalBlocks()` alone left it at 7 — a round trip
  that therefore was not a normal form.

  **Adding the kind was additive on the wire and `FORMAT_VERSION` stays 1.**
  The format's own extensibility rule is that an unknown block type is skipped,
  never fatal, so a client that predates this renders one block less; bumping
  the version instead would make every existing client reject the whole document
  (`UnsupportedFormatVersion`). Worth knowing what "skipped" costs in practice:
  yana-ios's `BlockWireDecoding` maps an unknown type to an **empty paragraph**,
  so until that client learns the kind, an AI summary is invisible there rather
  than shown as prose — the price of the dedicated element, paid once.

  **The two call paths used to nest differently; they no longer do.** When AI
  worked on HTML, aggregation produced three siblings (the header already existed
  when AI ran) while reload's `processContent()` ran _afterwards_ and wrapped the
  AI's output — summary included — inside `article-content` with the header
  outside it. Same block tree, two nestings, which is why a consumer had to read
  position and never nesting. Both paths now run extract → process → parse → AI,
  so the AI stage is handed one already-parsed tree in both, and the positional
  rule holds because `applyAiToBlocks()` enforces it rather than because the two
  shapes happened to agree.

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
  (`invalid_prompt`, `no_active_provider`,
  `provider_unauthorized`, `provider_error` — the two `*_limit_exceeded` codes
  went with the request caps, so this route can no longer answer 429 at all) for the native client to branch on — never provider prose,
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

  **Job progress rides the same bus, and now on every change, not only at the
  end.** `queue.progress(id, percent)` (`src/lib/jobs/queue.ts`) used to be
  silent until a job's terminal transition; it now calls `publishUserEvent`
  with a `"job"` event on every call that actually moves the stored
  percentage. What keeps that from flooding the bus is not a separate
  throttle -- it is the existing write-dedupe, which was already reading the
  row before writing it (so a redundant write of the same clamped percentage
  is a no-op) purely to avoid a pointless `BEGIN IMMEDIATE` on every one of the
  aggregate handler's per-article calls. That same read-before-write check now
  gates the publish too: the handler's `80 + floor(i/total*20)` shape only
  takes twenty distinct values across a 200-article loop, so a job that calls
  `progress()` two hundred times only ever publishes about twenty events, one
  per percentage it actually reaches, not one per call. **This dedupe is
  load-bearing, not incidental** -- if a future change makes it publish
  unconditionally on every call (e.g. to "simplify" by dropping the read), a
  200-article aggregate job would broadcast two hundred SSE events per
  subscriber instead of twenty, on every run, for every connected device.
  `GET /api/v1/runs/:id` and the `run` SSE event carry the same idea for a
  whole run: both now return a server-computed `progress` percentage
  (`runProgressPercent(totalJobs, completedJobs, failedJobs)`), so a run is
  a percentage rather than just a `totalJobs`/`completedJobs` pair every
  client would otherwise have to turn into one itself, and disagree about
  how.

- **`syncArticles` selects a named column list, never `db.select()`.**
  `plainText` is the largest column on the table and does not appear in
  `ArticleSummaryWire`, so a bare select reads it off disk for every row in
  **both** streams and hands it to the serializer to throw away. (It used to
  read a whole fetched HTML page per row too, from `rawContent` — that column is
  gone.) `SUMMARY_COLUMNS` in `src/lib/api/sync.ts` is that
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
  covers the async data regions that live inside a page's `<Suspense>`
  boundaries (`UsersBody`/`UsersPagination` in `src/app/(app)/users/page.tsx`
  and their equivalents on the other list routes), which stay untested here;
  what they return is covered against a real database in the matching
  `src/lib/**/*.test.ts`, and what the table does with it in the component's own
  `.test.tsx`. Don't reshape production code to make them testable. **Page
  bodies are no longer in this category**: since the instant-render migration
  they are ordinary synchronous functions, so `page.test.tsx` renders one
  directly — and the first assertion in several of them is that the return value
  is _not_ a promise, which is the invariant that keeps a route fallback from
  becoming reachable again. The older exception still stands for an async
  component whose _output_ is synchronous: `src/app/(app)/layout.tsx` is awaited
  as a plain function and its result handed to `renderWithProviders()` (see
  `layout.test.tsx`). None of this is a licence to split a data component in two
  so it fits.

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
`active_ai_provider` preference and the then-nine global tuning values, now
five — see the no-request-cap bullet above), phases 8–10
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
the first real enforcement of the daily/monthly AI request limits (**since
removed in full** — that plan's `ai_requests` table, its
`checkAndRecordAiUsage()` gate and both settings are gone; see the
no-request-cap bullet above, and read that plan's limit sections as history),
and the new `POST /api/v1/ai/prompt` mobile endpoint — see the `/ai` bullets
above for what changed and why. **OpenRouter was added on a later, separate branch**, taking
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
signed-out visit. **The route has no default `next` of its own** — a
missing, unsafe or refused `next` resolves to `safeNextPath()`'s own default,
`/`, the dashboard. It used to override that with `/feeds`, which also
rewrote an explicit `next=/` (the two are indistinguishable once the guard
has resolved them), so `ManagementWebView` landed on the feed list even
though it asks for the site root. **This route is public in `src/proxy.ts`'s
`PUBLIC_PREFIXES`** — see the proxy bullet above for why: the whole point
is that the caller has no session cookie yet, so gating it behind one is a
contradiction, not an oversight. **Its `Location` header is a _relative_
reference (`/`, `/login?next=…`), never an absolute URL, and that is
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
